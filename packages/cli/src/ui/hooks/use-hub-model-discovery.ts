/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useRef, useState } from 'react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { ModelProvidersConfig } from '@qwen-code/qwen-code-core/models/types.js';
import type { ProviderConfig } from '@qwen-code/qwen-code-core/providers/types.js';
import { applyProviderInstallPlan } from '@qwen-code/qwen-code-core/providers/install.js';
import { buildInstallPlan } from '@qwen-code/qwen-code-core/providers/provider-config.js';
import {
  findDiscoverableProviderByBaseUrl,
  findProviderByCredentials,
} from '@qwen-code/qwen-code-core/providers/all-providers.js';
import { isAuthTokenError } from '@qwen-code/qwen-code-core/utils/errorParsing.js';
import { listProviderModelIds } from '@qwen-code/qwen-code-core/providers/discover-models.js';
import { InMemoryProviderSettingsAdapter } from '../../config/in-memory-provider-settings-adapter.js';

// 'auth_error' is a token/401 rejection (invalid or expired key) — the caller
// shows renewal help instead of the stale "last known models" list.
export type DiscoveryState = 'idle' | 'loading' | 'error' | 'auth_error';

export interface HubDiscoveryResult {
  state: DiscoveryState;
  /** Increments after a successful reload so consumers can recompute memoized lists. */
  refreshToken: number;
  /** Label of the hub being discovered (e.g. "Acme Hub" / "Acme Hub Stage"). */
  hubLabel: string;
}

interface HubDiscoveryEligibility {
  baseUrl: string;
  apiKey: string;
  provider: ProviderConfig;
}

/**
 * All-synchronous eligibility check: is `config` currently pointed at a
 * hub with an API key resolved? Kept separate from {@link refreshHubModels}
 * so the hook can decide its *initial* render state (loading vs. idle)
 * without waiting for a tick — every input here is a plain synchronous
 * getter, no network I/O involved. Swallows getter errors (e.g. an
 * incomplete `Config` in tests) and treats them as "not eligible" rather
 * than throwing, since this also runs during render.
 *
 * Returns the resolved `baseUrl`/`apiKey`/`provider` (instead of a bare
 * boolean) so callers don't have to re-resolve the same values a second
 * time.
 */
function isHubDiscoveryEligible(
  config: Config,
): HubDiscoveryEligibility | null {
  try {
    const cg = config.getContentGeneratorConfig();
    const baseUrl = cg?.baseUrl;
    if (!baseUrl) return null;
    // Prefer an exact credentials match, but fall back to recognizing the hub
    // by its base URL alone — so every configured hub endpoint is
    // discovered even when the key is under a different env var (or none), and
    // a trailing slash on the base URL no longer defeats discovery.
    const provider =
      findProviderByCredentials(baseUrl, cg?.apiKeyEnvKey) ??
      findDiscoverableProviderByBaseUrl(baseUrl);
    if (!provider?.discoverModels) return null;
    const apiKey = cg?.apiKey;
    if (!apiKey) return null;
    return { baseUrl, apiKey, provider };
  } catch {
    return null;
  }
}

/**
 * Fetch fresh hub model IDs and hot-reload them into the session registry
 * without persisting. Returns:
 *  - 'idle'  → not a hub, or no API key: caller keeps today's behavior
 *  - 'ready' → registry refreshed from the hub
 *  - 'error' → fetch failed; caller shows the cached list + note
 *  - 'auth_error' → the hub rejected the token (401); caller shows renewal help
 */
export async function refreshHubModels(
  config: Config,
  currentModelProviders: ModelProvidersConfig,
): Promise<'idle' | 'ready' | 'error' | 'auth_error'> {
  const eligible = isHubDiscoveryEligible(config);
  if (!eligible) return 'idle';
  const { baseUrl, apiKey, provider } = eligible;

  let ids: string[];
  try {
    ids = await listProviderModelIds({
      baseUrl,
      apiKey,
      proxy: config.getProxy(),
      noProxy: config.getNoProxy(),
      caCertificates: config.getCaCertificates(),
    });
  } catch (e) {
    // Distinguish an invalid/expired-token rejection (401) from a
    // transport/reachability failure so the picker can show the right message.
    const err = e as { status?: number; message?: string };
    return isAuthTokenError({ status: err?.status, message: err?.message })
      ? 'auth_error'
      : 'error';
  }
  if (ids.length === 0) return 'error';

  try {
    const adapter = new InMemoryProviderSettingsAdapter({
      modelProviders: { ...currentModelProviders },
    });
    const plan = buildInstallPlan(provider, {
      baseUrl,
      apiKey,
      modelIds: ids,
    });

    const result = await applyProviderInstallPlan(plan, {
      settings: adapter,
      // Discovery only refreshes the model *list* for the picker; it must
      // not switch the user's active model/auth or touch disk.
      doRefreshAuth: false,
    });
    config.reloadModelProvidersConfig(result.updatedModelProviders);
    return 'ready';
  } catch {
    return 'error';
  }
}

/**
 * React wrapper: runs refreshHubModels once on mount. While the async work is
 * in flight `state` is 'loading'; on completion it settles to 'idle' (nothing
 * to show differently) or 'error'. `refreshToken` bumps on a successful reload.
 */
export function useHubModelDiscovery(
  config: Config | undefined,
  currentModelProviders: ModelProvidersConfig,
): HubDiscoveryResult {
  // Eligibility is fully synchronous (see isHubDiscoveryEligible), so it can
  // gate the *initial* state directly: only hub-eligible configs start
  // 'loading'. Everyone else (no config, non-hub provider, no API key) stays
  // 'idle' from the first render instead of flashing a loading state that
  // resolves to 'idle' a tick later.
  const eligibility = config ? isHubDiscoveryEligible(config) : null;
  const eligible = eligibility !== null;
  const hubLabel = eligibility?.provider.label ?? 'model hub';
  const [state, setState] = useState<DiscoveryState>(
    eligible ? 'loading' : 'idle',
  );
  const [refreshToken, setRefreshToken] = useState(0);
  const ranRef = useRef(false);

  useEffect(() => {
    if (!config || !eligible || ranRef.current) return;
    ranRef.current = true;
    let cancelled = false;
    void (async () => {
      const outcome = await refreshHubModels(config, currentModelProviders);
      if (cancelled) return;
      if (outcome === 'ready') {
        setRefreshToken((n) => n + 1);
        setState('idle');
      } else if (outcome === 'error' || outcome === 'auth_error') {
        setState(outcome);
      } else {
        setState('idle');
      }
    })();
    return () => {
      cancelled = true;
    };
    // Deps are [config, eligible]; the ranRef guard above makes this run
    // once per mount even though currentModelProviders is omitted (it's
    // captured at open time and intentionally not a re-run trigger).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, eligible]);

  return { state, refreshToken, hubLabel };
}
