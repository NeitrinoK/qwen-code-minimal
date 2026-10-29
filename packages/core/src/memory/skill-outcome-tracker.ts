/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SkillOutcomeTracker: a per-project, in-memory queue of pending skill
 * launches awaiting a next-turn outcome verdict, plus the glue that scores
 * and persists them into the skill-stats store (skill-stats-store.ts) using
 * the deterministic classifier in skill-outcome-scoring.ts.
 *
 * One instance lives per projectRoot on MemoryManager (see manager.ts),
 * mirroring how the memory/transcript search index is cached per project.
 * `registerLaunch` is called synchronously from the `skill` tool right
 * after each launch attempt; `scorePending` is called once at the start of
 * the next UserQuery turn from client.ts. Both are best-effort: neither
 * ever throws, so a bug here can never break skill launching or a turn.
 */

import type { SkillOutcomesSettings } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  scoreLaunch,
  type NextTurnSignals,
  type PendingLaunch,
  type ScoredOutcome,
} from './skill-outcome-scoring.js';
import {
  readSkillStats,
  writeSkillStats,
  recordOutcome,
  type EvidencePtr,
} from './skill-stats-store.js';

const debugLogger = createDebugLogger('SKILL_OUTCOME_TRACKER');

/** Evidence excerpts are capped so a single bad outcome can't bloat skill-stats.json. */
const MAX_EVIDENCE_EXCERPT_LEN = 300;

/**
 * Pick the raw (pre-redaction) text to use as evidence for a hurt outcome.
 * `NextTurnSignals` carries no raw tool-error text — only a boolean — so
 * the 'tool-error' case falls back to the next user message (often the
 * best available account of what went wrong) or a generic description.
 */
function excerptSource(
  scored: ScoredOutcome,
  launch: PendingLaunch,
  signals: NextTurnSignals,
): string {
  switch (scored.evidenceKind) {
    case 'user-correction':
      return signals.nextUserMessage ?? '';
    case 'retry':
      return (
        signals.nextUserMessage ??
        `Skill "${launch.skill}" was relaunched right after its previous launch.`
      );
    case 'tool-error':
    default:
      if (!launch.launchSucceeded) {
        return `Skill "${launch.skill}" launch failed.`;
      }
      return (
        signals.nextUserMessage ??
        `A tool error occurred during the "${launch.skill}" launch turn.`
      );
  }
}

function buildEvidence(
  scored: ScoredOutcome,
  launch: PendingLaunch,
  signals: NextTurnSignals,
  redact: (s: string) => string,
): EvidencePtr | null {
  if (scored.outcome !== 'hurt' || scored.evidenceKind === null) {
    return null;
  }
  const raw = excerptSource(scored, launch, signals);
  return {
    sessionId: launch.sessionId,
    ts: launch.launchTs,
    kind: scored.evidenceKind,
    excerpt: redact(raw).slice(0, MAX_EVIDENCE_EXCERPT_LEN),
  };
}

export class SkillOutcomeTracker {
  private pending: PendingLaunch[] = [];

  constructor(
    private readonly projectRoot: string,
    private readonly getSettings: () => SkillOutcomesSettings,
  ) {}

  /**
   * Queue a launch for a next-turn outcome verdict. No-op (nothing queued)
   * when `getSettings().enabled` is false. Never throws.
   */
  registerLaunch(
    skill: string,
    sessionId: string,
    launchTs: number,
    launchSucceeded: boolean,
  ): void {
    try {
      if (!this.getSettings().enabled) return;
      this.pending.push({ skill, sessionId, launchTs, launchSucceeded });
    } catch (error) {
      debugLogger.debug(
        `registerLaunch(${skill}) failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** True when at least one launch is queued for scoring. */
  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /**
   * Score every pending launch, persist the results into the skill-stats
   * store, and clear the queue. `signals` is invoked once per pending
   * launch so future callers can vary signals per-launch (e.g. by skill);
   * current callers pass a constant closure.
   *
   * Never throws. The queue is always cleared up front so a permanently
   * broken signal/redact function can't wedge it — but nothing is written
   * to disk unless every launch is scored and `writeSkillStats` succeeds,
   * so a failure partway through leaves the persisted stats file exactly
   * as it was.
   */
  async scorePending(
    signals: (launch: PendingLaunch) => NextTurnSignals,
    redact: (s: string) => string,
  ): Promise<void> {
    if (this.pending.length === 0) return;
    const launches = this.pending;
    this.pending = [];
    try {
      const settings = this.getSettings();
      if (!settings.enabled) return;
      const stats = await readSkillStats(this.projectRoot);
      for (const launch of launches) {
        const sig = signals(launch);
        const scored = scoreLaunch(launch, sig, {
          useCorrectionHeuristic: settings.useCorrectionHeuristic ?? true,
        });
        const evidence = buildEvidence(scored, launch, sig, redact);
        recordOutcome(
          stats,
          launch.skill,
          scored.outcome,
          launch.sessionId,
          launch.launchTs,
          evidence,
          settings.maxEvidencePerSkill ?? 5,
        );
      }
      await writeSkillStats(this.projectRoot, stats);
    } catch (error) {
      debugLogger.debug(
        `scorePending(${this.projectRoot}) failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
