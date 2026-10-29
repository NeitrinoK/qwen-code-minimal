/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (orig) => {
  const actual = await orig<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

import { classifyProbeResponse, probeReasoningSupport } from './probe.js';

const withReasoning = {
  choices: [{ message: { reasoning: 'because...', content: 'ok' } }],
};
const noReasoning = { choices: [{ message: { content: 'ok' } }] };

describe('classifyProbeResponse', () => {
  it('200 + reasoning => supported', () => {
    expect(classifyProbeResponse(200, withReasoning)).toBe('supported');
  });
  it('200 + no reasoning => accepted_no_thinking', () => {
    expect(classifyProbeResponse(200, noReasoning)).toBe(
      'accepted_no_thinking',
    );
  });
  it('400 => rejected', () => {
    expect(classifyProbeResponse(400, {})).toBe('rejected');
  });
  it('500 => unknown', () => {
    expect(classifyProbeResponse(500, {})).toBe('unknown');
  });
});

describe('probeReasoningSupport', () => {
  const base = {
    baseUrl: 'https://hub.example.com/openai/v1',
    apiKey: 'k',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
  };
  beforeEach(() => mockFetch.mockReset());

  it('classifies each trial', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => withReasoning,
      }) // high
      .mockResolvedValueOnce({ status: 400, json: async () => ({}) }); // auto
    const res = await probeReasoningSupport({
      ...base,
      trials: [
        {
          key: 'high',
          body: { enable_thinking: true, reasoning_effort: 'high' },
        },
        {
          key: 'auto',
          body: { enable_thinking: true, reasoning_effort: 'auto' },
        },
      ],
    });
    expect(res.get('high')).toBe('supported');
    expect(res.get('auto')).toBe('rejected');
  });

  it('maps a thrown request to unknown (never throws)', async () => {
    mockFetch.mockImplementationOnce(async () => {
      throw new Error('network');
    });
    const res = await probeReasoningSupport({
      ...base,
      trials: [{ key: 'x', body: {} }],
    });
    expect(res.get('x')).toBe('unknown');
  });
});
