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

const mockDispatcher = vi.hoisted(() => vi.fn());
vi.mock('../utils/proxyUtils.js', () => ({
  createHttpDispatcher: mockDispatcher,
}));

import { parseLoadFrames, fetchHubLoad } from './load-metrics.js';

// One Grafana panel response: two models, second series ends on a null point.
function panel(pairs: Array<[string, Array<number | null>]>) {
  return {
    results: {
      A: {
        frames: pairs.map(([model, vals]) => ({
          schema: {
            fields: [
              { name: 'time', type: 'time' },
              { name: 'Value', type: 'number', labels: { model } },
            ],
          },
          data: { values: [vals.map((_, i) => i), vals] },
        })),
      },
    },
  };
}

describe('parseLoadFrames', () => {
  it('takes the last non-null value per model and merges active+queue', () => {
    const active = panel([
      ['deepseek-ai/DeepSeek-V4-Flash', [4, 11]],
      ['Qwen/Qwen3.6-27B', [50, 40]],
    ]);
    const queue = panel([
      ['deepseek-ai/DeepSeek-V4-Flash', [100, 157]],
      ['Qwen/Qwen3.6-27B', [1, 0]],
    ]);
    const snap = parseLoadFrames(active, queue);
    expect(snap.get('deepseek-ai/DeepSeek-V4-Flash')).toEqual({
      active: 11,
      queue: 157,
    });
    expect(snap.get('Qwen/Qwen3.6-27B')).toEqual({ active: 40, queue: 0 });
  });

  it('ignores trailing null points (uses the last numeric value)', () => {
    const active = panel([['m', [7, null]]]);
    const snap = parseLoadFrames(active, { results: {} });
    expect(snap.get('m')).toEqual({ active: 7 });
  });

  it('returns an empty map for malformed input', () => {
    expect(parseLoadFrames(null, undefined).size).toBe(0);
  });

  it('returns empty map when frames contains null', () => {
    expect(
      parseLoadFrames({ results: { A: { frames: [null] } } }, undefined).size,
    ).toBe(0);
  });

  it('returns empty map when frames is not an array', () => {
    expect(
      parseLoadFrames({ results: { A: { frames: 'nope' } } }, undefined).size,
    ).toBe(0);
  });

  it('returns empty map when schema.fields is not an array', () => {
    expect(
      parseLoadFrames(
        {
          results: {
            A: {
              frames: [{ schema: { fields: 'x' }, data: {} }],
            },
          },
        },
        undefined,
      ).size,
    ).toBe(0);
  });
});

describe('fetchHubLoad', () => {
  const deps = {
    baseUrl: 'https://grafana.example.com',
    token: 'tok',
    activePanelId: 7,
    queuePanelId: 8,
  };
  beforeEach(() => mockFetch.mockReset());

  it('returns a snapshot on success', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => panel([['m', [1, 2]]]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => panel([['m', [9, 3]]]),
      });
    const snap = await fetchHubLoad(deps);
    expect(snap?.get('m')).toEqual({ active: 2, queue: 3 });
  });

  it('returns null when a request throws', async () => {
    mockFetch.mockImplementationOnce(async () => {
      throw new Error('network');
    });
    expect(await fetchHubLoad(deps)).toBeNull();
  });

  it('returns null on a non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    expect(await fetchHubLoad(deps)).toBeNull();
  });

  it('passes the configured proxy settings to the dispatcher unchanged', async () => {
    mockDispatcher.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => panel([['m', [1]]]),
    });
    await fetchHubLoad({
      ...deps,
      proxy: 'http://proxy.example.com:3128',
      noProxy: ['internal.example.com'],
      caCertificates: ['CERT'],
    });
    expect(mockDispatcher).toHaveBeenCalledWith({
      proxyUrl: 'http://proxy.example.com:3128',
      noProxy: ['internal.example.com'],
      caCertificates: ['CERT'],
    });
  });
});
