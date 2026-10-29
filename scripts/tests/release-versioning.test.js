/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import semver from 'semver';
import { getWorkspacePackageJsonPaths } from '../workspaces.js';

// Put a manifest into a layout an npm/pnpm re-serialization would change:
// dependency entries reversed plus an empty block. version.js must rewrite
// only the top-level version, so this layout has to survive byte-for-byte.
function perturbManifestLayout(text) {
  const manifest = JSON.parse(text);
  manifest.dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).reverse(),
  );
  manifest.optionalDependencies = {};
  return JSON.stringify(manifest, null, 2) + '\n';
}

it.each(['patch', '99.0.0-preview.1'])(
  'aligns every workspace and the npm lockfile to one version (%s)',
  (version) => {
    const root = process.cwd();
    const directory = mkdtempSync(join(tmpdir(), 'release-versioning-'));
    const read = (path) =>
      JSON.parse(readFileSync(join(directory, path), 'utf8'));
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    const paths = getWorkspacePackageJsonPaths(root, manifest.workspaces);
    try {
      for (const path of [
        'package.json',
        'package-lock.json',
        'scripts/version.js',
        'scripts/workspaces.js',
        ...paths,
      ]) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        copyFileSync(join(root, path), join(directory, path));
      }
      // An internal workspace can lag behind; patch must resolve from the root,
      // not bump each package's existing version independently.
      const internalPath = 'packages/core/package.json';
      writeFileSync(
        join(directory, internalPath),
        JSON.stringify({ ...read(internalPath), version: '0.0.1' }, null, 2) +
          '\n',
      );
      const canary = 'packages/acp-bridge/package.json';
      const layoutBefore = perturbManifestLayout(
        readFileSync(join(directory, canary), 'utf8'),
      );
      writeFileSync(join(directory, canary), layoutBefore);

      const result = spawnSync(
        process.execPath,
        ['scripts/version.js', version],
        { cwd: directory, encoding: 'utf8', timeout: 60_000 },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);

      const expected =
        version === 'patch' ? semver.inc(manifest.version, 'patch') : version;
      expect(read('package.json').version).toBe(expected);
      for (const path of paths) {
        expect(read(path).version, path).toBe(expected);
      }
      const lockfile = read('package-lock.json');
      expect(lockfile.version).toBe(expected);
      expect(lockfile.packages[''].version).toBe(expected);
      for (const path of paths) {
        const entry = lockfile.packages[dirname(path)];
        if (entry) expect(entry.version, path).toBe(expected);
      }
      for (const path of ['package.json', 'packages/cli/package.json']) {
        const uri = read(path).config?.sandboxImageUri;
        if (uri) expect(uri).toBe(`ghcr.io/qwenlm/qwen-code:${expected}`);
      }
      expect(readFileSync(join(directory, canary), 'utf8')).toBe(
        layoutBefore.replace(
          /^ {2}"version": "[^"]*"/m,
          () => `  "version": ${JSON.stringify(expected)}`,
        ),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
