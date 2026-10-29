/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transcript source reader for the memory search index.
 *
 * Reads the current project's session transcripts (JSONL under
 * `getTranscriptDir(projectRoot)`) and turns them into redacted,
 * retention-capped {@link TranscriptDoc}s suitable for indexing. Only
 * `user`/`assistant` records contribute text; `tool_result` and `system`
 * records are excluded. Every filesystem read is guarded so a missing
 * directory, an unreadable file, or a corrupt line never throws out of
 * {@link readTranscriptDocs} — the caller always gets a (possibly partial)
 * array back.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Part } from '@google/genai';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { read as readJsonlFile } from '../utils/jsonl-utils.js';
import { getTranscriptDir } from './dreamAgentPlanner.js';
import { redactSecrets } from './secret-scanner.js';

export interface TranscriptDoc {
  /** `${sessionId}#${uuid}` — stable, globally unique across sessions. */
  id: string;
  source: 'transcript';
  sessionId: string;
  /** Epoch ms parsed from the record's ISO timestamp. */
  ts: number;
  /** Rendered user/assistant text, secret-redacted. */
  text: string;
}

export interface TranscriptReadOptions {
  /** Keep at most this many of the newest-mtime session files. */
  maxSessions: number;
  /** Drop session files whose mtime is older than this many days. */
  maxAgeDays: number;
}

/** `{mtimeMs, size}` snapshot of one session file, used to detect changes. */
export interface TranscriptFileState {
  mtimeMs: number;
  size: number;
}

/** Result of {@link readTranscriptDocsIncremental}. */
export interface IncrementalTranscriptResult {
  /** Redacted docs read from new or changed (grown) files this pass. */
  newDocs: TranscriptDoc[];
  /** `{mtimeMs, size}` state for every in-retention file this pass. */
  fileStates: Map<string, TranscriptFileState>;
  /**
   * sessionIds (basename minus `.jsonl`) of every session file in retention
   * scope this pass — the authoritative "what should be indexed right now"
   * set. The caller diffs this against the *persisted* index (not the
   * in-memory `known` map) to prune docs whose session file was deleted or
   * evicted, so pruning stays correct even on the first reconcile of a fresh
   * process where `known` starts empty.
   */
  currentSessionIds: Set<string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface SessionFile {
  filePath: string;
  mtimeMs: number;
  size: number;
}

/** Join `part.text` for every text part with `\n`; non-text parts are ignored. */
function renderMessageText(record: ChatRecord): string {
  const parts = record.message?.parts;
  if (!parts || parts.length === 0) {
    return '';
  }
  const textParts: string[] = [];
  for (const part of parts as Part[]) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      textParts.push(part.text);
    }
  }
  return textParts.join('\n');
}

/**
 * Lists `*.jsonl` files in `transcriptDir` with their mtimes and sizes.
 * Never throws.
 */
async function listSessionFiles(transcriptDir: string): Promise<SessionFile[]> {
  let names: string[];
  try {
    names = await fs.readdir(transcriptDir);
  } catch {
    return [];
  }

  const jsonlNames = names.filter((name) => name.endsWith('.jsonl'));
  const results: SessionFile[] = [];
  await Promise.all(
    jsonlNames.map(async (name) => {
      const filePath = path.join(transcriptDir, name);
      try {
        const stats = await fs.stat(filePath);
        results.push({ filePath, mtimeMs: stats.mtimeMs, size: stats.size });
      } catch {
        // Unreadable/raced-away file — skip it.
      }
    }),
  );
  return results;
}

/**
 * Applies the shared retention policy — drop files older than `maxAgeDays`,
 * keep at most `maxSessions` of the newest-mtime survivors — to
 * `sessionFiles`. Both {@link readTranscriptDocs} and
 * {@link readTranscriptDocsIncremental} call this so their enumeration of
 * "which session files are currently in scope" can't drift apart.
 */
function selectRetainedSessionFiles(
  sessionFiles: SessionFile[],
  opts: TranscriptReadOptions,
  nowMs: number,
): SessionFile[] {
  const cutoffMs = nowMs - opts.maxAgeDays * DAY_MS;
  return sessionFiles
    .filter((f) => f.mtimeMs >= cutoffMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(0, opts.maxSessions));
}

