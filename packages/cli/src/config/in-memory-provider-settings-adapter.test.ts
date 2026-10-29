/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { applyProviderInstallPlan } from '@qwen-code/qwen-code-core/providers/install.js';
import { buildInstallPlan } from '@qwen-code/qwen-code-core/providers/provider-config.js';
import { buildHubProviders } from '@qwen-code/qwen-code-core/providers/presets/openai-hub.js';
import { InMemoryProviderSettingsAdapter } from './in-memory-provider-settings-adapter.js';

describe('InMemoryProviderSettingsAdapter', () => {
  it('seeds and returns modelProviders without touching disk', () => {
    const seed = { 'openai-hub': [{ id: 'x' }] };
    const a = new InMemoryProviderSettingsAdapter({ modelProviders: seed });
    expect(a.getModelProviders()).toEqual(seed);
  });

  it('records setValue for modelProviders and dotted keys in memory', () => {
    const a = new InMemoryProviderSettingsAdapter({});
    a.setValue('modelProviders', { 'openai-hub': [{ id: 'y' }] });
    a.setValue('security.auth.selectedType', 'openai');
    expect(a.getModelProviders()).toEqual({ 'openai-hub': [{ id: 'y' }] });
    expect(a.getValue('security.auth.selectedType')).toBe('openai');
  });

  it('reflects dotted modelProviders.<authType> writes in getModelProviders', () => {
    const a = new InMemoryProviderSettingsAdapter({
      modelProviders: { openai: [{ id: 'old' }] },
    });
    a.setValue('modelProviders.openai', [{ id: 'new' }]);
    expect(a.getModelProviders()).toEqual({ openai: [{ id: 'new' }] });
    expect(a.getValue('modelProviders.openai')).toEqual([{ id: 'new' }]);
  });

  it('lets applyProviderInstallPlan refresh an existing hub model list', async () => {
    const [hubProvider] = buildHubProviders({
      label: 'Test Hub',
      endpoints: [{ name: 'prod', baseUrl: 'https://hub.example.com/v1' }],
    });
    const baseUrl = hubProvider.baseUrl as string;
    const a = new InMemoryProviderSettingsAdapter({
      modelProviders: {
        openai: [
          {
            id: 'Qwen/Qwen3.6-27B',
            name: '[Test Hub] Qwen/Qwen3.6-27B',
            baseUrl,
            envKey: 'HUB_API_KEY',
          },
        ],
      },
    });
    const plan = buildInstallPlan(hubProvider, {
      baseUrl,
      apiKey: 'test-key',
      modelIds: ['Qwen/Qwen3.8-27B', 'zai-org/GLM-5.2'],
    });
    const result = await applyProviderInstallPlan(plan, {
      settings: a,
      doRefreshAuth: false,
    });
    expect(result.updatedModelProviders['openai']?.map((m) => m.id)).toEqual(
      expect.arrayContaining(['Qwen/Qwen3.8-27B', 'zai-org/GLM-5.2']),
    );
  });

  it('persist and backup are no-ops (do not throw)', () => {
    const a = new InMemoryProviderSettingsAdapter({});
    expect(() => {
      a.backup?.();
      a.persist();
      a.cleanupBackup?.();
    }).not.toThrow();
  });
});
