/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** The skill whose invocation lifts this gate for the rest of the session. */
export const WRITING_PLANS_GATE_SKILL = 'superpowers:writing-plans';

/** The skill whose active state arms this gate. */
export const BRAINSTORMING_SKILL = 'superpowers:brainstorming';

/** Max re-prompts before giving up (the plan-first write gate is the backstop). */
export const WRITING_PLANS_GATE_CAP = 2;

/** Instruction re-sent to the model when it moves to implement without a plan. */
export const WRITING_PLANS_REPROMPT_MESSAGE =
  "You've moved past design without a written plan. Before implementing or " +
  'writing any code, you MUST invoke the superpowers:writing-plans skill (call ' +
  "the Skill tool with skill='superpowers:writing-plans') to produce a detailed " +
  'implementation plan under docs/superpowers/plans/. Do not implement until ' +
  'that plan exists.';

/** Minimum characters for a single-line message to count as substantive. */
const MIN_SUBSTANTIVE_CHARS = 200;

/** ASCII '?', full-width '？' (U+FF1F), and Arabic '؟' (U+061F) question marks. */
const QUESTION_MARK = /[?？؟]/;

/**
 * Strict heuristic: does this message read as a substantive declarative
 * design / implementation-intent turn (as opposed to a question or a trivial
 * acknowledgement)? True iff it contains NO '?' character AND is substantive —
 * ≥2 non-empty lines OR ≥MIN_SUBSTANTIVE_CHARS characters. Pure.
 *
 * A '?' anywhere means the model is asking (the AskUserQuestion gate or a legit
 * design-approval step owns that case), so this gate defers. The substance
 * floor keeps a bare "ок, схема ясна" from tripping it.
 */
export function looksLikeDeclarativeImplementationTurn(text: string): boolean {
  if (!text || QUESTION_MARK.test(text)) {
    return false;
  }
  const nonEmptyLines = text.split('\n').filter((l) => l.trim().length > 0);
  const substantive =
    nonEmptyLines.length >= 2 || text.trim().length >= MIN_SUBSTANTIVE_CHARS;
  return substantive;
}

export interface WritingPlansGateInput {
  /** `skills.enforceWritingPlans` (default true). */
  enabled: boolean;
  /** `hasInvokedSkill('superpowers:brainstorming')`. */
  brainstormingActive: boolean;
  /** `hasInvokedSkill('superpowers:writing-plans')`. */
  writingPlansInvoked: boolean;
  /** `Config.isInteractive()`. */
  interactive: boolean;
  /** Dedicated re-prompt counter is below the cap. */
  underCap: boolean;
  /** The model's final message text this turn. */
  lastMessage: string;
}

/**
 * Pure gate decision. Returns true (RE-PROMPT) only for a substantive
 * declarative turn conclusion while enforcement is enabled, brainstorming is
 * active, writing-plans has NOT run, the session is interactive, and the
 * re-prompt cap is not yet reached.
 */
export function shouldForceWritingPlans(input: WritingPlansGateInput): boolean {
  return (
    input.enabled &&
    input.brainstormingActive &&
    !input.writingPlansInvoked &&
    input.interactive &&
    input.underCap &&
    looksLikeDeclarativeImplementationTurn(input.lastMessage)
  );
}