/**
 * Reads one session file's records into redacted {@link TranscriptDoc}s.
 * This is the "expensive" per-file step (read + parse + redact) that
 * {@link readTranscriptDocsIncremental} skips for unchanged files. Never
 * throws — an unreadable or corrupt file yields `[]`.
 */
async function readSessionFileDocs(filePath: string): Promise<TranscriptDoc[]> {
  let records: ChatRecord[];
  try {
    records = await readJsonlFile<ChatRecord>(filePath);
  } catch {
    return [];
  }

  const docs: TranscriptDoc[] = [];
  for (const record of records) {
    if (record.type !== 'user' && record.type !== 'assistant') {
      continue;
    }
    const rendered = renderMessageText(record);
    if (!rendered) {
      continue;
    }
    const text = redactSecrets(rendered);
    if (!text) {
      continue;
    }
    docs.push({
      id: `${record.sessionId}#${record.uuid}`,
      source: 'transcript',
      sessionId: record.sessionId,
      ts: Date.parse(record.timestamp),
      text,
    });
  }
  return docs;
}

/** basename of `filePath` without its `.jsonl` extension. */
function sessionIdFromFilePath(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

/**
 * Reads the current project's session transcripts and returns indexable,
 * redacted, retention-capped docs. Missing transcript directory, unreadable
 * files, and corrupt JSONL lines are all tolerated (skipped, not thrown).
 */
export async function readTranscriptDocs(
  projectRoot: string,
  opts: TranscriptReadOptions,
): Promise<TranscriptDoc[]> {
  const transcriptDir = getTranscriptDir(projectRoot);
  const sessionFiles = await listSessionFiles(transcriptDir);
  if (sessionFiles.length === 0) {
    return [];
  }

  const kept = selectRetainedSessionFiles(sessionFiles, opts, Date.now());
  const docs: TranscriptDoc[] = [];
  for (const file of kept) {
    docs.push(...(await readSessionFileDocs(file.filePath)));
  }
  return docs;
}

/**
 * Incremental variant of {@link readTranscriptDocs}: only reads (and
 * redacts) session files that are new or have grown/changed since the last
 * pass, per `known`. Historical session files are immutable once a session
 * ends, so a file whose `{mtimeMs, size}` matches `known.get(path)` is
 * skipped entirely — no read, no parse, no redact.
 *
 * `fileStates` in the result covers every file currently in retention (the
 * caller should persist this map and pass it back in as `known` on the next
 * call). `currentSessionIds` is the authoritative set of sessionIds in
 * retention scope this pass; the caller diffs it against the *persisted*
 * index to prune docs whose session file was deleted or evicted — a
 * persisted-index diff, not a `known`-map diff, so it stays correct on the
 * first reconcile of a fresh process where `known` is empty.
 *
 * Never throws: a missing transcript directory yields empty `newDocs`,
 * `fileStates`, and `currentSessionIds`.
 */
export async function readTranscriptDocsIncremental(
  projectRoot: string,
  opts: TranscriptReadOptions,
  known: Map<string, TranscriptFileState>,
): Promise<IncrementalTranscriptResult> {
  const transcriptDir = getTranscriptDir(projectRoot);
  const sessionFiles = await listSessionFiles(transcriptDir);
  const kept = selectRetainedSessionFiles(sessionFiles, opts, Date.now());

  const newDocs: TranscriptDoc[] = [];
  const fileStates = new Map<string, TranscriptFileState>();
  const currentSessionIds = new Set<string>();

  for (const file of kept) {
    currentSessionIds.add(sessionIdFromFilePath(file.filePath));
    const state: TranscriptFileState = {
      mtimeMs: file.mtimeMs,
      size: file.size,
    };
    fileStates.set(file.filePath, state);

    const prior = known.get(file.filePath);
    if (prior && prior.mtimeMs === state.mtimeMs && prior.size === state.size) {
      continue; // unchanged since the last pass — skip the read+redact
    }
    newDocs.push(...(await readSessionFileDocs(file.filePath)));
  }

  return { newDocs, fileStates, currentSessionIds };
}
