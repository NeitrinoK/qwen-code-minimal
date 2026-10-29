/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deactivateStaleSkills } from './skill-deactivation.js';
import {
  getProjectSkillsRoot,
  getDisabledSkillsRoot,
} from '../skills/skill-paths.js';
import { loadSkillsFromDir } from '../skills/skill-load.js';
import {
  SKILL_STATS_SCHEMA_VERSION,
  type SkillStat,
  type SkillStatsFile,
} from './skill-stats-store.js';

async function makeAutoSkill(root: string, dirName: string, body = 'hi') {
  const dir = path.join(root, '.qwen', 'skills', dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${dirName}\ndescription: does ${dirName}\nsource: auto-skill\n---\n${body}\n`,
    'utf-8',
  );
  return dir;
}

async function makeHandAuthoredSkill(
  root: string,
  dirName: string,
  body = 'hi',
) {
  const dir = path.join(root, '.qwen', 'skills', dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${dirName}\ndescription: does ${dirName}\n---\n${body}\n`,
    'utf-8',
  );
  return dir;
}

function stat(partial: Partial<SkillStat>): SkillStat {
  return {
    launches: 0,
    lastUsedTs: 0,
    sessionsUsed: [],
    helped: 0,
    hurt: 0,
    neutral: 0,
    evidence: [],
    ...partial,
  };
}

function makeStats(skills: Record<string, SkillStat>): SkillStatsFile {
  return { schemaVersion: SKILL_STATS_SCHEMA_VERSION, skills };
}

const defaultOpts = { minSamples: 5, hurtRatio: 0.6, unusedSessions: 20 };

describe('deactivateStaleSkills', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-deactivation-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('moves an auto-skill above the hurt-ratio threshold to the disabled root and stamps deactivatedAt', async () => {
    await makeAutoSkill(root, 'auto-skill-bad');
    const stats = makeStats({
      'auto-skill-bad': stat({ helped: 1, hurt: 4 }), // 5 samples, ratio .8 > .6
    });
    const now = 1_000_000;

    const deactivated = await deactivateStaleSkills(
      root,
      stats,
      defaultOpts,
      now,
    );

    expect(deactivated).toEqual(['auto-skill-bad']);
    expect(stats.skills['auto-skill-bad'].deactivatedAt).toBe(now);
    await expect(
      fs.access(path.join(getProjectSkillsRoot(root), 'auto-skill-bad')),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(getDisabledSkillsRoot(root), 'auto-skill-bad')),
    ).resolves.toBeUndefined();
    // Reversible: the SKILL.md content is intact under the disabled root.
    const content = await fs.readFile(
      path.join(getDisabledSkillsRoot(root), 'auto-skill-bad', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain('source: auto-skill');
  });

  it('does NOT move an auto-skill below minSamples even with a bad ratio', async () => {
    await makeAutoSkill(root, 'auto-skill-fewsamples');
    const stats = makeStats({
      'auto-skill-fewsamples': stat({ helped: 1, hurt: 1 }), // 2 samples < 5
    });

    const deactivated = await deactivateStaleSkills(
      root,
      stats,
      defaultOpts,
      1,
    );

    expect(deactivated).toEqual([]);
    expect(stats.skills['auto-skill-fewsamples'].deactivatedAt).toBeUndefined();
    await expect(
      fs.access(path.join(getProjectSkillsRoot(root), 'auto-skill-fewsamples')),
    ).resolves.toBeUndefined();
  });

  it('never touches a hand-authored skill even with terrible stats', async () => {
    await makeHandAuthoredSkill(root, 'hand-written');
    const stats = makeStats({
      'hand-written': stat({ helped: 0, hurt: 10 }),
    });

    const deactivated = await deactivateStaleSkills(
      root,
      stats,
      defaultOpts,
      1,
    );

    expect(deactivated).toEqual([]);
    expect(stats.skills['hand-written'].deactivatedAt).toBeUndefined();
    await expect(
      fs.access(path.join(getProjectSkillsRoot(root), 'hand-written')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(getDisabledSkillsRoot(root), 'hand-written')),
    ).rejects.toThrow();
  });

  it('the loader can no longer see a deactivated skill after the move', async () => {
    await makeAutoSkill(root, 'auto-skill-gone');
    await makeAutoSkill(root, 'auto-skill-fine'); // stays live, no stats entry
    const stats = makeStats({
      'auto-skill-gone': stat({ helped: 1, hurt: 4 }),
    });

    await deactivateStaleSkills(root, stats, defaultOpts, 1);

    const loaded = await loadSkillsFromDir(getProjectSkillsRoot(root));
    expect(loaded.map((s) => s.name).sort()).toEqual(['auto-skill-fine']);
  });

  it('a rename failure on one skill does not prevent others or throw', async () => {
    await makeAutoSkill(root, 'auto-skill-first');
    await makeAutoSkill(root, 'auto-skill-second');
    const stats = makeStats({
      'auto-skill-first': stat({ helped: 1, hurt: 4 }),
      'auto-skill-second': stat({ helped: 1, hurt: 4 }),
    });

    const realRename = fs.rename;
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockImplementation(async (src, dest) => {
        if (String(src).includes('auto-skill-first')) {
          throw new Error('simulated rename failure');
        }
        return realRename(src, dest);
      });

    let deactivated: string[] = [];
    await expect(
      (async () => {
        deactivated = await deactivateStaleSkills(root, stats, defaultOpts, 1);
      })(),
    ).resolves.toBeUndefined();

    expect(deactivated).toEqual(['auto-skill-second']);
    expect(stats.skills['auto-skill-first'].deactivatedAt).toBeUndefined();
    expect(stats.skills['auto-skill-second'].deactivatedAt).toBe(1);
    // The failed one is still live and untouched.
    await expect(
      fs.access(path.join(getProjectSkillsRoot(root), 'auto-skill-first')),
    ).resolves.toBeUndefined();

    renameSpy.mockRestore();
  });

  it('never throws and returns [] when the skills root does not exist', async () => {
    const emptyRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skill-deactivation-empty-'),
    );
    const stats = makeStats({});
    await expect(
      deactivateStaleSkills(emptyRoot, stats, defaultOpts, 1),
    ).resolves.toEqual([]);
    await fs.rm(emptyRoot, { recursive: true, force: true });
  });

  it('never clobbers a pre-existing disabled copy; skips instead of deleting', async () => {
    await makeAutoSkill(root, 'auto-skill-collide');
    // A same-named disabled copy already exists (e.g. reactivated then
    // re-deactivated). It must survive untouched — "reversible, never delete".
    const existingDisabled = path.join(
      getDisabledSkillsRoot(root),
      'auto-skill-collide',
    );
    await fs.mkdir(existingDisabled, { recursive: true });
    const markerPath = path.join(existingDisabled, 'MARKER.txt');
    await fs.writeFile(markerPath, 'do-not-delete', 'utf-8');

    const stats = makeStats({
      'auto-skill-collide': stat({ helped: 1, hurt: 4 }), // over threshold
    });

    const deactivated = await deactivateStaleSkills(
      root,
      stats,
      defaultOpts,
      1,
    );

    expect(deactivated).toEqual([]);
    expect(stats.skills['auto-skill-collide'].deactivatedAt).toBeUndefined();
    // Live skill stays put.
    await expect(
      fs.access(path.join(getProjectSkillsRoot(root), 'auto-skill-collide')),
    ).resolves.toBeUndefined();
    // Pre-existing disabled dir + marker are intact — nothing deleted.
    await expect(fs.readFile(markerPath, 'utf-8')).resolves.toBe(
      'do-not-delete',
    );
  });
});
