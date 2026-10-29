/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { Config } from './config.js';

// Minimal Config construction mirrors the sibling `makeConfig` in
// config.hubLoad.test.ts. We isolate the pre-compact-on-switch behaviour by
// stubbing the model-config delegate (no-op), the content-generator config
// (new window) and the LLM client (last-prompt proxy + tryCompressChat spy).
function makeConfig(): Config {
  return new Config({
    cwd: '/tmp',
    targetDir: '/tmp',
    debugMode: false,
    model: 'test-model',
  });
}

interface Stubs {
  config: Config;
  tryCompressChat: ReturnType<typeof vi.fn>;
}

function stubConfig(
  lastPromptTokens: number,
  opts: { rejects?: boolean } = {},
): Stubs {
  const config = makeConfig();
  const tryCompressChat = vi.fn(() =>
    opts.rejects
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({} as unknown),
  );

  // Isolate: the real delegate would try to reload the model registry.
  (
    config as unknown as {
      modelsConfig: { reloadModelProvidersConfig: unknown };
    }
  ).modelsConfig.reloadModelProvidersConfig = vi.fn();

  // New model's window after the (stubbed) reload.
  config.getContentGeneratorConfig = vi.fn(
    () => ({ contextWindowSize: 262_144 }) as never,
  );

  // Stub the LLM client: last-prompt proxy + spy compaction.
  (config as unknown as { llmClient: unknown }).llmClient = {
    getChat: () => ({ getLastPromptTokenCount: () => lastPromptTokens }),
    tryCompressChat,
  };

  return { config, tryCompressChat };
}

describe('Config.reloadModelProvidersConfig pre-compact on switch', () => {
  it('force-compacts once when the current context exceeds the new window', () => {
    const { config, tryCompressChat } = stubConfig(900_000);

    config.reloadModelProvidersConfig();

    expect(tryCompressChat).toHaveBeenCalledTimes(1);
    expect(tryCompressChat).toHaveBeenCalledWith(
      'model-switch-precompact',
      true,
    );
  });

  it('does not compact when the context fits the new window', () => {
    const { config, tryCompressChat } = stubConfig(100_000);

    config.reloadModelProvidersConfig();

    expect(tryCompressChat).not.toHaveBeenCalled();
  });

  it('never throws when the best-effort compaction rejects', async () => {
    const { config, tryCompressChat } = stubConfig(900_000, { rejects: true });

    expect(() => config.reloadModelProvidersConfig()).not.toThrow();
    expect(tryCompressChat).toHaveBeenCalledTimes(1);
    // Let the fire-and-forget rejection settle so its .catch runs and there is
    // no unhandled rejection.
    await Promise.resolve();
  });
});
