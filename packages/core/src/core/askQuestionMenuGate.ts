/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** The skill whose active state gates this enforcement. */
export const ASK_QUESTION_GATE_SKILL = 'superpowers:brainstorming';

/** Max re-prompts before giving up and letting the prose question stand. */
export const ASK_QUESTION_GATE_CAP = 2;

/** Instruction re-sent to the model when it asks in prose instead of the tool. */
export const ASK_QUESTION_REPROMPT_MESSAGE =
  'You asked a multiple-choice question as plain text. Re-ask it now by ' +
  'calling the AskUserQuestion tool with the same options so it renders as a ' +
  'native selectable menu. Do not repeat the question as prose.';

/**
 * How many trailing non-empty lines to scan for the options list. Wide enough
 * to capture a bundled multi-question message (the model sometimes packs several
 * clarifying questions, each with its own option list, into one message).
 */
const TAIL_LINES = 20;
/** Max characters of an enumerated item's text for it to read as an option label. */
const MAX_ITEM_LEN = 120;
const MIN_OPTIONS = 2;

// Enumerated-item prefixes: "1." / "1)" / "-" / "*" / "•", then whitespace + content.
const ENUM_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+(\S.*)$/;

/** ASCII '?', full-width '？' (U+FF1F), and Arabic '؟' (U+061F) question marks. */
const QUESTION_MARK = /[?？؟]/;

/**
 * Heuristic: does this message read as an enumerated-options question?
 * True iff it contains a '?' AND the last TAIL_LINES non-empty lines contain at
 * least MIN_OPTIONS enumerated items whose label text is at most MAX_ITEM_LEN
 * characters (short enough to read as an option label rather than a paragraph).
 *
 * There is deliberately NO upper bound on the option count: the number of
 * options does not make something not-a-question, and the model sometimes
 * bundles several option-questions into one message (many short items total).
 * A single over-long item is skipped (not counted) rather than aborting the
 * whole detection, so one verbose option among short ones still fires. Pure.
 */
export function looksLikeEnumeratedOptionsQuestion(text: string): boolean {
  if (!text || !QUESTION_MARK.test(text)) {
    return false;
  }
  const nonEmpty = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const tail = nonEmpty.slice(-TAIL_LINES);

  let optionCount = 0;
  for (const line of tail) {
    const m = line.match(ENUM_ITEM);
    if (m) {
      const label = m[1].trim();
      // A paragraph-length item reads as content, not an option label — skip
      // it, but don't let it veto genuine short options elsewhere in the list.
      if (label.length > MAX_ITEM_LEN) {
        continue;
      }
      optionCount++;
    }
  }
  return optionCount >= MIN_OPTIONS;
}

export interface AskQuestionGateInput {
  /** `skills.enforceAskQuestion` (default true). */
  enabled: boolean;
  /** `hasInvokedSkill('superpowers:brainstorming')`. */
  brainstormingActive: boolean;
  /** `Config.isInteractive()`. */
  interactive: boolean;
  /** Dedicated re-prompt counter is below the cap. */
  underCap: boolean;
  /** The model's final message text this turn. */
  lastMessage: string;
}

/**
 * Pure gate decision. Returns true (RE-PROMPT) only for an enumerated-options
 * question emitted in prose while enforcement is enabled, brainstorming is
 * active, the session is interactive, and the re-prompt cap is not yet reached.
 */
export function shouldEnforceAskQuestion(input: AskQuestionGateInput): boolean {
  return (
    input.enabled &&
    input.brainstormingActive &&
    input.interactive &&
    input.underCap &&
    looksLikeEnumeratedOptionsQuestion(input.lastMessage)
  );
}
