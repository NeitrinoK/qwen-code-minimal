/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  ModelProvidersConfig,
  ProviderSettingsAdapter,
} from '@qwen-code/qwen-code-core';

/** `modelProviders.<authType>` → `<authType>`; undefined for any other key. */
function modelProvidersSubKey(key: string): string | undefined {
  const prefix = 'modelProviders.';
  return key.startsWith(prefix) && key.length > prefix.length
    ? key.slice(prefix.length)
    : undefined;
}

/**
 * A ProviderSettingsAdapter whose writes stay in memory. Used to run the
 * provider install machinery (buildInstallPlan + applyProviderInstallPlan) for
 * ephemeral model discovery without persisting anything to settings.json.
 */
export class InMemoryProviderSettingsAdapter
  implements ProviderSettingsAdapter
{
  private values: Record<string, unknown>;
  private modelProviders: ModelProvidersConfig;

  constructor(seed: {
    modelProviders?: ModelProvidersConfig;
    values?: Record<string, unknown>;
  }) {
    this.values = { ...(seed.values ?? {}) };
    this.modelProviders = seed.modelProviders ?? {};
  }

  getValue(key: string): unknown {
    if (key === 'modelProviders') return this.modelProviders;
    const providerId = modelProvidersSubKey(key);
    if (providerId !== undefined) return this.modelProviders[providerId];
    return this.values[key];
  }

  setValue(key: string, value: unknown): void {
    if (key === 'modelProviders') {
      this.modelProviders = value as ModelProvidersConfig;
      return;
    }
    const providerId = modelProvidersSubKey(key);
    if (providerId !== undefined) {
      this.modelProviders = {
        ...this.modelProviders,
        [providerId]: value as ModelProvidersConfig[string],
      };
      return;
    }
    this.values[key] = value;
  }

  /**
   * Reflects the seeded map plus both whole-map writes and dotted
   * `modelProviders.<authType>` writes. `applyProviderInstallPlan` patches
   * per-provider entries via the dotted form and then reads this back to
   * verify the installed models won, so dotted writes must land here.
   */
  getModelProviders(): ModelProvidersConfig {
    return this.modelProviders;
  }

  persist(): void {}
  backup(): void {}
  restore(): void {}
  cleanupBackup(): void {}
}
