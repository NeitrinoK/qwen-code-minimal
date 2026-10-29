/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decide whether a failed send should be treated as a context overflow and
 * trigger reactive compaction. True when the error text is already recognised
 * as an overflow, OR when we can prove the prompt exceeds the active window
 * (size-aware) — which covers opaque provider errors (e.g. a self-hosted hub
 * `400 "Error from inference-provider"`) that carry no recognisable text.
 * The size branch requires a known window (> 0), so a normal-sized context
 * never takes this path and unrelated errors are unaffected. Pure.
 */
export function isLikelyContextOverflow(input: {
  textRecognized: boolean;
  estimatedPromptTokens: number;
  contextWindow: number;
}): boolean {
  if (input.textRecognized) {
    return true;
  }
  return (
    input.contextWindow > 0 && input.estimatedPromptTokens > input.contextWindow
  );
}

/**
 * Decide whether switching to a model with `newContextWindow` should force a
 * compaction because the current context (`estimatedContextTokens`) no longer
 * fits. Pure; requires a known window (> 0).
 */
export function shouldPreCompactOnSwitch(input: {
  estimatedContextTokens: number;
  newContextWindow: number;
}): boolean {
  return (
    input.newContextWindow > 0 &&
    input.estimatedContextTokens > input.newContextWindow
  );
}
