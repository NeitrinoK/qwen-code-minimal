/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { preloadRuntimeFetchModule } from '../utils/runtimeFetchOptions.js';

const listMock = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn(function OpenAI() {
    return { models: { list: listMock } };
  }),
}));

import { listProviderModelIds } from './discover-models.js';

describe('listProviderModelIds', () => {
  beforeAll(async () => {
    await preloadRuntimeFetchModule();
  });

  beforeEach(() => {
    listMock.mockReset();
  });

  it('returns model ids from the OpenAI models.list response', async () => {
    listMock.mockResolvedValue({ data: [{ id: 'a' }, { id: 'b' }] });
    const ids = await listProviderModelIds({
      baseUrl: 'https://hub.example.com/openai/v1',
      apiKey: 'sk-test',
    });
    expect(ids).toEqual(['a', 'b']);
  });

  it('rejects when models.list rejects (network / 401)', async () => {
    listMock.mockRejectedValue(new Error('401 Unauthorized'));
    await expect(
      listProviderModelIds({
        baseUrl: 'https://hub.example.com/openai/v1',
        apiKey: 'sk',
      }),
    ).rejects.toThrow('401');
  });

  it('aborts and rejects when the request exceeds timeoutMs', async () => {
    vi.useFakeTimers();
    listMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const p = listProviderModelIds({
      baseUrl: 'https://hub.example.com/openai/v1',
      apiKey: 'sk',
      timeoutMs: 4000,
    });
    // eslint-disable-next-line vitest/valid-expect
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(4000);
    await assertion;
    vi.useRealTimers();
  });
});
