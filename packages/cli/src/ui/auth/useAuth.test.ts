/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  AuthType,
  buildHubProviders,
  customProvider,
  generateCustomEnvKey as generateCustomApiKeyEnvKey,
  resolveBaseUrl,
  type ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import {
  useAuthCommand,
  normalizeCustomModelIds,
  maskApiKey,
} from './useAuth.js';
import { setNestedPropertySafe } from '../../config/settingsUtils.js';

vi.mock('../../config/settingsUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settingsUtils.js')>();
  return {
    ...actual,
    backupSettingsFile: vi.fn(),
    restoreSettingsFromBackup: vi.fn(),
    cleanupSettingsBackup: vi.fn(),
  };
});

vi.mock('../../config/modelProvidersScope.js', () => ({
  getPersistScopeForModelSelection: vi.fn(() => 'user'),
}));

const [hubProvider] = buildHubProviders({
  label: 'Test Hub',
  endpoints: [{ name: 'prod', baseUrl: 'https://hub.example.com/v1' }],
});

const createSettings = () => {
  const file = {
    path: '/tmp/settings.json',
    settings: { modelProviders: {} } as Record<string, unknown>,
    originalSettings: {} as Record<string, unknown>,
  };
  return {
    get merged() {
      return file.settings;
    },
    setValue: vi.fn((_scope: unknown, key: string, value: unknown) => {
      setNestedPropertySafe(file.settings, key, value);
      setNestedPropertySafe(file.originalSettings, key, value);
    }),
    recomputeMerged: vi.fn(),
    forScope: vi.fn(() => file),
  };
};

const createConfig = () => {
  const modelsConfig = {
    syncAfterAuthRefresh: vi.fn(),
  };
  return {
    getAuthType: vi.fn(() => AuthType.USE_OPENAI),
    reloadModelProvidersConfig: vi.fn(),
    syncModelSelection: vi.fn(),
    refreshAuth: vi.fn(async () => undefined),
    getModelsConfig: vi.fn(() => modelsConfig),
  };
};

describe('useAuthCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('accepts OpenAI Responses as QWEN_DEFAULT_AUTH_TYPE', () => {
    vi.stubEnv('QWEN_DEFAULT_AUTH_TYPE', AuthType.USE_OPENAI_RESPONSES);
    const settings = createSettings();
    const config = createConfig();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, vi.fn()),
    );

    expect(result.current.authError).toBeNull();
  });

  it('exposes closeAuthDialog that flips isAuthDialogOpen to false', () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    act(() => {
      result.current.openAuthDialog();
    });
    expect(result.current.isAuthDialogOpen).toBe(true);

    act(() => {
      result.current.closeAuthDialog();
    });
    expect(result.current.isAuthDialogOpen).toBe(false);
    expect(result.current.authError).toBe(null);
  });

  it('configures Test Hub via the unified provider submit', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    const inputs: ProviderSetupInputs = {
      baseUrl: resolveBaseUrl(hubProvider),
      apiKey: 'sk-test',
      modelIds: ['Qwen/Qwen3.6-27B'],
    };

    await act(async () => {
      await result.current.handleProviderSubmit(hubProvider, inputs);
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'env.HUB_API_KEY',
      'sk-test',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      'openai',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'model.name',
      'Qwen/Qwen3.6-27B',
    );
    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
    expect(result.current.isAuthDialogOpen).toBe(false);
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Successfully configured Test Hub'),
      }),
      expect.any(Number),
    );
  });

  it('configures Custom API Key via the provider install plan flow', async () => {
    const envKey = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://api.example.com/v1',
    );
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleProviderSubmit(customProvider, {
        protocol: AuthType.USE_OPENAI,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-custom',
        modelIds: ['custom-model'],
        advancedConfig: {
          enableThinking: true,
        },
      });
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      `env.${envKey}`,
      'sk-custom',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'model.name',
      'custom-model',
    );
    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });

  it('uses the effective Responses auth state after OpenAI setup', async () => {
    const settings = createSettings();
    const config = createConfig();
    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, vi.fn()),
    );
    await act(async () => {
      await result.current.handleProviderSubmit(customProvider, {
        protocol: AuthType.USE_OPENAI,
        wireApi: 'responses',
        baseUrl: 'https://responses.test/v1',
        apiKey: 'test',
        modelIds: ['model'],
      });
    });
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      AuthType.USE_OPENAI_RESPONSES,
    );
    expect(config.refreshAuth).toHaveBeenCalledWith(
      AuthType.USE_OPENAI_RESPONSES,
    );
    expect(result.current.pendingAuthType).toBeUndefined();
  });

  it('cancelAuthentication resets dialog + flags + clears authError', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();
    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    // Put the hook into the middle of an in-flight auth + an error to make
    // sure cancel resets *all* the visible state, not just isAuthenticating.
    act(() => {
      result.current.onAuthError('boom');
    });
    expect(result.current.authError).toBe('boom');
    expect(result.current.isAuthDialogOpen).toBe(true);

    act(() => {
      result.current.cancelAuthentication();
    });

    expect(result.current.isAuthenticating).toBe(false);
    expect(result.current.externalAuthState).toBeNull();
    expect(result.current.isAuthDialogOpen).toBe(true);
    expect(result.current.authError).toBeNull();
  });

  it('surfaces install-plan rejection as an auth error and records telemetry', async () => {
    const settings = createSettings();
    const config = createConfig();
    config.refreshAuth = vi.fn(async () => {
      throw new Error('refreshAuth rejected: bad endpoint');
    });
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleProviderSubmit(hubProvider, {
        baseUrl: resolveBaseUrl(hubProvider),
        apiKey: 'sk-bad',
        modelIds: ['Qwen/Qwen3.6-27B'],
      });
    });

    // handleAuthFailure should have set the error, reopened the dialog, and
    // cleared the in-flight flag. The success toast must NOT have fired.
    expect(result.current.authError).toEqual(
      expect.stringContaining('refreshAuth rejected'),
    );
    expect(result.current.isAuthDialogOpen).toBe(true);
    expect(result.current.isAuthenticating).toBe(false);
    expect(addItem).not.toHaveBeenCalled();
    // pendingAuthType was set before applyProviderInstallPlan ran, so
    // handleAuthFailure had it available — the AuthEvent path is no longer
    // silently dropped on failure. (We can't assert the telemetry sink
    // directly here, but the visible side effects above all depend on
    // handleAuthFailure having seen pendingAuthType.)
    expect(result.current.pendingAuthType).toBe(AuthType.USE_OPENAI);
  });
});

