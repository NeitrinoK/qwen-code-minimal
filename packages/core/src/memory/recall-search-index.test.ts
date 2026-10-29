/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRelevantAutoMemoryPromptForQuery } from './recall.js';
import { MemoryManager } from './manager.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { getAutoMemoryFilePath, clearAutoMemoryRootCache } from './paths.js';
import { Storage } from '../config/storage.js';
import type { Config } from '../config/config.js';

function makeMockConfig(
  manager: MemoryManager,
  overrides: Partial<ReturnType<Config['getMemorySearchIndexSettings']>> = {},
): Config {
  return {
    getMemoryManager: () => manager,
    // Project memory is only scanned for a trusted workspace.
    isTrustedFolder: () => true,
    getMemorySearchIndexSettings: () => ({
      enabled: true,
      includeTranscripts: false,
      maxTranscriptSessions: 50,
      maxTranscriptAgeDays: 90,
      ...overrides,
    }),
  } as unknown as Config;
}

async function writeMemoryDoc(
  projectRoot: string,
  relativePath: string,
  opts: { type?: string; name: string; description: string; body: string },
): Promise<void> {
  const content = [
    '---',
    `type: ${opts.type ?? 'reference'}`,
    `name: ${opts.name}`,
    `description: ${opts.description}`,
    '---',
    '',
    opts.body,
    '',
  ].join('\n');
  await fs.writeFile(getAutoMemoryFilePath(projectRoot, relativePath), content);
}

describe('recall uses the search index', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
    clearAutoMemoryRootCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-search-index-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
    Storage.setRuntimeBaseDir(path.join(tempDir, 'runtime'));
  });

  afterEach(async () => {
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    clearAutoMemoryRootCache();
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('selects a memory doc whose match term is only in the body (index path)', async () => {
    // Description-only heuristic/model selectors would miss this — the
    // match term "gribblesnort" appears only in the body, never in the
    // title/description that the non-indexed path scores against.
    await writeMemoryDoc(projectRoot, 'reference.md', {
      name: 'Reference notes',
      description: 'Some unrelated dashboards',
      body: 'The gribblesnort workaround for the flaky build is documented here.',
    });

    const mgr = new MemoryManager();
    const config = makeMockConfig(mgr);

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'gribblesnort',
      { config },
    );

    expect(result.selectedDocs.map((d) => d.filePath)).toContain(
      getAutoMemoryFilePath(projectRoot, 'reference.md'),
    );
    expect(result.prompt).toContain('## Relevant memory');
    expect(result.prompt).toContain('Reference notes');
  });

  it('matches the disabled-index (scan-path) output byte-for-byte', async () => {
    await writeMemoryDoc(projectRoot, 'reference.md', {
      name: 'Dashboard reference',
      description: 'Latency dashboard links',
      body: 'Grafana dashboard for API latency lives here.',
    });

    const mgr = new MemoryManager();
    const enabledConfig = makeMockConfig(mgr);
    const disabledConfig = makeMockConfig(mgr, { enabled: false });

    const withIndex = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'dashboard latency',
      { config: enabledConfig },
    );
    const withoutIndex = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'dashboard latency',
      { config: disabledConfig },
    );

    expect(mgr.getSearchIndex(projectRoot)).toBeNull();
    expect(withoutIndex.prompt).not.toContain('## Relevant past conversation');
    expect(withIndex.prompt).toBe(withoutIndex.prompt);
  });

  it('produces the same "## Relevant memory" block as a run without the index settings', async () => {
    await writeMemoryDoc(projectRoot, 'reference.md', {
      name: 'Dashboard reference',
      description: 'Latency dashboard links',
      body: 'Grafana dashboard for API latency lives here.',
    });

    // Project memory is only recalled for a trusted workspace, and a bare
    // `{}` options object is untrusted, so the baseline carries trust too.
    const noConfigResult = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'dashboard latency',
      { config: { isTrustedFolder: () => true } as unknown as Config },
    );

    const mgr = new MemoryManager();
    const disabledConfig = makeMockConfig(mgr, { enabled: false });
    const disabledResult = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'dashboard latency',
      { config: disabledConfig },
    );

    expect(disabledResult.prompt).toBe(noConfigResult.prompt);
  });

  it('falls back without throwing when ensureSearchIndexReady throws', async () => {
    await writeMemoryDoc(projectRoot, 'reference.md', {
      name: 'Dashboard reference',
      description: 'Latency dashboard links',
      body: 'Grafana dashboard for API latency lives here.',
    });

    const mgr = new MemoryManager();
    mgr.ensureSearchIndexReady = async () => {
      throw new Error('boom');
    };
    const config = makeMockConfig(mgr);

    await expect(
      resolveRelevantAutoMemoryPromptForQuery(
        projectRoot,
        'dashboard latency',
        {
          config,
        },
      ),
    ).resolves.not.toThrow();

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'dashboard latency',
      { config },
    );
    expect(result.prompt).toContain('## Relevant memory');
    expect(result.prompt).not.toContain('## Relevant past conversation');
  });

  it('renders a "## Relevant past conversation" block for a transcript hit', async () => {
    const mgr = new MemoryManager();
    const config = makeMockConfig(mgr, { includeTranscripts: true });

    // Build a real (empty) index first, then hand-inject a transcript doc
    // that has no backing session file on disk. Swap ensureSearchIndexReady
    // to a no-op afterwards — recall calls it internally on every recall,
    // and a real reconcile would treat our hand-injected doc as stale (no
    // matching file under the transcript dir) and remove it before search
    // runs. The no-op keeps the test focused on recall's rendering, not on
    // transcript-source scanning (covered elsewhere).
    await mgr.ensureSearchIndexReady(projectRoot, config);
    const index = mgr.getSearchIndex(projectRoot);
    expect(index).not.toBeNull();
    index!.addOrReplace([
      {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890#1',
        source: 'transcript',
        sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        ts: Date.now() - 2 * 24 * 60 * 60 * 1000,
        text: 'We discussed the gribblesnort workaround for the flaky build in depth.',
      },
    ]);
    mgr.ensureSearchIndexReady = async () => {};

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'gribblesnort workaround',
      { config },
    );

    expect(result.prompt).toContain('## Relevant past conversation');
    expect(result.prompt).toContain('session a1b2c3d4');
    expect(result.prompt).toContain('gribblesnort workaround');
    // "## Relevant past conversation" must come after "## Relevant memory"
    // when both are present.
    const memoryIdx = result.prompt.indexOf('## Relevant memory');
    const transcriptIdx = result.prompt.indexOf(
      '## Relevant past conversation',
    );
    if (memoryIdx !== -1) {
      expect(transcriptIdx).toBeGreaterThan(memoryIdx);
    }
  });

  it('omits the transcript block when includeTranscripts is false', async () => {
    const mgr = new MemoryManager();
    const config = makeMockConfig(mgr, { includeTranscripts: false });

    await mgr.ensureSearchIndexReady(projectRoot, config);
    const index = mgr.getSearchIndex(projectRoot);
    expect(index).not.toBeNull();
    index!.addOrReplace([
      {
        id: 'session-abcdef12#1',
        source: 'transcript',
        sessionId: 'session-abcdef12',
        ts: Date.now(),
        text: 'We discussed the gribblesnort workaround.',
      },
    ]);
    mgr.ensureSearchIndexReady = async () => {};

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'gribblesnort workaround',
      { config },
    );

    expect(result.prompt).not.toContain('## Relevant past conversation');
  });
});
