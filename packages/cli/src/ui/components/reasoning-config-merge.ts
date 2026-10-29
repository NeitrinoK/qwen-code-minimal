/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ReasoningEffortLevel } from '@qwen-code/qwen-code-core';

export interface ReasoningChoice {
  enableThinking: boolean;
  effort?: ReasoningEffortLevel;
  thinkingKey: 'enable_thinking' | 'thinking.enabled';
}

/**
 * Merge a reasoning choice into a model's `extra_body`, preserving unrelated
 * keys. Returns a NEW object (never mutates `existing`).
 * - thinking OFF → set the thinking key false and delete `reasoning_effort`.
 * - thinking ON  → set the thinking key true and set `reasoning_effort` when an
 *   effort level was chosen (else leave/clear it).
 */
export function mergeReasoningExtraBody(
  existing: Record<string, unknown> | undefined,
  choice: ReasoningChoice,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };

  // Clear both possible thinking shapes first so we never leave a stale one.
  delete out['enable_thinking'];
  if (out['thinking'] && typeof out['thinking'] === 'object') {
    const t = { ...(out['thinking'] as Record<string, unknown>) };
    delete t['enabled'];
    if (Object.keys(t).length === 0) delete out['thinking'];
    else out['thinking'] = t;
  }

  if (choice.thinkingKey === 'thinking.enabled') {
    const t = (out['thinking'] as Record<string, unknown> | undefined) ?? {};
    out['thinking'] = { ...t, enabled: choice.enableThinking };
  } else {
    out['enable_thinking'] = choice.enableThinking;
  }

  if (choice.enableThinking && choice.effort) {
    out['reasoning_effort'] = choice.effort;
  } else {
    delete out['reasoning_effort'];
  }
  return out;
}
