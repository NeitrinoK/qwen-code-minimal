/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { Storage } from '../config/storage.js';
import { getTranscriptDir } from './dreamAgentPlanner.js';
import {
  readTranscriptDocs,
  readTranscriptDocsIncremental,
  type TranscriptFileState,
} from './transcript-source.js';

function makeRecord(
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

describe('readTranscriptDocs', () => {
  let tempDir: string;
  let projectRoot: string;
  let transcriptDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'transcript-source-test-'),
    );
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    Storage.setRuntimeBaseDir(path.join(tempDir, 'runtime'));
    transcriptDir = getTranscriptDir(projectRoot);
    await fs.mkdir(transcriptDir, { recursive: true });
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  async function writeSession(
    fileName: string,
    records: ChatRecord[],
    extraLines: string[],
    mtime: Date,
  ): Promise<void> {
    const filePath = path.join(transcriptDir, fileName);
    const lines = [
      ...records.map((r) => JSON.stringify(r)),
      ...extraLines,
    ].join('\n');
    await fs.writeFile(filePath, `${lines}\n`, 'utf8');
    await fs.utimes(filePath, mtime, mtime);
  }

  const pem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(120)}\n-----END PRIVATE KEY-----`;

  it('reads user/assistant docs, excludes tool_result and system, redacts secrets, skips corrupt lines', async () => {
    const olderMtime = new Date('2026-01-01T00:00:00.000Z');
    const newerMtime = new Date('2026-01-05T00:00:00.000Z');

    await writeSession(
      'session-a.jsonl',
      [
        makeRecord({
          uuid: 'u1',
          sessionId: 'session-a',
          type: 'user',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: {
            role: 'user',
            parts: [{ text: 'What does redactSecrets do?' }],
          },
        }),
        makeRecord({
          uuid: 'a1',
          sessionId: 'session-a',
          type: 'assistant',
          timestamp: '2026-01-01T00:00:02.000Z',
          message: {
            role: 'model',
            parts: [{ text: 'It replaces secrets with [REDACTED] markers.' }],
          },
        }),
        makeRecord({
          uuid: 't1',
          sessionId: 'session-a',
          type: 'tool_result',
          timestamp: '2026-01-01T00:00:03.000Z',
          message: {
            role: 'user',
            parts: [{ text: 'tool output, should be excluded' }],
          },
        }),
        makeRecord({
          uuid: 's1',
          sessionId: 'session-a',
          type: 'system',
          timestamp: '2026-01-01T00:00:04.000Z',
          message: {
            role: 'user',
            parts: [{ text: 'system event, should be excluded' }],
          },
        }),
      ],
      [],
      olderMtime,
    );

    await writeSession(
      'session-b.jsonl',
      [
        makeRecord({
          uuid: 'u2',
          sessionId: 'session-b',
          type: 'user',
          timestamp: '2026-01-05T00:00:01.000Z',
          message: {
            role: 'user',
            parts: [{ text: 'Store this private key please' }],
          },
        }),
        makeRecord({
          uuid: 'a2',
          sessionId: 'session-b',
          type: 'assistant',
          timestamp: '2026-01-05T00:00:02.000Z',
          message: {
            role: 'model',
            parts: [{ text: `Here is the key:\n${pem}\ndone` }],
          },
        }),
        makeRecord({
          uuid: 't2',
          sessionId: 'session-b',
          type: 'tool_result',
          timestamp: '2026-01-05T00:00:03.000Z',
        }),
      ],
      ['{"not": "valid" "json"}', 'not even json at all {{{'],
      newerMtime,
    );

    const docs = await readTranscriptDocs(projectRoot, {
      maxSessions: 2,
      maxAgeDays: 3650,
    });

    // Only user/assistant records become docs; tool_result and system excluded.
    expect(docs).toHaveLength(4);
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual(
      ['session-a#a1', 'session-a#u1', 'session-b#a2', 'session-b#u2'].sort(),
    );

    const u1 = docs.find((d) => d.id === 'session-a#u1');
    expect(u1).toBeDefined();
    expect(u1!.source).toBe('transcript');
    expect(u1!.sessionId).toBe('session-a');
    expect(u1!.ts).toBe(Date.parse('2026-01-01T00:00:01.000Z'));
    expect(u1!.text).toBe('What does redactSecrets do?');

    const a2 = docs.find((d) => d.id === 'session-b#a2');
    expect(a2).toBeDefined();
    expect(a2!.text).toContain('[REDACTED]');
    expect(a2!.text).not.toContain('BEGIN PRIVATE KEY');
    expect(a2!.text).not.toContain('A'.repeat(120));
  });

  it('keeps only the newest-mtime session when maxSessions: 1', async () => {
    const olderMtime = new Date('2026-01-01T00:00:00.000Z');
    const newerMtime = new Date('2026-01-05T00:00:00.000Z');

    await writeSession(
      'session-a.jsonl',
      [
        makeRecord({
          uuid: 'u1',
          sessionId: 'session-a',
          type: 'user',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'user', parts: [{ text: 'old session message' }] },
        }),
      ],
      [],
      olderMtime,
    );

    await writeSession(
      'session-b.jsonl',
      [
        makeRecord({
          uuid: 'u2',
          sessionId: 'session-b',
          type: 'user',
          timestamp: '2026-01-05T00:00:01.000Z',
          message: {
            role: 'user',
            parts: [{ text: 'newest session message' }],
          },
        }),
      ],
      [],
      newerMtime,
    );

    const docs = await readTranscriptDocs(projectRoot, {
      maxSessions: 1,
      maxAgeDays: 3650,
    });

    expect(docs).toHaveLength(1);
    expect(docs[0].sessionId).toBe('session-b');
    expect(docs[0].id).toBe('session-b#u2');
  });

  it('excludes sessions older than maxAgeDays even when maxSessions allows more', async () => {
    const veryOld = new Date('2020-01-01T00:00:00.000Z');

    await writeSession(
      'session-old.jsonl',
      [
        makeRecord({
          uuid: 'u1',
          sessionId: 'session-old',
          type: 'user',
          timestamp: '2020-01-01T00:00:01.000Z',
          message: { role: 'user', parts: [{ text: 'ancient message' }] },
        }),
      ],
      [],
      veryOld,
    );

    const docs = await readTranscriptDocs(projectRoot, {
      maxSessions: 10,
      maxAgeDays: 1,
    });

    expect(docs).toEqual([]);
  });

  it('returns [] when the transcript directory does not exist', async () => {
    const otherProjectRoot = path.join(tempDir, 'no-chats-project');
    await fs.mkdir(otherProjectRoot, { recursive: true });

    const docs = await readTranscriptDocs(otherProjectRoot, {
      maxSessions: 5,
      maxAgeDays: 30,
    });

    expect(docs).toEqual([]);
  });
});

describe('readTranscriptDocsIncremental', () => {
  let tempDir: string;
  let projectRoot: string;
  let transcriptDir: string;
  let readSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'transcript-source-incremental-test-'),
    );
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    Storage.setRuntimeBaseDir(path.join(tempDir, 'runtime'));
    transcriptDir = getTranscriptDir(projectRoot);
    await fs.mkdir(transcriptDir, { recursive: true });
    // Spy on the shared per-file JSONL reader — this is the "expensive" step
    // (read + parse) the incremental variant is meant to skip for unchanged
    // files. Call through to the real implementation so doc content is
    // unaffected; only the call count is asserted on.
    const jsonlUtils = await import('../utils/jsonl-utils.js');
    readSpy = vi.spyOn(jsonlUtils, 'read');
  });

  afterEach(async () => {
    readSpy.mockRestore();
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  async function writeSession(
    fileName: string,
    records: ChatRecord[],
    mtime: Date,
  ): Promise<void> {
    const filePath = path.join(transcriptDir, fileName);
    const lines = records.map((r) => JSON.stringify(r)).join('\n');
    await fs.writeFile(filePath, `${lines}\n`, 'utf8');
    await fs.utimes(filePath, mtime, mtime);
  }

  function userRecord(
    sessionId: string,
    uuid: string,
    text: string,
    ts: string,
  ): ChatRecord {
    return makeRecord({
      uuid,
      sessionId,
      type: 'user',
      timestamp: ts,
      message: { role: 'user', parts: [{ text }] },
    });
  }

  const opts = { maxSessions: 10, maxAgeDays: 3650 };

  it('first call (empty known) returns all docs + fileStates for every in-retention file', async () => {
    await writeSession(
      'session-a.jsonl',
      [
        userRecord(
          'session-a',
          'u1',
          'hello from a',
          '2026-01-01T00:00:01.000Z',
        ),
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    );
    await writeSession(
      'session-b.jsonl',
      [
        userRecord(
          'session-b',
          'u2',
          'hello from b',
          '2026-01-02T00:00:01.000Z',
        ),
      ],
      new Date('2026-01-02T00:00:00.000Z'),
    );

    const result = await readTranscriptDocsIncremental(
      projectRoot,
      opts,
      new Map(),
    );

    expect(result.newDocs.map((d) => d.id).sort()).toEqual([
      'session-a#u1',
      'session-b#u2',
    ]);
    expect(result.fileStates.size).toBe(2);
    expect([...result.currentSessionIds].sort()).toEqual([
      'session-a',
      'session-b',
    ]);
    for (const state of result.fileStates.values()) {
      expect(state.mtimeMs).toBeGreaterThan(0);
      expect(state.size).toBeGreaterThan(0);
    }
    // Both files were read on this first pass.
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it('a second call with unchanged known state reads ZERO files', async () => {
    await writeSession(
      'session-a.jsonl',
      [
        userRecord(
          'session-a',
          'u1',
          'hello from a',
          '2026-01-01T00:00:01.000Z',
        ),
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    );
    await writeSession(
      'session-b.jsonl',
      [
        userRecord(
          'session-b',
          'u2',
          'hello from b',
          '2026-01-02T00:00:01.000Z',
        ),
      ],
      new Date('2026-01-02T00:00:00.000Z'),
    );

    const first = await readTranscriptDocsIncremental(
      projectRoot,
      opts,
      new Map(),
    );
    readSpy.mockClear();

    const second = await readTranscriptDocsIncremental(
      projectRoot,
      opts,
      first.fileStates,
    );

    expect(second.newDocs).toEqual([]);
    expect([...second.currentSessionIds].sort()).toEqual([
      'session-a',
      'session-b',
    ]);
    expect(second.fileStates.size).toBe(2);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('only re-reads a file whose content (mtime/size) changed', async () => {
    await writeSession(
      'session-a.jsonl',
      [
        userRecord(
          'session-a',
          'u1',
          'hello from a',
          '2026-01-01T00:00:01.000Z',
        ),
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    );
    await writeSession(
      'session-b.jsonl',
      [
        userRecord(
          'session-b',
          'u2',
          'hello from b',
          '2026-01-02T00:00:01.000Z',
        ),
      ],
      new Date('2026-01-02T00:00:00.000Z'),
    );

    const first = await readTranscriptDocsIncremental(
      projectRoot,
      opts,
      new Map(),
    );
    readSpy.mockClear();

    // Append a new record to session-a, bumping its size and mtime.
    await writeSession(
      'session-a.jsonl',
      [
        userRecord(
          'session-a',
          'u1',
          'hello from a',
          '2026-01-01T00:00:01.000Z',
        ),
        userRecord(
          'session-a',
          'u1b',
          'a follow-up message',
          '2026-01-01T00:00:02.000Z',
        ),
      ],
      new Date('2026-01-03T00:00:00.000Z'),
    );

    const second = await readTranscriptDocsIncremental(
      projectRoot,
      opts,
      first.fileStates,
    );

    expect(second.newDocs.map((d) => d.id).sort()).toEqual([
      'session-a#u1',
      'session-a#u1b',
    ]);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect([...second.currentSessionIds].sort()).toEqual([
      'session-a',
      'session-b',
    ]);
  });

  it('drops an evicted/deleted file from currentSessionIds', async () => {
    await writeSession(
      'session-a.jsonl',
      [
        userRecord(
          'session-a',
          'u1',
          'hello from a',
          '2026-01-01T00:00:01.000Z',
        ),
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    );
    await writeSession(
      'session-b.jsonl',
      [
        userRecord(
          'session-b',
          'u2',
          'hello from b',
          '2026-01-02T00:00:01.000Z',
        ),
      ],
      new Date('2026-01-02T00:00:00.000Z'),
    );

    const first = await readTranscriptDocsIncremental(
      projectRoot,
      opts,
      new Map(),
    );

    await fs.rm(path.join(transcriptDir, 'session-a.jsonl'));

    const second = await readTranscriptDocsIncremental(
      projectRoot,
      opts,
      first.fileStates,
    );

    expect([...second.currentSessionIds]).toEqual(['session-b']);
    expect(second.fileStates.size).toBe(1);
    expect([...second.fileStates.keys()][0]).toContain('session-b.jsonl');
  });

  it('never throws when the transcript directory does not exist', async () => {
    const otherProjectRoot = path.join(tempDir, 'no-chats-project');
    await fs.mkdir(otherProjectRoot, { recursive: true });

    const result = await readTranscriptDocsIncremental(
      otherProjectRoot,
      opts,
      new Map<string, TranscriptFileState>([
        ['/some/stale/path/session-x.jsonl', { mtimeMs: 1, size: 1 }],
      ]),
    );

    expect(result.newDocs).toEqual([]);
    expect(result.fileStates.size).toBe(0);
    expect(result.currentSessionIds.size).toBe(0);
  });
});
