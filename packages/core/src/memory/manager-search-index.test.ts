/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryManager } from './manager.js';
import { MemorySearchIndex } from './search-index.js';
import { ensureAutoMemoryScaffold } from './store.js';
import {
  getAutoMemoryFilePath,
  getAutoMemoryProjectStateDir,
  clearAutoMemoryRootCache,
} from './paths.js';
import { getTranscriptDir } from './dreamAgentPlanner.js';
import { Storage } from '../config/storage.js';
import type { Config } from '../config/config.js';
import type { ChatRecord } from '../services/chatRecordingService.js';

// Mutable control for the project-memory scan so one test can simulate a
// transient non-ENOENT read failure (EACCES/EIO). Defaults to delegating to
// the real implementation so the other tests scan real fixture files.
const scanControl = vi.hoisted(() => ({
  projectScanError: null as Error | null,
}));

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return {
    ...actual,
    scanAutoMemoryTopicDocuments: vi.fn((projectRoot: string) => {
      if (scanControl.projectScanError) {
        return Promise.reject(scanControl.projectScanError);
      }
      return actual.scanAutoMemoryTopicDocuments(projectRoot);
    }),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockConfig(
  overrides: Partial<ReturnType<Config['getMemorySearchIndexSettings']>> = {},
): Config {
  return {
    getMemorySearchIndexSettings: () => ({
      enabled: true,
      includeTranscripts: false,
      maxTranscriptSessions: 50,
      maxTranscriptAgeDays: 90,
      ...overrides,
    }),
  } as unknown as Config;
}

function makeChatRecord(
  overrides: Partial<ChatRecord> & { uuid: string },
): ChatRecord {
  return {
    parentUuid: null,
    sessionId: 'session-a',
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'user',
    cwd: '/tmp/project',
    version: '0.0.0-test',
    ...overrides,
  };
}

async function writeSessionFile(
  projectRoot: string,
  fileName: string,
  records: ChatRecord[],
  mtime: Date,
): Promise<void> {
  const filePath = path.join(getTranscriptDir(projectRoot), fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  await fs.writeFile(filePath, `${lines}\n`, 'utf8');
  await fs.utimes(filePath, mtime, mtime);
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

describe('MemoryManager search index', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    scanControl.projectScanError = null;
    process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
    clearAutoMemoryRootCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-search-index-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
    // Sandbox transcript reads (getTranscriptDir goes through
    // Storage.getRuntimeBaseDir(), independent of QWEN_CODE_MEMORY_LOCAL) so
    // a stray real ~/.qwen dir is never touched even when includeTranscripts
    // defaults to true.
    Storage.setRuntimeBaseDir(path.join(tempDir, 'runtime'));
  });

  afterEach(async () => {
    scanControl.projectScanError = null;
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    clearAutoMemoryRootCache();
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('builds an index from memory files and finds a search term', async () => {
    await writeMemoryDoc(projectRoot, 'reference.md', {
      name: 'klogg build recipe',
      description: 'How klogg was built here',
      body: 'Qt6 native arm64, CA-bundle, patches applied to build.',
    });

    const mgr = new MemoryManager();
    expect(mgr.getSearchIndex(projectRoot)).toBeNull();

    await mgr.ensureSearchIndexReady(projectRoot, makeMockConfig());

    const index = mgr.getSearchIndex(projectRoot);
    expect(index).not.toBeNull();
    const hits = index!.search('klogg', { source: 'memory', limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe('klogg build recipe');
  });

  it('removes a doc from the index after its file is deleted and reconcile runs again', async () => {
    await writeMemoryDoc(projectRoot, 'reference.md', {
      name: 'klogg build recipe',
      description: 'How klogg was built here',
      body: 'Qt6 native arm64, CA-bundle, patches applied to build.',
    });

    const mgr = new MemoryManager();
    await mgr.ensureSearchIndexReady(projectRoot, makeMockConfig());
    expect(
      mgr
        .getSearchIndex(projectRoot)!
        .search('klogg', { source: 'memory', limit: 10 }).length,
    ).toBeGreaterThan(0);

    await fs.rm(getAutoMemoryFilePath(projectRoot, 'reference.md'));
    await mgr.ensureSearchIndexReady(projectRoot, makeMockConfig());

    const hits = mgr
      .getSearchIndex(projectRoot)!
      .search('klogg', { source: 'memory', limit: 10 });
    expect(hits).toEqual([]);
  });

  it('picks up a changed file (mtime bump) on the next reconcile', async () => {
    await writeMemoryDoc(projectRoot, 'reference.md', {
      name: 'klogg build recipe',
      description: 'How klogg was built here',
      body: 'Original body text zorblatt.',
    });

    const mgr = new MemoryManager();
    await mgr.ensureSearchIndexReady(projectRoot, makeMockConfig());
    expect(
      mgr
        .getSearchIndex(projectRoot)!
        .search('zorblatt', { source: 'memory', limit: 10 }).length,
    ).toBe(1);

    // Rewrite with new content and a later mtime so reconcile picks it up.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeMemoryDoc(projectRoot, 'reference.md', {
      name: 'klogg build recipe',
      description: 'How klogg was built here',
      body: 'Rewritten body text gribblesnort.',
    });
    await mgr.ensureSearchIndexReady(projectRoot, makeMockConfig());

    expect(
      mgr
        .getSearchIndex(projectRoot)!
        .search('gribblesnort', { source: 'memory', limit: 10 }).length,
    ).toBe(1);
    expect(
      mgr
        .getSearchIndex(projectRoot)!
        .search('zorblatt', { source: 'memory', limit: 10 }).length,
    ).toBe(0);
  });

  it('leaves getSearchIndex() null when memory.searchIndex.enabled is false', async () => {
    await writeMemoryDoc(projectRoot, 'reference.md', {
      name: 'klogg build recipe',
      description: 'How klogg was built here',
      body: 'Qt6 native arm64, CA-bundle, patches applied to build.',
    });

    const mgr = new MemoryManager();
    await mgr.ensureSearchIndexReady(
      projectRoot,
      makeMockConfig({ enabled: false }),
    );

    expect(mgr.getSearchIndex(projectRoot)).toBeNull();
  });

  it('rebuilds instead of throwing when search-index.json on disk is corrupt', async () => {
    await writeMemoryDoc(projectRoot, 'reference.md', {
      name: 'klogg build recipe',
      description: 'How klogg was built here',
      body: 'Qt6 native arm64, CA-bundle, patches applied to build.',
    });

    const stateDir = getAutoMemoryProjectStateDir(projectRoot);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'search-index.json'),
      'this is not valid json{{{',
    );

    // Fresh manager instance so ensureSearchIndexReady must load (and fail
    // to parse) the on-disk file rather than reuse an in-memory cache.
    const mgr = new MemoryManager();
    await expect(
      mgr.ensureSearchIndexReady(projectRoot, makeMockConfig()),
    ).resolves.not.toThrow();

    const index = mgr.getSearchIndex(projectRoot);
    expect(index).not.toBeNull();
    const hits = index!.search('klogg', { source: 'memory', limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('returns null when no config is passed and reconcile has never succeeded', () => {
    const mgr = new MemoryManager();
    expect(mgr.getSearchIndex(projectRoot)).toBeNull();
  });

  it('does NOT wipe the persisted index when a memory scan fails transiently', async () => {
    await writeMemoryDoc(projectRoot, 'reference.md', {
      name: 'klogg build recipe',
      description: 'How klogg was built here',
      body: 'Qt6 native arm64, CA-bundle, patches applied to build.',
    });

    // First reconcile succeeds and persists a real index to disk.
    const mgr = new MemoryManager();
    await mgr.ensureSearchIndexReady(projectRoot, makeMockConfig());
    expect(
      mgr
        .getSearchIndex(projectRoot)!
        .search('klogg', { source: 'memory', limit: 10 }).length,
    ).toBeGreaterThan(0);

    const indexJsonPath = path.join(
      getAutoMemoryProjectStateDir(projectRoot),
      'search-index.json',
    );
    const persistedBefore = await fs.readFile(indexJsonPath, 'utf-8');

    // A transient non-ENOENT read failure (EACCES/EIO) on the next reconcile
    // must abort BEFORE any stale-id removal or persist — otherwise the scan
    // would coerce to [] and wipe every indexed doc from disk.
    scanControl.projectScanError = Object.assign(
      new Error('EACCES: permission denied, scandir'),
      { code: 'EACCES' },
    );
    await expect(
      mgr.ensureSearchIndexReady(projectRoot, makeMockConfig()),
    ).resolves.not.toThrow();

    // The whole-body guard degrades the live index to null on failure so
    // recall falls back — that part is by design.
    expect(mgr.getSearchIndex(projectRoot)).toBeNull();

    // The load-bearing assertion: search-index.json on disk was NOT
    // overwritten with an emptied index.
    const persistedAfter = await fs.readFile(indexJsonPath, 'utf-8');
    expect(persistedAfter).toBe(persistedBefore);
    const restored = MemorySearchIndex.fromJSON(persistedAfter);
    expect(restored).not.toBeNull();
    expect(
      restored!.search('klogg', { source: 'memory', limit: 10 }).length,
    ).toBeGreaterThan(0);

    // And once the transient error clears, a fresh reconcile rebuilds from
    // the intact on-disk index and finds the doc again.
    scanControl.projectScanError = null;
    await mgr.ensureSearchIndexReady(projectRoot, makeMockConfig());
    expect(
      mgr
        .getSearchIndex(projectRoot)!
        .search('klogg', { source: 'memory', limit: 10 }).length,
    ).toBeGreaterThan(0);
  });
});

describe('MemoryManager transcript reconcile (incremental)', () => {
  let tempDir: string;
  let projectRoot: string;
  let readSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    scanControl.projectScanError = null;
    process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
    clearAutoMemoryRootCache();
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'mgr-search-index-transcript-'),
    );
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
    Storage.setRuntimeBaseDir(path.join(tempDir, 'runtime'));
    // Spy on the shared per-file JSONL reader — the expensive step a
    // reconcile with no transcript changes must NOT perform.
    const jsonlUtils = await import('../utils/jsonl-utils.js');
    readSpy = vi.spyOn(jsonlUtils, 'read');
  });

  afterEach(async () => {
    readSpy.mockRestore();
    scanControl.projectScanError = null;
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    clearAutoMemoryRootCache();
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reconciling again with no transcript changes reads zero session files and leaves transcript docs unchanged', async () => {
    await writeSessionFile(
      projectRoot,
      'session-a.jsonl',
      [
        makeChatRecord({
          uuid: 'u1',
          sessionId: 'session-a',
          type: 'user',
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          message: { role: 'user', parts: [{ text: 'hello there zorblatt' }] },
        }),
      ],
      new Date(Date.now() - 60_000),
    );

    const mgr = new MemoryManager();
    await mgr.ensureSearchIndexReady(
      projectRoot,
      makeMockConfig({ includeTranscripts: true }),
    );
    const firstHits = mgr
      .getSearchIndex(projectRoot)!
      .search('zorblatt', { source: 'transcript', limit: 10 });
    expect(firstHits.length).toBe(1);
    expect(readSpy).toHaveBeenCalledTimes(1);

    readSpy.mockClear();

    await mgr.ensureSearchIndexReady(
      projectRoot,
      makeMockConfig({ includeTranscripts: true }),
    );

    // No transcript file changed since the first reconcile — zero reads.
    expect(readSpy).not.toHaveBeenCalled();

    const secondHits = mgr
      .getSearchIndex(projectRoot)!
      .search('zorblatt', { source: 'transcript', limit: 10 });
    expect(secondHits).toEqual(firstHits);
  });

  it('removes indexed transcript docs whose session file was deleted', async () => {
    await writeSessionFile(
      projectRoot,
      'session-a.jsonl',
      [
        makeChatRecord({
          uuid: 'u1',
          sessionId: 'session-a',
          type: 'user',
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          message: { role: 'user', parts: [{ text: 'hello there zorblatt' }] },
        }),
      ],
      new Date(Date.now() - 60_000),
    );

    const mgr = new MemoryManager();
    await mgr.ensureSearchIndexReady(
      projectRoot,
      makeMockConfig({ includeTranscripts: true }),
    );
    expect(
      mgr
        .getSearchIndex(projectRoot)!
        .search('zorblatt', { source: 'transcript', limit: 10 }).length,
    ).toBe(1);

    await fs.rm(path.join(getTranscriptDir(projectRoot), 'session-a.jsonl'));

    await mgr.ensureSearchIndexReady(
      projectRoot,
      makeMockConfig({ includeTranscripts: true }),
    );

    expect(
      mgr
        .getSearchIndex(projectRoot)!
        .search('zorblatt', { source: 'transcript', limit: 10 }).length,
    ).toBe(0);
  });

  it('prunes a deleted session across a fresh MemoryManager (empty in-memory known map)', async () => {
    // Two sessions indexed + persisted by "process 1".
    await writeSessionFile(
      projectRoot,
      'session-a.jsonl',
      [
        makeChatRecord({
          uuid: 'u1',
          sessionId: 'session-a',
          type: 'user',
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          message: { role: 'user', parts: [{ text: 'alpha zorblatt' }] },
        }),
      ],
      new Date(Date.now() - 60_000),
    );
    await writeSessionFile(
      projectRoot,
      'session-b.jsonl',
      [
        makeChatRecord({
          uuid: 'u2',
          sessionId: 'session-b',
          type: 'user',
          timestamp: new Date(Date.now() - 30_000).toISOString(),
          message: { role: 'user', parts: [{ text: 'beta gribblesnort' }] },
        }),
      ],
      new Date(Date.now() - 30_000),
    );

    const mgr1 = new MemoryManager();
    await mgr1.ensureSearchIndexReady(
      projectRoot,
      makeMockConfig({ includeTranscripts: true }),
    );
    expect(
      mgr1
        .getSearchIndex(projectRoot)!
        .search('zorblatt', { source: 'transcript', limit: 10 }).length,
    ).toBe(1);

    // "Process 1" exits; session-a.jsonl is deleted while nothing is running.
    await fs.rm(path.join(getTranscriptDir(projectRoot), 'session-a.jsonl'));

    // "Process 2": a brand-new MemoryManager with an EMPTY transcriptFileStates
    // map that loads the persisted index from disk. A known-based prune would
    // never notice session-a's file is gone (it was never in this instance's
    // `known`); the persisted-index diff must still prune it.
    const mgr2 = new MemoryManager();
    await mgr2.ensureSearchIndexReady(
      projectRoot,
      makeMockConfig({ includeTranscripts: true }),
    );

    const index2 = mgr2.getSearchIndex(projectRoot)!;
    expect(
      index2.search('zorblatt', { source: 'transcript', limit: 10 }).length,
    ).toBe(0);
    // session-b survives untouched.
    expect(
      index2.search('gribblesnort', { source: 'transcript', limit: 10 }).length,
    ).toBe(1);
  });
});