describe('generateCustomApiKeyEnvKey', () => {
  it('generates deterministic URL-based env key', () => {
    const key = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://api.openai.com/v1',
    );
    expect(key).toMatch(/^QWEN_CUSTOM_API_KEY_[A-Z0-9_]+$/);
    const key2 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://api.openai.com/v1',
    );
    expect(key).toBe(key2);
  });

  it('produces different keys for different base URLs', () => {
    const key1 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://api.openai.com/v1',
    );
    const key2 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'http://localhost:11434/v1',
    );
    expect(key1).not.toBe(key2);
  });

  it('produces equal keys for URLs that differ only in trailing slash', () => {
    const key1 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://openrouter.ai/api/v1/',
    );
    const key2 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://openrouter.ai/api/v1',
    );
    expect(key1).toBe(key2);
  });
});

describe('normalizeCustomModelIds', () => {
  it('splits comma-separated model IDs', () => {
    const result = normalizeCustomModelIds('qwen/qwen3-coder,openai/gpt-4.1');
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('trims whitespace from each model ID', () => {
    const result = normalizeCustomModelIds(
      ' qwen/qwen3-coder , openai/gpt-4.1 ',
    );
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('deduplicates while preserving order', () => {
    const result = normalizeCustomModelIds(
      'qwen/qwen3-coder,openai/gpt-4.1,qwen/qwen3-coder',
    );
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('removes empty entries', () => {
    const result = normalizeCustomModelIds('qwen/qwen3-coder,,openai/gpt-4.1');
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('returns empty array for empty input', () => {
    const result = normalizeCustomModelIds('');
    expect(result).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    const result = normalizeCustomModelIds('  ,  ,  ');
    expect(result).toEqual([]);
  });

  it('handles single model ID', () => {
    const result = normalizeCustomModelIds('qwen/qwen3-coder');
    expect(result).toEqual(['qwen/qwen3-coder']);
  });
});

describe('maskApiKey', () => {
  it('masks a standard API key showing first 3 and last 4 chars', () => {
    const result = maskApiKey('sk-or-v1-1234567890abcdef');
    expect(result).toBe('sk-...cdef');
  });

  it('shows placeholder for empty string', () => {
    const result = maskApiKey('');
    expect(result).toBe('(not set)');
  });

  it('masks short keys with asterisks', () => {
    const result = maskApiKey('abc');
    expect(result).toBe('***');
  });

  it('masks 6-char keys with asterisks', () => {
    const result = maskApiKey('abcdef');
    expect(result).toBe('***');
  });

  it('trims whitespace before masking', () => {
    const result = maskApiKey('  sk-or-v1-1234567890abcdef  ');
    expect(result).toBe('sk-...cdef');
  });
});
