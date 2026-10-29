/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * skill-deactivation: reversible auto-deactivation of consistently-bad
 * auto-skills.
 *
 * Auto-skills (SKILL.md frontmatter `source: auto-skill`) that have
 * accumulated enough recorded outcomes (see `skill-stats-store.ts`) and
 * whose hurt ratio crosses a configured threshold are moved OUT of the
 * scanned skills root (`getProjectSkillsRoot`) into an unscanned sibling
 * directory (`getDisabledSkillsRoot`). This is always a rename, never a
 * delete: a deactivated skill's directory remains fully intact and can be
 * restored by moving it back. If a same-named disabled copy already exists
 * the skill is skipped (never clobbered) — see the move logic below.
 *
 * Hand-authored skills (SKILL.md without `source: auto-skill` frontmatter)
 * are never touched by this module — deactivation reuses the same
 * `hasAutoSkillSource` detector `skillReviewAgentPlanner.ts` already uses
 * to protect hand-authored skills from edit, rather than hand-rolling a
 * second YAML/frontmatter check.
 *
 * ## Scope: the "unused" rule
 * `SkillOutcomesSettings.unusedSessions` documents a session-count-based
 * staleness threshold, but `SkillStat` only records `sessionsUsed` (the
 * distinct session ids the skill actually ran in) and `lastUsedTs` — there
 * is no reliable global "sessions elapsed since project start" counter
 * available to this module, and inventing a fragile one (e.g. counting
 * calls to this function) would misfire under concurrent projects/sessions
 * or partial history. Per the task's guidance to degrade gracefully rather
 * than build a fragile proxy, this module implements only the hurt-ratio
 * rule. `opts.unusedSessions` is accepted for forward-compatibility with
 * the `SkillOutcomesSettings` config surface but is currently unused;
 * wiring a real "unused" signal is left for when a reliable global session
 * counter exists.
 */

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import {
  getProjectSkillsRoot,
  getDisabledSkillsRoot,
  SKILL_FILE_NAME,
} from '../skills/skill-paths.js';
import { hasAutoSkillSource } from './skillReviewAgentPlanner.js';
import type { SkillStatsFile } from './skill-stats-store.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SKILL_DEACTIVATION');

export interface DeactivateStaleSkillsOptions {
  minSamples: number;
  hurtRatio: number;
  /**
   * Accepted for forward-compatibility with `SkillOutcomesSettings`.
   * Currently unused — see the module doc comment for why the "unused
   * skill" rule is not implemented here.
   */
  unusedSessions: number;
}

/**
 * Scan auto-skill directories under the project skills root and move any
 * whose recorded outcomes cross the hurt-ratio threshold into the disabled
 * (unscanned) sibling directory. On each skill actually moved, sets
 * `stats.skills[name].deactivatedAt = now` (mutates `stats` in place — the
 * caller is responsible for persisting it via `writeSkillStats`).
 *
 * Never throws: a missing skills root resolves to `[]`, and a failure
 * deactivating one skill (permission error, concurrent removal, etc.) is
 * logged and skipped so the rest of the batch still runs.
 *
 * Returns the directory names of the skills that were deactivated.
 */
export async function deactivateStaleSkills(
  projectRoot: string,
  stats: SkillStatsFile,
  opts: DeactivateStaleSkillsOptions,
  now: number,
): Promise<string[]> {
  const skillsRoot = getProjectSkillsRoot(projectRoot);
  const disabledRoot = getDisabledSkillsRoot(projectRoot);
  const deactivated: string[] = [];

  let entries: Dirent[];
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch (err) {
    debugLogger.debug(
      `deactivateStaleSkills: cannot read skills root ${skillsRoot} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return deactivated;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;

    try {
      const skillStat = stats.skills[name];
      if (!skillStat || skillStat.deactivatedAt !== undefined) continue;

      const total = skillStat.helped + skillStat.hurt;
      const crossesHurtRatio =
        total >= opts.minSamples && skillStat.hurt / total > opts.hurtRatio;
      if (!crossesHurtRatio) continue;

      const skillDir = path.join(skillsRoot, name);
      const manifestPath = path.join(skillDir, SKILL_FILE_NAME);
      const isAutoSkill = await hasAutoSkillSource(manifestPath);
      if (isAutoSkill !== true) continue; // hand-authored or unreadable — never touch.

      const targetDir = path.join(disabledRoot, name);
      // Collision-safe, NEVER delete: if a same-named disabled copy already
      // exists (e.g. a skill was deactivated, manually reactivated by moving
      // it back, then re-deactivated), do NOT clobber it. Skip this skill,
      // leaving the live copy in place. This intentionally diverges from
      // `stageSkillDirs`'s rm-then-rename — the pending root is a transient
      // staging area that can clobber, but the disabled root must preserve
      // the reversible copy so "reversible, never delete" holds.
      let targetExists = true;
      try {
        await fs.access(targetDir);
      } catch {
        targetExists = false;
      }
      if (targetExists) {
        debugLogger.warn(
          `skipping deactivation of ${name}: a disabled copy already exists`,
        );
        continue;
      }

      await fs.mkdir(disabledRoot, { recursive: true });
      await fs.rename(skillDir, targetDir);

      skillStat.deactivatedAt = now;
      deactivated.push(name);
      debugLogger.debug(`Deactivated stale auto-skill "${name}".`);
    } catch (err) {
      debugLogger.warn(
        `deactivateStaleSkills: failed to deactivate "${name}" — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return deactivated;
}
