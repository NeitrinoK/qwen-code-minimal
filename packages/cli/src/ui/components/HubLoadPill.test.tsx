/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { buildHubProviders, setHubProviders } from '@qwen-code/qwen-code-core';
import { ConfigContext } from '../contexts/ConfigContext.js';

const fetchHubLoad = vi.fn();
vi.mock('@qwen-code/qwen-code-core/hub/load-metrics.js', () => ({
  fetchHubLoad: (...a: unknown[]) => fetchHubLoad(...a),
}));

import {
  HubLoadPill,
  getHubLoadEligibility,
  useFooterHubLoad,
  computeHubLoadEntries,
  formatTierLoad,
} from './HubLoadPill.js';

describe('computeHubLoadEntries', () => {
  it('active model → a single entry for it', () => {
    expect(
      computeHubLoadEntries({
        activeModelId: 'deepseek-ai/DeepSeek-V4-Flash',
      }),
    ).toEqual([{ key: 'active', modelId: 'deepseek-ai/DeepSeek-V4-Flash' }]);
  });

  it('no active model → empty', () => {
    expect(computeHubLoadEntries({ activeModelId: '' })).toEqual([]);
  });
});

describe('formatTierLoad', () => {
  it('formats present values', () => {
    expect(formatTierLoad({ active: 11, queue: 157 })).toEqual({
      active: '11',
      queue: '157',
    });
  });
  it('renders dim dash for missing values', () => {
    expect(formatTierLoad(undefined)).toEqual({ active: '–', queue: '–' });
    expect(formatTierLoad({ active: 4 })).toEqual({ active: '4', queue: '–' });
  });
});

describe('HubLoadPill', () => {
  const activeEntry = [
    { key: 'active', modelId: 'deepseek-ai/DeepSeek-V4-Flash' },
  ];
  const snapshot = new Map([
    ['deepseek-ai/DeepSeek-V4-Flash', { active: 11, queue: 157 }],
    ['Qwen/Qwen3.6-27B', { active: 40, queue: 0 }],
  ]);

  it('shows the active model’s active + queue load', () => {
    const { lastFrame } = render(
      <HubLoadPill
        state={{ snapshot, stale: false }}
        entries={activeEntry}
        queueWarn={20}
      />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('11');
    expect(f).toContain('157');
    // … but not any other model's load.
    expect(f).not.toContain('40');
  });

  it('renders a dash for a model absent from the snapshot', () => {
    const { lastFrame } = render(
      <HubLoadPill
        state={{ snapshot: new Map(), stale: false }}
        entries={activeEntry}
        queueWarn={20}
      />,
    );
    expect(lastFrame() ?? '').toContain('–');
  });
});

const HUB_URL = 'https://hub.example.com/openai/v1';
const loadSettings = {
  dashboardBaseUrl: 'https://grafana.example.com',
  dashboardToken: 'tok',
  activePanelId: 7,
  queuePanelId: 8,
  refreshMs: 15000,
  staleMs: 60000,
  queueWarn: 20,
};

function makeConfig(
  baseUrl: string,
  settings: typeof loadSettings | undefined,
) {
  return {
    getHubLoadSettings: () => settings,
    getContentGeneratorConfig: () => ({
      apiKey: 'sk',
      apiKeyEnvKey: 'HUB_API_KEY',
      baseUrl,
    }),
    getModel: () => 'm',
    getProxy: () => undefined,
    getNoProxy: () => [],
    getCaCertificates: () => [],
  } as never;
}

describe('getHubLoadEligibility', () => {
  beforeEach(() => {
    fetchHubLoad.mockReset();
    fetchHubLoad.mockResolvedValue(null);
    setHubProviders(
      buildHubProviders({
        label: 'Test Hub',
        endpoints: [{ name: 'prod', baseUrl: HUB_URL }],
      }),
    );
  });
  afterEach(() => setHubProviders([]));

  it('is eligible for a hub provider with a load pill configured', () => {
    expect(getHubLoadEligibility(makeConfig(HUB_URL, loadSettings))).toEqual({
      settings: loadSettings,
    });
  });

  it('is undefined for a non-hub provider', () => {
    expect(
      getHubLoadEligibility(makeConfig('https://example.com/v1', loadSettings)),
    ).toBeUndefined();
  });

  it('is undefined and never fetches when a hub is active but no loadPill is set', async () => {
    const config = makeConfig(HUB_URL, undefined);
    expect(getHubLoadEligibility(config)).toBeUndefined();
    const Probe = () => {
      useFooterHubLoad();
      return <Text>probe</Text>;
    };
    const { unmount } = render(
      <ConfigContext.Provider value={config}>
        <Probe />
      </ConfigContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    unmount();
    expect(fetchHubLoad).not.toHaveBeenCalled();
  });
});
