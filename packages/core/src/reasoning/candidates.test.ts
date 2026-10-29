/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { reasoningCandidates } from './candidates.js';

describe('reasoningCandidates', () => {
  it('deepseek: thinking + low/medium/high/max effort', () => {
    const c = reasoningCandidates('deepseek-ai/DeepSeek-V4-Flash');
    expect(c.supportsThinking).toBe(true);
    expect(c.thinkingKey).toBe('enable_thinking');
    expect(c.effortLevels).toEqual(['low', 'medium', 'high', 'max']);
  });
  it('qwen: thinking, no effort levels', () => {
    const c = reasoningCandidates('Qwen/Qwen3.6-27B');
    expect(c.supportsThinking).toBe(true);
    expect(c.effortLevels).toEqual([]);
  });
  it('glm: thinking via nested key, no effort', () => {
    const c = reasoningCandidates('glm-4.7');
    expect(c.thinkingKey).toBe('thinking.enabled');
    expect(c.effortLevels).toEqual([]);
  });
  it('unknown: generic thinking + effort', () => {
    const c = reasoningCandidates('some/mystery-model');
    expect(c.supportsThinking).toBe(true);
    expect(c.effortLevels).toEqual(['low', 'medium', 'high']);
  });
  it('never offers "auto"', () => {
    for (const id of ['deepseek-x', 'qwen-x', 'glm-x', 'zzz']) {
      expect(reasoningCandidates(id).effortLevels as string[]).not.toContain(
        'auto',
      );
    }
  });
});
