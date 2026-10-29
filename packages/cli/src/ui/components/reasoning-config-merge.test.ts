/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { mergeReasoningExtraBody } from './reasoning-config-merge.js';

describe('mergeReasoningExtraBody', () => {
  it('thinking on with effort adds both keys, preserves siblings', () => {
    const out = mergeReasoningExtraBody(
      { some_other: 1 },
      {
        enableThinking: true,
        effort: 'medium',
        thinkingKey: 'enable_thinking',
      },
    );
    expect(out).toEqual({
      some_other: 1,
      enable_thinking: true,
      reasoning_effort: 'medium',
    });
  });
  it('thinking off writes false and removes reasoning_effort', () => {
    const out = mergeReasoningExtraBody(
      { enable_thinking: true, reasoning_effort: 'high', keep: 2 },
      { enableThinking: false, thinkingKey: 'enable_thinking' },
    );
    expect(out).toEqual({ enable_thinking: false, keep: 2 });
  });
  it('nested thinkingKey writes a nested object', () => {
    const out = mergeReasoningExtraBody(undefined, {
      enableThinking: true,
      thinkingKey: 'thinking.enabled',
    });
    expect(out).toEqual({ thinking: { enabled: true } });
  });
  it('effort omitted when family has none', () => {
    const out = mergeReasoningExtraBody(undefined, {
      enableThinking: true,
      thinkingKey: 'enable_thinking',
    });
    expect(out).toEqual({ enable_thinking: true });
  });
});
