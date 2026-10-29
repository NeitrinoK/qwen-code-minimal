/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * skill-stats-store: a versioned, persisted JSON store of per-skill outcome
 * stats (launch counts, helped/hurt/neutral tallies, evidence pointers).
 *
 * Self-contained persistence module — later skill-self-improvement work
 * (review/deactivation heuristics) reads and writes through this API rather
 * than touching the file directly. Reads are defensive: a missing file, an
 * unparsable file, or a schema-version mismatch all fall back to an empty
 * store instead of throwing, so a corrupt stats file can never break a
 * session. Writes are atomic (temp file + rename) and best-effort.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getAutoMemoryProjectStateDir } from './paths.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isNodeError } from '../utils/errors.js';

const debugLogger = createDebugLogger('SKILL_STATS_STORE');

const SKILL_STATS_FILENAME = 'skill-stats.json';

export const SKILL_STATS_SCHEMA_VERSION = 1;

export interface EvidencePtr {
  sessionId: string;
  ts: number;
  kind: 'tool-error' | 'user-correction' | 'retry';
  excerpt: string;
}

export interface SkillStat {
  launches: number;
  lastUsedTs: number;
  sessionsUsed: string[];
  helped: number;
  hurt: number;
  neutral: number;
  evidence: EvidencePtr[];
  deactivatedAt?: number;
}

export interface SkillStatsFile {
  schemaVersion: number;
  skills: Record<string, SkillStat>;
}

function createEmptySkillStatsFile(): SkillStatsFile {
  return { schemaVersion: SKILL_STATS_SCHEMA_VERSION, skills: {} };
}

function getSkillStatsPath(projectRoot: string): string {
  return path.join(
    getAutoMemoryProjectStateDir(projectRoot),
    SKILL_STATS_FILENAME,
  );
}

/**
 * Read the persisted skill-stats file for `projectRoot`. Never throws: a
 * missing file, unreadable file, unparsable JSON, or a `schemaVersion` that
 * doesn't match {@link SKILL_STATS_SCHEMA_VERSION} all resolve to a fresh
 * empty store — callers can always trust the shape of the result.
 */
export async function readSkillStats(
  projectRoot: string,
): Promise<SkillStatsFile> {
  try {
    const raw = await fs.readFile(getSkillStatsPath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SkillStatsFile>;
    if (
      parsed?.schemaVersion !== SKILL_STATS_SCHEMA_VERSION ||
      !parsed.skills
    ) {
      return createEmptySkillStatsFile();
    }
    return parsed as SkillStatsFile;
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') {
      debugLogger.debug(
        `readSkillStats(${projectRoot}): falling back to empty store — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return createEmptySkillStatsFile();
  }
}

/**
 * Persist `stats` for `projectRoot`. Atomic (temp file + rename) and
 * best-effort: a write failure (e.g. read-only filesystem, ENOSPC) is
 * logged and swallowed rather than thrown, mirroring the rest of the
 * managed-memory persistence layer.
 */
export async function writeSkillStats(
  projectRoot: string,
  stats: SkillStatsFile,
): Promise<void> {
  const statsPath = getSkillStatsPath(projectRoot);
  try {
    await fs.mkdir(path.dirname(statsPath), { recursive: true });
    await atomicWriteFile(statsPath, JSON.stringify(stats, null, 2), {
      encoding: 'utf-8',
    });
  } catch (err) {
    debugLogger.debug(
      `writeSkillStats(${projectRoot}): best-effort write failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Record a single skill-launch outcome into `stats` (in place). Creates the
 * skill's entry if absent, bumps `launches` and the matching outcome
 * counter, sets `lastUsedTs`, dedups `sessionId` into `sessionsUsed`, and —
 * when `evidence` is non-null — prepends it and truncates the array to
 * `maxEvidence` entries (newest first, oldest dropped).
 */
export function recordOutcome(
  stats: SkillStatsFile,
  skill: string,
  outcome: 'helped' | 'hurt' | 'neutral',
  sessionId: string,
  ts: number,
  evidence: EvidencePtr | null,
  maxEvidence: number,
): void {
  const entry: SkillStat = stats.skills[skill] ?? {
    launches: 0,
    lastUsedTs: 0,
    sessionsUsed: [],
    helped: 0,
    hurt: 0,
    neutral: 0,
    evidence: [],
  };
  stats.skills[skill] = entry;

  entry.launches += 1;
  entry[outcome] += 1;
  entry.lastUsedTs = ts;
  if (!entry.sessionsUsed.includes(sessionId)) {
    entry.sessionsUsed.push(sessionId);
  }
  if (evidence !== null) {
    entry.evidence.unshift(evidence);
    if (entry.evidence.length > maxEvidence) {
      entry.evidence.length = maxEvidence;
    }
  }
}
