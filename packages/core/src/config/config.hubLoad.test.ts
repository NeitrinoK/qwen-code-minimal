/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { Config, type ConfigParameters } from './config.js';
import { HUB_LOAD_DEFAULTS } from '../hub/load-metrics.js';

function makeConfig(hubLoadPill?: ConfigParameters['hubLoadPill']): Config {
  return new Config({
    cwd: '/tmp',
    targetDir: '/tmp',
    debugMode: false,
    model: 'test-model',
    hubLoadPill,
  });
}

describe('getHubLoadSettings', () => {
  it('is undefined when no load pill is configured', () => {
    expect(makeConfig().getHubLoadSettings()).toBeUndefined();
    expect(
      makeConfig({
        dashboardBaseUrl: '',
        dashboardToken: 't',
      }).getHubLoadSettings(),
    ).toBeUndefined();
  });

  it('applies defaults over a configured pill', () => {
    const s = makeConfig({
      dashboardBaseUrl: 'https://grafana.example.com',
      dashboardToken: 'tok',
      queueWarn: 5,
    }).getHubLoadSettings();
    expect(s).toEqual({
      ...HUB_LOAD_DEFAULTS,
      dashboardBaseUrl: 'https://grafana.example.com',
      dashboardToken: 'tok',
      queueWarn: 5,
    });
  });
});
