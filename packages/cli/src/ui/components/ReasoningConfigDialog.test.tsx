/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { buildReasoningOptions, buildTrials } from './ReasoningConfigDialog.js';
import { reasoningCandidates } from '@qwen-code/qwen-code-core';

describe('buildTrials', () => {
  it('deepseek yields off + one trial per effort', () => {
    const trials = buildTrials(
      reasoningCandidates('deepseek-ai/DeepSeek-V4-Flash'),
    );
    const keys = trials.map((t) => t.key);
    expect(keys).toEqual([
      'effort:low',
      'effort:medium',
      'effort:high',
      'effort:max',
    ]);
    expect(trials[3].body).toEqual({
      enable_thinking: true,
      reasoning_effort: 'max',
    });
  });
  it('qwen yields a single thinking-on trial', () => {
    const trials = buildTrials(reasoningCandidates('Qwen/Qwen3.6-27B'));
    expect(trials.map((t) => t.key)).toEqual(['thinking:on']);
    expect(trials[0].body).toEqual({ enable_thinking: true });
  });
});

describe('buildReasoningOptions', () => {
  it('annotates options with badges', () => {
    const cands = reasoningCandidates('deepseek-ai/DeepSeek-V4-Flash');
    const badges = new Map([
      ['effort:high', 'supported'],
      ['effort:low', 'rejected'],
    ] as const);
    const opts = buildReasoningOptions(cands, badges as never);
    const high = opts.find((o) => o.value === 'effort:high')!;
    const low = opts.find((o) => o.value === 'effort:low')!;
    expect(high.title).toContain('✓');
    expect(low.title).toContain('✗');
    // Always an explicit "thinking off" option:
    expect(opts.some((o) => o.value === 'thinking:off')).toBe(true);
  });
});
