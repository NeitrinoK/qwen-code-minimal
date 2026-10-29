/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readSkillStats,
  writeSkillStats,
  recordOutcome,
  SKILL_STATS_SCHEMA_VERSION,
  type SkillStatsFile,
  type EvidencePtr,
} from './skill-stats-store.js';
import {
  getAutoMemoryProjectStateDir,
  clearAutoMemoryRootCache,
} from './paths.js';

function makeEvidence(n: number): EvidencePtr {
  return {
    sessionId: `session-${n}`,
    ts: n,
    kind: 'tool-error',
    excerpt: `excerpt ${n}`,
  };
}

describe('skill-stats-store', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
    clearAutoMemoryRootCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-stats-store-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    clearAutoMemoryRootCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('readSkillStats', () => {
    it('returns an empty store when the state dir/file is missing', async () => {
      const result = await readSkillStats(projectRoot);
      expect(result).toEqual({
        schemaVersion: SKILL_STATS_SCHEMA_VERSION,
        skills: {},
      });
    });

    it('returns an empty store when the file is corrupt JSON', async () => {
      const stateDir = getAutoMemoryProjectStateDir(projectRoot);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'skill-stats.json'),
        '{ not valid json',
        'utf-8',
      );
      const result = await readSkillStats(projectRoot);
      expect(result).toEqual({
        schemaVersion: SKILL_STATS_SCHEMA_VERSION,
        skills: {},
      });
    });

    it('returns an empty store when schemaVersion does not match', async () => {
      const stateDir = getAutoMemoryProjectStateDir(projectRoot);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'skill-stats.json'),
        JSON.stringify({ schemaVersion: 999, skills: { foo: {} } }),
        'utf-8',
      );
      const result = await readSkillStats(projectRoot);
      expect(result).toEqual({
        schemaVersion: SKILL_STATS_SCHEMA_VERSION,
        skills: {},
      });
    });
  });

  describe('writeSkillStats / readSkillStats round-trip', () => {
    it('round-trips a stats object with evidence', async () => {
      const stats: SkillStatsFile = {
        schemaVersion: SKILL_STATS_SCHEMA_VERSION,
        skills: {
          'my-skill': {
            launches: 3,
            lastUsedTs: 12345,
            sessionsUsed: ['s1', 's2'],
            helped: 2,
            hurt: 0,
            neutral: 1,
            evidence: [makeEvidence(1), makeEvidence(2)],
          },
        },
      };
      await writeSkillStats(projectRoot, stats);
      const result = await readSkillStats(projectRoot);
      expect(result).toEqual(stats);
    });
  });

  describe('recordOutcome', () => {
    function emptyStats(): SkillStatsFile {
      return { schemaVersion: SKILL_STATS_SCHEMA_VERSION, skills: {} };
    }

    it('creates a new entry and increments launches + the matching counter', () => {
      const stats = emptyStats();
      recordOutcome(stats, 'skill-a', 'helped', 'session-1', 100, null, 10);
      const entry = stats.skills['skill-a'];
      expect(entry.launches).toBe(1);
      expect(entry.helped).toBe(1);
      expect(entry.hurt).toBe(0);
      expect(entry.neutral).toBe(0);
      expect(entry.lastUsedTs).toBe(100);
      expect(entry.sessionsUsed).toEqual(['session-1']);
      expect(entry.evidence).toEqual([]);
    });

    it('increments the right counter for hurt and neutral outcomes', () => {
      const stats = emptyStats();
      recordOutcome(stats, 'skill-a', 'hurt', 's1', 1, null, 10);
      recordOutcome(stats, 'skill-a', 'neutral', 's1', 2, null, 10);
      const entry = stats.skills['skill-a'];
      expect(entry.launches).toBe(2);
      expect(entry.helped).toBe(0);
      expect(entry.hurt).toBe(1);
      expect(entry.neutral).toBe(1);
    });

    it('dedups a repeated sessionId into sessionsUsed', () => {
      const stats = emptyStats();
      recordOutcome(stats, 'skill-a', 'helped', 'session-1', 1, null, 10);
      recordOutcome(stats, 'skill-a', 'helped', 'session-1', 2, null, 10);
      recordOutcome(stats, 'skill-a', 'helped', 'session-2', 3, null, 10);
      const entry = stats.skills['skill-a'];
      expect(entry.sessionsUsed).toEqual(['session-1', 'session-2']);
      expect(entry.launches).toBe(3);
    });

    it('null evidence adds nothing to the evidence array', () => {
      const stats = emptyStats();
      recordOutcome(stats, 'skill-a', 'helped', 's1', 1, null, 10);
      expect(stats.skills['skill-a'].evidence).toEqual([]);
    });

    it('prepends evidence and caps it at maxEvidence, keeping the newest', () => {
      const stats = emptyStats();
      recordOutcome(stats, 'skill-a', 'hurt', 's1', 1, makeEvidence(1), 2);
      recordOutcome(stats, 'skill-a', 'hurt', 's1', 2, makeEvidence(2), 2);
      recordOutcome(stats, 'skill-a', 'hurt', 's1', 3, makeEvidence(3), 2);
      const entry = stats.skills['skill-a'];
      expect(entry.evidence).toHaveLength(2);
      expect(entry.evidence[0]).toEqual(makeEvidence(3));
      expect(entry.evidence[1]).toEqual(makeEvidence(2));
    });

    it('updates lastUsedTs to the most recent call', () => {
      const stats = emptyStats();
      recordOutcome(stats, 'skill-a', 'helped', 's1', 100, null, 10);
      recordOutcome(stats, 'skill-a', 'helped', 's1', 50, null, 10);
      expect(stats.skills['skill-a'].lastUsedTs).toBe(50);
    });
  });
});
