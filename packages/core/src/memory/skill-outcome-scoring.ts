/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * skill-outcome-scoring: a pure, deterministic classifier that turns a
 * pending skill launch plus next-turn signals into a helped/hurt/neutral
 * verdict.
 *
 * No I/O, no clock calls, no dependency on any other skill-self-improvement
 * module — callers gather `PendingLaunch` and `NextTurnSignals` themselves
 * (e.g. from the skill-stats store and transcript) and pass them in.
 */

/** A skill launch awaiting an outcome verdict once the next turn happens. */
export interface PendingLaunch {
  skill: string;
  sessionId: string;
  launchTs: number;
  launchSucceeded: boolean;
}

/** Deterministic signals observed in/after the turn the skill was launched in. */
export interface NextTurnSignals {
  toolErrorInLaunchTurn: boolean;
  sameSkillRelaunched: boolean;
  nextUserMessage: string | null;
  sessionEnded: boolean;
}

/** Verdict produced by {@link scoreLaunch}. */
export interface ScoredOutcome {
  outcome: 'helped' | 'hurt' | 'neutral';
  evidenceKind: 'tool-error' | 'user-correction' | 'retry' | null;
}

/**
 * Matches a leading correction phrase ("no", "wrong", "try again", "undo",
 * "revert", etc). Anchored to the start of the (trimmed) message so it only
 * fires on messages that open with a correction, not ones that merely
 * mention one mid-sentence.
 */
export const CORRECTION_RE =
  /^(no|nope|wrong|that'?s wrong|not (what|right)|try again|undo|revert)\b/i;

/** Whether `msg` opens with a correction phrase. `null` is never a correction. */
export function isCorrection(msg: string | null): boolean {
  if (msg === null) return false;
  return CORRECTION_RE.test(msg.trimStart());
}

/**
 * Classify a completed skill launch. Rules are evaluated in order — the
 * first matching hurt condition wins, then helped, then neutral.
 */
export function scoreLaunch(
  launch: PendingLaunch,
  signals: NextTurnSignals,
  opts: { useCorrectionHeuristic: boolean },
): ScoredOutcome {
  if (!launch.launchSucceeded || signals.toolErrorInLaunchTurn) {
    return { outcome: 'hurt', evidenceKind: 'tool-error' };
  }
  if (signals.sameSkillRelaunched) {
    return { outcome: 'hurt', evidenceKind: 'retry' };
  }
  if (opts.useCorrectionHeuristic && isCorrection(signals.nextUserMessage)) {
    return { outcome: 'hurt', evidenceKind: 'user-correction' };
  }

  if (
    signals.nextUserMessage !== null &&
    !isCorrection(signals.nextUserMessage)
  ) {
    return { outcome: 'helped', evidenceKind: null };
  }

  return { outcome: 'neutral', evidenceKind: null };
}
