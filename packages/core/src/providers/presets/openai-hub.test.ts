/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  buildHubProviders,
  isHubProvider,
  HUB_DEFAULT_ENV_KEY,
} from './openai-hub.js';
import {
  ALL_PROVIDERS,
  setHubProviders,
  findProviderById,
  findDiscoverableProviderByBaseUrl,
} from '../all-providers.js';

const hub = {
  label: 'Acme Hub',
  endpoints: [
    { name: 'prod', baseUrl: 'https://hub.example.com/v1/' },
    { name: 'stage', baseUrl: 'https://stage.hub.example.com/v1' },
  ],
  envKey: 'ACME_KEY',
  models: [{ id: 'm1', contextWindowSize: 1000 }],
};

describe('buildHubProviders', () => {
  it('returns [] for missing or malformed settings', () => {
    expect(buildHubProviders(undefined)).toEqual([]);
    expect(buildHubProviders({ endpoints: hub.endpoints })).toEqual([]);
    expect(buildHubProviders({ label: 'X', endpoints: [] })).toEqual([]);
    expect(
      buildHubProviders({
        label: 'X',
        endpoints: [{ name: 'a', baseUrl: '' }],
      }),
    ).toEqual([]);
  });

  it.each([
    ['label: 5', { label: 5, endpoints: [{ baseUrl: 'https://a/v1' }] }],
    ['endpoints: string', { label: 'X', endpoints: 'a' }],
    ['endpoints: object', { label: 'X', endpoints: {} }],
    ['endpoint baseUrl: 5', { label: 'X', endpoints: [{ baseUrl: 5 }] }],
    ['endpoint null', { label: 'X', endpoints: [null] }],
  ])('does not throw on malformed hub (%s)', (_n, bad) => {
    expect(() => buildHubProviders(bad as never)).not.toThrow();
    expect(buildHubProviders(bad as never)).toEqual([]);
  });

  it('keeps only the valid endpoint next to malformed ones', () => {
    const ps = buildHubProviders({
      label: 'X',
      endpoints: [null, { baseUrl: 5 }, { name: 7, baseUrl: 'https://ok/v1' }],
      envKey: 5,
      docsUrl: 5,
      modelNamePrefix: 5,
      models: 'nope',
    } as never);
    expect(ps).toHaveLength(1);
    expect(ps[0].baseUrl).toBe('https://ok/v1');
    expect(ps[0].envKey).toBe(HUB_DEFAULT_ENV_KEY);
    expect(ps[0].models).toBeUndefined();
    expect(ps[0].documentationUrl).toBeUndefined();
  });

  it('builds one provider per endpoint with stable ids and labels', () => {
    const ps = buildHubProviders(hub);
    expect(ps.map((p) => p.id)).toEqual(['openai-hub', 'openai-hub-stage']);
    expect(ps.map((p) => p.label)).toEqual(['Acme Hub', 'Acme Hub (stage)']);
    expect(ps[0].baseUrl).toBe('https://hub.example.com/v1');
    expect(ps[0].envKey).toBe('ACME_KEY');
    expect(ps[0].discoverModels).toBe(true);
    expect(ps[0].models?.[0].id).toBe('m1');
    expect(ps.every(isHubProvider)).toBe(true);
  });

  it('defaults envKey and dedupes endpoint names', () => {
    const ps = buildHubProviders({
      label: 'H',
      endpoints: [
        { name: 'a', baseUrl: 'https://a/v1' },
        { name: 'a', baseUrl: 'https://b/v1' },
      ],
    });
    expect(ps[0].envKey).toBe(HUB_DEFAULT_ENV_KEY);
    expect(new Set(ps.map((p) => p.id)).size).toBe(2);
  });

  it('respects discoverModels: false', () => {
    expect(
      buildHubProviders({ ...hub, discoverModels: false })[0].discoverModels,
    ).toBe(false);
  });
});

describe('hub registry', () => {
  afterEach(() => setHubProviders([]));

  it('registers hub providers ahead of built-ins and replaces on re-register', () => {
    const before = ALL_PROVIDERS.length;
    setHubProviders(buildHubProviders(hub));
    expect(ALL_PROVIDERS.length).toBe(before + 2);
    expect(ALL_PROVIDERS[0].id).toBe('openai-hub');
    expect(findProviderById('openai-hub-stage')?.label).toBe(
      'Acme Hub (stage)',
    );
    expect(
      findDiscoverableProviderByBaseUrl('https://hub.example.com/v1/')?.id,
    ).toBe('openai-hub');
    setHubProviders([]);
    expect(ALL_PROVIDERS.length).toBe(before);
  });
});
