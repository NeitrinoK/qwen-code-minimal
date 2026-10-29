/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillOutcomesSettings } from '../config/config.js';
import type { NextTurnSignals } from './skill-outcome-scoring.js';
import { readSkillStats } from './skill-stats-store.js';
import { getAutoMemoryProjectStateDir } from './paths.js';
import { SkillOutcomeTracker } from './skill-outcome-tracker.js';

const noopRedact = (s: string) => s;

function defaultSettings(): Required<SkillOutcomesSettings> {
  return {
    enabled: true,
    useCorrectionHeuristic: true,
    minSamples: 5,
    hurtRatio: 0.6,
    unusedSessions: 20,
    maxEvidencePerSkill: 5,
  };
}

describe('SkillOutcomeTracker', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skill-outcome-tracker-'),
    );
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function statsPath(): string {
    return path.join(
      getAutoMemoryProjectStateDir(projectRoot),
      'skill-stats.json',
    );
  }

  it('registerLaunch is a no-op when outcome tracking is disabled: no pending, no file written', async () => {
    const settings: Required<SkillOutcomesSettings> = {
      ...defaultSettings(),
      enabled: false,
    };
    const tracker = new SkillOutcomeTracker(projectRoot, () => settings);
    tracker.registerLaunch('my-skill', 'session-1', 1000, true);

    expect(tracker.hasPending()).toBe(false);
    await expect(fs.access(statsPath())).rejects.toThrow();
  });

  it('a correction message after a successful launch scores hurt/user-correction with a redacted evidence entry', async () => {
    const settings = defaultSettings();
    const tracker = new SkillOutcomeTracker(projectRoot, () => settings);
    tracker.registerLaunch('my-skill', 'session-1', 1000, true);
    expect(tracker.hasPending()).toBe(true);

    const redact = vi.fn((s: string) =>
      s.replace('sk-secret-token', '[REDACTED]'),
    );
    const signals: NextTurnSignals = {
      toolErrorInLaunchTurn: false,
      sameSkillRelaunched: false,
      nextUserMessage: 'no, that broke it — my key is sk-secret-token',
      sessionEnded: false,
    };
    await tracker.scorePending(() => signals, redact);

    expect(tracker.hasPending()).toBe(false);
    const stats = await readSkillStats(projectRoot);
    const entry = stats.skills['my-skill'];
    expect(entry.launches).toBe(1);
    expect(entry.hurt).toBe(1);
    expect(entry.helped).toBe(0);
    expect(entry.evidence).toHaveLength(1);
    expect(entry.evidence[0].kind).toBe('user-correction');
    expect(entry.evidence[0].excerpt).toContain('[REDACTED]');
    expect(entry.evidence[0].excerpt).not.toContain('sk-secret-token');
    expect(redact).toHaveBeenCalled();
  });

  it('a failed launch scores hurt/tool-error regardless of next-turn signals', async () => {
    const settings = defaultSettings();
    const tracker = new SkillOutcomeTracker(projectRoot, () => settings);
    tracker.registerLaunch('flaky-skill', 'session-1', 2000, false);

    const signals: NextTurnSignals = {
      toolErrorInLaunchTurn: false,
      sameSkillRelaunched: false,
      nextUserMessage: 'thanks, looks good',
      sessionEnded: false,
    };
    await tracker.scorePending(() => signals, noopRedact);

    const stats = await readSkillStats(projectRoot);
    const entry = stats.skills['flaky-skill'];
    expect(entry.hurt).toBe(1);
    expect(entry.evidence[0].kind).toBe('tool-error');
  });

  it('scorePending never throws when the signals function throws, and leaves prior stats intact', async () => {
    const settings = defaultSettings();
    const tracker = new SkillOutcomeTracker(projectRoot, () => settings);

    // Establish a prior, successfully-persisted stats file.
    tracker.registerLaunch('stable-skill', 'session-1', 1000, true);
    await tracker.scorePending(
      () => ({
        toolErrorInLaunchTurn: false,
        sameSkillRelaunched: false,
        nextUserMessage: 'great, thanks',
        sessionEnded: false,
      }),
      noopRedact,
    );
    const priorStats = await readSkillStats(projectRoot);
    expect(priorStats.skills['stable-skill'].helped).toBe(1);

    // Now register another launch and score it with a throwing signals fn.
    tracker.registerLaunch('another-skill', 'session-2', 3000, true);
    await expect(
      tracker.scorePending(() => {
        throw new Error('boom');
      }, noopRedact),
    ).resolves.toBeUndefined();

    expect(tracker.hasPending()).toBe(false);
    const statsAfter = await readSkillStats(projectRoot);
    expect(statsAfter).toEqual(priorStats);
    expect(statsAfter.skills['another-skill']).toBeUndefined();
  });

  it('scorePending is a no-op when there is nothing pending', async () => {
    const settings = defaultSettings();
    const tracker = new SkillOutcomeTracker(projectRoot, () => settings);
    await expect(
      tracker.scorePending(() => {
        throw new Error('should not be called');
      }, noopRedact),
    ).resolves.toBeUndefined();
    await expect(fs.access(statsPath())).rejects.toThrow();
  });

  it('scorePending never throws when getSettings() throws, and leaves prior stats intact', async () => {
    // `getSettings` works while we register launches and persist a prior
    // stats file, then throws on the scorePending that follows — so the
    // guard around `getSettings()` inside scorePending is the only thing
    // that keeps this from rejecting. (Distinct from the throwing-signals-fn
    // case above, which never reaches getSettings.)
    let settingsThrow = false;
    const tracker = new SkillOutcomeTracker(projectRoot, () => {
      if (settingsThrow) throw new Error('settings unavailable');
      return defaultSettings();
    });

    tracker.registerLaunch('stable-skill', 'session-1', 1000, true);
    await tracker.scorePending(
      () => ({
        toolErrorInLaunchTurn: false,
        sameSkillRelaunched: false,
        nextUserMessage: 'great, thanks',
        sessionEnded: false,
      }),
      noopRedact,
    );
    const priorStats = await readSkillStats(projectRoot);
    expect(priorStats.skills['stable-skill'].helped).toBe(1);

    tracker.registerLaunch('another-skill', 'session-2', 3000, true);
    settingsThrow = true;
    await expect(
      tracker.scorePending(
        () => ({
          toolErrorInLaunchTurn: false,
          sameSkillRelaunched: false,
          nextUserMessage: 'no, that broke it',
          sessionEnded: false,
        }),
        noopRedact,
      ),
    ).resolves.toBeUndefined();

    expect(tracker.hasPending()).toBe(false);
    const statsAfter = await readSkillStats(projectRoot);
    expect(statsAfter).toEqual(priorStats);
    expect(statsAfter.skills['another-skill']).toBeUndefined();
  });

  it('a getSettings() that throws during registerLaunch never throws and leaves nothing pending', () => {
    const tracker = new SkillOutcomeTracker(projectRoot, () => {
      throw new Error('settings unavailable');
    });
    expect(() =>
      tracker.registerLaunch('my-skill', 'session-1', 1000, true),
    ).not.toThrow();
    expect(tracker.hasPending()).toBe(false);
  });
});
