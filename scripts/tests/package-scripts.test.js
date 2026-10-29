/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
function readPackageJson() {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function readWorkflow(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

const releaseStepScript = readWorkflow('.github/scripts/run-release-step.sh');

describe('package scripts', () => {
  it('keeps documented CI variable defaults in sync with workflows', () => {
    const guide = readWorkflow('docs/developers/development/ci-variables.md');
    const docRows = new Map(
      [
        ...guide.matchAll(
          /^\|\s*`(QWEN_\w+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+)\s*\|/gm,
        ),
      ].map(([, name, value, usedIn]) => [
        name,
        {
          defaultVal: value,
          files: [...usedIn.matchAll(/`([^`]+\.yml)`/g)].map(([, f]) => f),
        },
      ]),
    );

    // These variables are documented below the test-execution table.
    const excludedNonTestVariables = new Set([
      'QWEN_RELEASE_STATIC_TIMEOUT_MINUTES',
      'QWEN_RELEASE_BUILD_TIMEOUT_MINUTES',
    ]);
    const relatedRows = new Map(
      [...guide.matchAll(/`(QWEN_RELEASE_\w+)` \(default `([^`]+)`/g)].map(
        ([, name, value]) => [name, value],
      ),
    );

    const workflowFiles = ['ci.yml', 'release.yml'];
    const workflowVars = new Map();

    for (const file of workflowFiles) {
      const workflow = readWorkflow(`.github/workflows/${file}`);
      for (const [, name] of workflow.matchAll(/vars\.(QWEN_\w+)/g)) {
        if (!workflowVars.has(name)) {
          workflowVars.set(name, { fallbacks: new Set(), files: new Set() });
        }
        const entry = workflowVars.get(name);
        entry.files.add(file);
      }
      for (const [, name, fallback] of workflow.matchAll(
        /vars\.(QWEN_\w+)\s*\|\|\s*'([^']+)'/g,
      )) {
        workflowVars.get(name).fallbacks.add(fallback);
      }
    }

    // Every workflow variable must have a known fallback and a matching doc.
    for (const [name, info] of workflowVars.entries()) {
      expect(info.fallbacks.size, `No fallback found for ${name}`).toBe(1);
      const [fallback] = info.fallbacks;
      if (excludedNonTestVariables.has(name)) {
        expect(info.files, `Unexpected workflow for ${name}`).toEqual(
          new Set(['release.yml']),
        );
        expect(relatedRows.get(name), `Related variable ${name} drifted`).toBe(
          fallback,
        );
        expect(docRows.has(name), `${name} is outside the test table`).toBe(
          false,
        );
        continue;
      }
      const docEntry = docRows.get(name);
      expect(
        docEntry,
        `Workflow variable ${name} missing from docs`,
      ).toBeDefined();
      expect(docEntry.defaultVal, `Default mismatch for ${name}`).toBe(
        fallback,
      );
      expect(new Set(docEntry.files), `Used-in mismatch for ${name}`).toEqual(
        info.files,
      );
    }

    // A deleted workflow variable must not linger in the documentation.
    for (const [name, docEntry] of docRows.entries()) {
      expect(
        workflowVars.has(name),
        `Documented variable ${name} not found in test workflows`,
      ).toBe(true);
      expect(
        docEntry.files.length,
        `No workflow listed for ${name}`,
      ).toBeGreaterThan(0);
    }
    for (const name of excludedNonTestVariables) {
      expect(workflowVars.has(name), `Missing related variable ${name}`).toBe(
        true,
      );
    }
  });

  it('lets the CI unit lane retry a contended attempt', () => {
    // Identical work measures 6.7min or 36min on this fleet depending only on
    // which host the job lands on, and the same commit run three times failed
    // three disjoint test sets (#10490). A retry lets that pass; a real break
    // still fails every attempt. The release lane already runs this way.
    const packageJson = readPackageJson();
    // `test:ci` ends in `&&`, so args appended to it would reach only
    // `test:scripts`. The workspaces half is its own script, ending in `--`,
    // so a flag appended to it reaches every workspace's vitest.
    expect(packageJson.scripts['test:ci:workspaces']).toMatch(/--$/);
    expect(packageJson.scripts['test:ci:workspaces']).toContain(
      'npm run test:ci --workspaces --if-present',
    );
    expect(packageJson.scripts['test:ci']).toBe(
      'npm run test:ci:workspaces && npm run test:scripts',
    );

    const step = getWorkflowStep(
      getWorkflowJob(readWorkflow('.github/workflows/ci.yml'), 'test'),
      'Run tests and generate reports',
    );
    expect(step).toContain(
      'VITEST_RETRY: "${{ vars.QWEN_CI_VITEST_RETRY || \'2\' }}"',
    );
    // 'off' must omit the flag rather than pass --retry=0, which would
    // outrank a workspace's own config-level retry (sdk-typescript).
    expect(step).toContain('[ "${VITEST_RETRY}" != \'off\' ]');
    expect(step).toContain('retry_arg=(--retry="${VITEST_RETRY}")');
    expect(step).toContain('npm run test:ci:workspaces -- "${retry_arg[@]}"');
    expect(step).toContain('npm run test:scripts -- "${retry_arg[@]}"');
  });

  it('bounds the CI unit step so a hang fails instead of stalling', () => {
    // #10490's run 3 was cancelled at ~60 minutes, leaving behind
    // orphaned test processes; a stall reads as a timeout, not a failure.
    const step = getWorkflowStep(
      getWorkflowJob(readWorkflow('.github/workflows/ci.yml'), 'test'),
      'Run tests and generate reports',
    );
    expect(step).toContain('timeout-minutes: 110');
  });

  it('skips build/bundle/husky but still generates git-commit info when CI builds explicitly', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts.prepare).toBe('node scripts/prepare.js');

    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-skip-'));
    const logFile = path.join(binDir, 'commands.log');
    writeFileSync(logFile, '');

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(binDir, 'husky.cmd'),
          '@echo(husky>>"%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          '@echo(npm %*>>"%PREPARE_LOG_FILE%"\r\n',
        );
      } else {
        writeFileSync(
          path.join(binDir, 'husky'),
          '#!/bin/sh\necho husky >> "$PREPARE_LOG_FILE"\n',
        );
        writeFileSync(
          path.join(binDir, 'npm'),
          '#!/bin/sh\necho "npm $*" >> "$PREPARE_LOG_FILE"\n',
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '1',
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Skipping prepare');
      // git-commit info is still generated so a later per-workspace build or
      // typecheck (e.g. the review tooling's) doesn't fail on the missing
      // module; the heavy build/bundle/husky are skipped.
      expect(readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
        'npm run generate',
      ]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('runs prepare steps in order when CI does not skip prepare', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-bin-'));
    const logFile = path.join(binDir, 'commands.log');

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(binDir, 'husky.cmd'),
          '@echo(husky>>"%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          '@echo(npm %*>>"%PREPARE_LOG_FILE%"\r\n',
        );
      } else {
        writeFileSync(
          path.join(binDir, 'husky'),
          '#!/bin/sh\necho husky >> "$PREPARE_LOG_FILE"\n',
        );
        writeFileSync(
          path.join(binDir, 'npm'),
          '#!/bin/sh\necho "npm $*" >> "$PREPARE_LOG_FILE"\n',
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '',
          },
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
        'husky',
        'npm run build',
        'npm run bundle',
      ]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('exits when a prepare step fails', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-fail-'));
    const logFile = path.join(binDir, 'commands.log');
    writeFileSync(logFile, '');

    try {
      if (process.platform === 'win32') {
        writeFileSync(path.join(binDir, 'husky.cmd'), '@exit /b 7\r\n');
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          '@echo npm %* >> "%PREPARE_LOG_FILE%"\r\n',
        );
      } else {
        writeFileSync(path.join(binDir, 'husky'), '#!/bin/sh\nexit 7\n');
        writeFileSync(
          path.join(binDir, 'npm'),
          '#!/bin/sh\necho "npm $*" >> "$PREPARE_LOG_FILE"\n',
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '',
          },
        },
      );

      expect(result.status).toBe(7);
      expect(result.stderr).toContain('prepare: husky exited with status 7');
      expect(readFileSync(logFile, 'utf8')).toBe('');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('reports the failing prepare step after earlier steps succeed', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-late-fail-'));
    const logFile = path.join(binDir, 'commands.log');
    writeFileSync(logFile, '');

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(binDir, 'husky.cmd'),
          '@echo(husky>>"%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          [
            '@echo(npm %*>>"%PREPARE_LOG_FILE%"',
            '@if "%1 %2"=="run build" exit /b 7',
            '@exit /b 0',
            '',
          ].join('\r\n'),
        );
      } else {
        writeFileSync(
          path.join(binDir, 'husky'),
          '#!/bin/sh\necho husky >> "$PREPARE_LOG_FILE"\n',
        );
        writeFileSync(
          path.join(binDir, 'npm'),
          [
            '#!/bin/sh',
            'echo "npm $*" >> "$PREPARE_LOG_FILE"',
            'if [ "$1 $2" = "run build" ]; then exit 7; fi',
            '',
          ].join('\n'),
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '',
          },
        },
      );

      expect(result.status).toBe(7);
      expect(result.stderr).toContain(
        'prepare: npm run build exited with status 7',
      );
      expect(readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
        'husky',
        'npm run build',
      ]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'reports when a prepare command is killed by a signal',
    () => {
      const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-signal-'));

      try {
        writeFileSync(path.join(binDir, 'husky'), '#!/bin/sh\nkill -TERM $$\n');
        writeFileSync(path.join(binDir, 'npm'), '#!/bin/sh\nexit 0\n');
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);

        const result = spawnSync(
          process.execPath,
          [path.join(root, 'scripts/prepare.js')],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
              QWEN_SKIP_PREPARE: '',
            },
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'prepare: husky killed by signal SIGTERM',
        );
      } finally {
        rmSync(binDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports when a prepare command cannot be spawned',
    () => {
      const missingBinDir = mkdtempSync(
        path.join(tmpdir(), 'qwen-prepare-missing-bin-'),
      );

      try {
        const result = spawnSync(
          process.execPath,
          [path.join(root, 'scripts/prepare.js')],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: missingBinDir,
              QWEN_SKIP_PREPARE: '',
            },
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('prepare: husky failed:');
      } finally {
        rmSync(missingBinDir, { recursive: true, force: true });
      }
    },
  );

  it('meets npm trusted publishing requirements', () => {
    for (const [workflowPath, jobName, publishStepName] of [
      ['.github/workflows/release.yml', 'publish', 'Publish npm packages'],
    ]) {
      const publishJob = getWorkflowJob(readWorkflow(workflowPath), jobName);
      const installStep = getWorkflowStep(publishJob, 'Install npm 11');
      const publishStep = getWorkflowStep(publishJob, publishStepName);
      const publishImplementation =
        workflowPath === '.github/workflows/release.yml'
          ? releaseStepScript
          : publishStep;
      expect(installStep).toContain('npm install --global npm@11.19.0');
      expect(publishJob).toContain("id-token: 'write'");
      expect(publishImplementation).toContain('--provenance');
      expect(publishJob).toContain("name: 'production-release'");
      expect(publishJob.indexOf(installStep)).toBeLessThan(
        publishJob.indexOf(publishStep),
      );
    }

    for (const packageDirectory of ['packages/cli']) {
      const packageJson = JSON.parse(
        readFileSync(path.join(root, packageDirectory, 'package.json'), 'utf8'),
      );
      expect(packageJson.repository?.url?.replace(/^git\+/, '')).toBe(
        'https://github.com/QwenLM/qwen-code.git',
      );
    }
  });

  it('fast-tracks trusted autofix issue triggers before LLM assessment', () => {
    const workflow = readWorkflow('.github/workflows/qwen-autofix.yml');
    const issueJob = getWorkflowJob(workflow, 'issue-autofix');
    const scanStep = getWorkflowStep(issueJob, 'Find candidate issues');
    const fastTrackStep = getWorkflowStep(issueJob, 'Fast-track decision');
    const assessStep = getWorkflowStep(issueJob, 'Assess candidates');

    expect(issueJob.indexOf(scanStep)).toBeLessThan(
      issueJob.indexOf(fastTrackStep),
    );
    expect(issueJob.indexOf(fastTrackStep)).toBeLessThan(
      issueJob.indexOf(assessStep),
    );
    expect(fastTrackStep).toContain("id: 'fasttrack'");
    expect(fastTrackStep).toContain('FAST_TRACK=false');
    expect(fastTrackStep).toContain('FAST_TRACK=true');
    expect(fastTrackStep).toContain('fast_tracked=false');
    expect(fastTrackStep).toContain('-n "${FORCED_ISSUE}"');
    expect(fastTrackStep).toContain(
      'Fast-tracked: trusted trigger bypasses LLM assessment.',
    );
    expect(assessStep).toContain(
      "steps.fasttrack.outputs.fast_tracked != 'true'",
    );
  });

  it('runs changed autofix tests instead of full touched-package suites', () => {
    const workflow = readWorkflow('.github/workflows/qwen-autofix.yml');
    const reviewVerificationRunner = readWorkflow(
      '.github/scripts/run-autofix-review-verification.sh',
    );
    const reviewJob = getWorkflowJob(workflow, 'review-address');

    for (const verificationBody of [
      getWorkflowStep(
        getWorkflowJob(workflow, 'issue-autofix'),
        'Verification gate',
      ),
      reviewVerificationRunner,
    ]) {
      expect(verificationBody).toContain(
        'npm run test --workspace "${p}" --if-present -- --changed origin/main --passWithNoTests',
      );
      expect(verificationBody).toContain(
        'bash "${RUNNER_TEMP}/resolve-owning-packages.sh"',
      );
      expect(verificationBody).toContain('pkg.scripts?.test');
      expect(verificationBody).toContain('!= *vitest*');
      expect(verificationBody).not.toContain(
        'npm run test --workspace "${p}" --if-present\n',
      );
    }

    expect(getWorkflowStep(reviewJob, 'Verification gate')).toContain(
      'bash --norc "${RUNNER_TEMP}/run-autofix-review-verification.sh"',
    );
  });
});
