/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Text } from 'ink';
import type {
  HubLoad,
  HubLoadSnapshot,
} from '@qwen-code/qwen-code-core/hub/load-metrics.js';
import type {
  HubLoadSettings,
  Config,
} from '@qwen-code/qwen-code-core/config/config.js';
import { fetchHubLoad } from '@qwen-code/qwen-code-core/hub/load-metrics.js';
import {
  findDiscoverableProviderByBaseUrl,
  findProviderByCredentials,
} from '@qwen-code/qwen-code-core/providers/all-providers.js';
import { isHubProvider } from '@qwen-code/qwen-code-core/providers/presets/openai-hub.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { theme } from '../semantic-colors.js';

export interface HubLoadState {
  snapshot: HubLoadSnapshot | null;
  stale: boolean;
}

/** One pill to render: the model id to look up in the snapshot. */
export interface HubLoadEntry {
  key: string;
  modelId: string;
}

/**
 * Which model the load pill shows: the active model that is serving requests.
 * Pure.
 */
export function computeHubLoadEntries(input: {
  activeModelId: string;
}): HubLoadEntry[] {
  return input.activeModelId
    ? [{ key: 'active', modelId: input.activeModelId }]
    : [];
}

export function getHubLoadEligibility(
  config: Config | undefined,
): { settings: HubLoadSettings } | undefined {
  try {
    if (!config) return undefined;
    const settings = config.getHubLoadSettings();
    if (!settings) return undefined;
    const cg = config.getContentGeneratorConfig();
    if (!cg?.baseUrl) return undefined;
    const provider =
      findProviderByCredentials(cg.baseUrl, cg.apiKeyEnvKey) ??
      findDiscoverableProviderByBaseUrl(cg.baseUrl);
    if (!isHubProvider(provider)) return undefined;
    return { settings };
  } catch {
    return undefined;
  }
}

export function formatTierLoad(load: HubLoad | undefined): {
  active: string;
  queue: string;
} {
  const num = (v: number | undefined) =>
    typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '–';
  return { active: num(load?.active), queue: num(load?.queue) };
}

export function useFooterHubLoad():
  | {
      state: HubLoadState;
      entries: HubLoadEntry[];
      queueWarn: number;
    }
  | undefined {
  const config = useConfig();
  const eligible = getHubLoadEligibility(config);
  const [state, setState] = useState<HubLoadState>({
    snapshot: null,
    stale: false,
  });
  const lastOkRef = useRef<number>(0);

  useEffect(() => {
    if (!config || !eligible) return;
    let cancelled = false;
    const controller = new AbortController();
    const { settings } = eligible;

    const poll = async () => {
      const snap = await fetchHubLoad({
        baseUrl: settings.dashboardBaseUrl,
        token: settings.dashboardToken,
        activePanelId: settings.activePanelId,
        queuePanelId: settings.queuePanelId,
        proxy: config.getProxy(),
        noProxy: config.getNoProxy(),
        caCertificates: config.getCaCertificates(),
        signal: controller.signal,
      });
      if (cancelled) return;
      if (snap) {
        lastOkRef.current = Date.now();
        setState({ snapshot: snap, stale: false });
      } else {
        setState((prev) => ({
          snapshot: prev.snapshot,
          stale: Date.now() - lastOkRef.current > settings.staleMs,
        }));
      }
    };

    void poll();
    const id = setInterval(() => void poll(), settings.refreshMs);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, !!eligible]);

  if (!eligible) return undefined;
  const entries = computeHubLoadEntries({
    activeModelId: config?.getModel?.() ?? '',
  });
  return { state, entries, queueWarn: eligible.settings.queueWarn };
}

export const HubLoadPill: React.FC<{
  state: HubLoadState;
  entries: HubLoadEntry[];
  queueWarn: number;
}> = ({ state, entries, queueWarn }) => {
  if (entries.length === 0) return null;
  const dim = state.stale;
  return (
    <Text>
      {entries.map((entry, i) => {
        const load = state.snapshot?.get(entry.modelId);
        const { active, queue } = formatTierLoad(load);
        const queueHot =
          !dim && typeof load?.queue === 'number' && load.queue >= queueWarn;
        return (
          <Text key={entry.key} color={dim ? theme.text.secondary : undefined}>
            {i > 0 ? '  ' : ''}▶{active} ⏳
            <Text color={queueHot ? theme.status.error : undefined}>
              {queue}
            </Text>
          </Text>
        );
      })}
    </Text>
  );
};
