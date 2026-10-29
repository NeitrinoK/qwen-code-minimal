/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Provider registry — imports all provider definitions and assembles the
 * lookup tables used by the UI and CLI commands.
 */

import { providerMatchesCredentials } from './provider-config.js';
import type { ProviderConfig } from './types.js';
import { requestyProvider } from './presets/requesty.js';
import { grokProvider } from './presets/grok.js';
import { customProvider } from './presets/custom-provider.js';

// Re-export all providers
export { requestyProvider, grokProvider, customProvider };
export {
  CUSTOM_API_KEY_ENV_PREFIX,
  generateCustomEnvKey,
} from './presets/custom-provider.js';

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

// Adding a provider that reads credentials from a new env key? Also add that
// key to the no-AK gate's cleared-env list in .github/workflows/ci.yml and to
// scripts/tests/no-ak-integration-ci.test.js, or the gate can leak runner creds.
const BUILT_IN_PROVIDERS: readonly ProviderConfig[] = [
  grokProvider,
  requestyProvider,
  customProvider,
];

/**
 * All known providers, in display order: configured hub endpoints first.
 * The list is mutated by `setHubProviders` after startup, so consumers must
 * read it at call time and must not snapshot it at import.
 */
export const ALL_PROVIDERS: readonly ProviderConfig[] = [...BUILT_IN_PROVIDERS];

/** Replace the configured hub providers (see `buildHubProviders`). */
export function setHubProviders(providers: readonly ProviderConfig[]): void {
  const list = ALL_PROVIDERS as ProviderConfig[];
  list.splice(0, list.length, ...providers, ...BUILT_IN_PROVIDERS);
}

export function findProviderById(id: string): ProviderConfig | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}

/** Find a provider by model credentials (baseUrl + envKey). */
export function findProviderByCredentials(
  baseUrl: string | undefined,
  envKey: string | undefined,
): ProviderConfig | undefined {
  return ALL_PROVIDERS.find((p) =>
    providerMatchesCredentials(p, baseUrl, envKey),
  );
}

/**
 * Find a discoverable provider (`discoverModels: true`) by base URL alone,
 * ignoring the env-key and any trailing slash. Used by `/model` discovery so
 * every configured hub endpoint is recognised from the active base URL
 * regardless of which env var holds the key.
 */
export function findDiscoverableProviderByBaseUrl(
  baseUrl: string | undefined,
): ProviderConfig | undefined {
  if (!baseUrl) return undefined;
  const norm = (u: string): string => u.replace(/\/+$/, '');
  const target = norm(baseUrl);
  return ALL_PROVIDERS.find((p) => {
    if (!p.discoverModels) return false;
    if (typeof p.baseUrl === 'string') return norm(p.baseUrl) === target;
    if (Array.isArray(p.baseUrl))
      return p.baseUrl.some((o: { url: string }) => norm(o.url) === target);
    return false;
  });
}

/** All known provider base URLs (for preconnect, validation, etc.). */
export function getAllProviderBaseUrls(): string[] {
  return ALL_PROVIDERS.flatMap((p) => {
    if (typeof p.baseUrl === 'string') return [p.baseUrl];
    if (Array.isArray(p.baseUrl))
      return p.baseUrl.map((o: { url: string }) => o.url);
    return [];
  });
}
