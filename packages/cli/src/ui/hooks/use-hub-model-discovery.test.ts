/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildHubProviders, setHubProviders } from '@qwen-code/qwen-code-core';

const listProviderModelIds = vi.fn();
const applyProviderInstallPlan = vi.fn();
vi.mock(
  '@qwen-code/qwen-code-core/providers/discover-models.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      listProviderModelIds: (...a: unknown[]) => listProviderModelIds(...a),
    };
  },
);
vi.mock(
  '@qwen-code/qwen-code-core/providers/install.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      applyProviderInstallPlan: (...a: unknown[]) =>
        applyProviderInstallPlan(...a),
    };
  },
);

import { refreshHubModels } from './use-hub-model-discovery.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    getContentGeneratorConfig: () => ({
      apiKey: 'sk-test',
      apiKeyEnvKey: 'HUB_API_KEY',
      baseUrl: 'https://hub.example.com/openai/v1',
    }),
    getProxy: () => undefined,
    getNoProxy: () => [],
    getCaCertificates: () => [],
    getAuthType: () => 'openai',
    reloadModelProvidersConfig: vi.fn(),
    ...overrides,
  } as never;
}

describe('refreshHubModels', () => {
  afterEach(() => setHubProviders([]));

  beforeEach(() => {
    setHubProviders(
      buildHubProviders({
        label: 'Test Hub',
        endpoints: [
          { name: 'prod', baseUrl: 'https://hub.example.com/openai/v1' },
          {
            name: 'stage',
            baseUrl: 'https://stage.hub.example.com/openai/v1',
          },
        ],
      }),
    );
    listProviderModelIds.mockReset();
    applyProviderInstallPlan.mockReset();
  });

  it('returns "idle" when the active provider is not a hub', async () => {
    const config = makeConfig({
      getContentGeneratorConfig: () => ({
        apiKey: 'sk',
        apiKeyEnvKey: 'CUSTOM',
        baseUrl: 'https://example.com/v1',
      }),
    });
    const res = await refreshHubModels(config, {});
    expect(res).toBe('idle');
    expect(listProviderModelIds).not.toHaveBeenCalled();
  });

  it('returns "idle" for a custom provider without discoverModels and does not fetch', async () => {
    const config = makeConfig({
      getContentGeneratorConfig: () => ({
        apiKey: 'sk',
        apiKeyEnvKey: 'CUSTOM',
        baseUrl: 'https://custom.example.org/v1',
      }),
    });
    expect(await refreshHubModels(config, {})).toBe('idle');
    expect(listProviderModelIds).not.toHaveBeenCalled();
  });

  it('returns "idle" when no api key resolves', async () => {
    const config = makeConfig({
      getContentGeneratorConfig: () => ({
        apiKey: undefined,
        apiKeyEnvKey: 'HUB_API_KEY',
        baseUrl: 'https://hub.example.com/openai/v1',
      }),
    });
    const res = await refreshHubModels(config, {});
    expect(res).toBe('idle');
    expect(listProviderModelIds).not.toHaveBeenCalled();
  });

  it('fetches, reloads the registry, and returns "ready" on success', async () => {
    listProviderModelIds.mockResolvedValue(['m1', 'm2']);
    applyProviderInstallPlan.mockResolvedValue({ updatedModelProviders: {} });
    const config = makeConfig();
    const res = await refreshHubModels(config, {});
    expect(res).toBe('ready');
    expect(listProviderModelIds).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://hub.example.com/openai/v1',
        apiKey: 'sk-test',
      }),
    );
    expect(
      (
        config as unknown as {
          reloadModelProvidersConfig: ReturnType<typeof vi.fn>;
        }
      ).reloadModelProvidersConfig,
    ).toHaveBeenCalled();
  });

  it('discovers from the stage hub even when the key is not under HUB_STAGE_API_KEY', async () => {
    listProviderModelIds.mockResolvedValue(['stage-m1']);
    applyProviderInstallPlan.mockResolvedValue({ updatedModelProviders: {} });
    const config = makeConfig({
      getContentGeneratorConfig: () => ({
        apiKey: 'sk-stage',
        apiKeyEnvKey: 'OPENAI_API_KEY', // NOT the stage preset's env key
        baseUrl: 'https://stage.hub.example.com/openai/v1',
      }),
    });
    const res = await refreshHubModels(config, {});
    expect(res).toBe('ready');
    expect(listProviderModelIds).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://stage.hub.example.com/openai/v1',
        apiKey: 'sk-stage',
      }),
    );
  });

  it('discovers from the stage hub with a trailing slash on the base URL', async () => {
    listProviderModelIds.mockResolvedValue(['stage-m1']);
    applyProviderInstallPlan.mockResolvedValue({ updatedModelProviders: {} });
    const config = makeConfig({
      getContentGeneratorConfig: () => ({
        apiKey: 'sk-stage',
        apiKeyEnvKey: undefined,
        baseUrl: 'https://stage.hub.example.com/openai/v1/',
      }),
    });
    const res = await refreshHubModels(config, {});
    expect(res).toBe('ready');
  });

  it('returns "error" when the fetch throws', async () => {
    listProviderModelIds.mockRejectedValue(new Error('timeout'));
    const config = makeConfig();
    const res = await refreshHubModels(config, {});
    expect(res).toBe('error');
  });

  it('returns "auth_error" when the hub rejects the token (401)', async () => {
    listProviderModelIds.mockRejectedValue(
      Object.assign(new Error('Token validation error'), { status: 401 }),
    );
    const config = makeConfig();
    const res = await refreshHubModels(config, {});
    expect(res).toBe('auth_error');
  });

  it('reloads the registry with the exact merged map returned by applyProviderInstallPlan', async () => {
    listProviderModelIds.mockResolvedValue(['m1']);
    const mergedModelProviders = { 'test-hub': [{ id: 'm1' }] };
    applyProviderInstallPlan.mockResolvedValue({
      updatedModelProviders: mergedModelProviders,
    });
    const config = makeConfig();
    const res = await refreshHubModels(config, {});
    expect(res).toBe('ready');
    expect(
      (
        config as unknown as {
          reloadModelProvidersConfig: ReturnType<typeof vi.fn>;
        }
      ).reloadModelProvidersConfig,
    ).toHaveBeenCalledWith(mergedModelProviders);
  });

  it('returns "error" and does not reload the registry when applyProviderInstallPlan throws', async () => {
    listProviderModelIds.mockResolvedValue(['m1']);
    applyProviderInstallPlan.mockRejectedValue(new Error('install failed'));
    const config = makeConfig();
    const res = await refreshHubModels(config, {});
    expect(res).toBe('error');
    expect(
      (
        config as unknown as {
          reloadModelProvidersConfig: ReturnType<typeof vi.fn>;
        }
      ).reloadModelProvidersConfig,
    ).not.toHaveBeenCalled();
  });
});
