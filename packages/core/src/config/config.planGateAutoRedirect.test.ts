/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Config, type ConfigParameters } from './config.js';

function makeConfig(): Config {
  return new Config({
    sessionId: 'test-session',
    targetDir: process.cwd(),
    debugMode: false,
    cwd: process.cwd(),
    model: 'test-model',
  } as ConfigParameters);
}

describe('Config plan-gate auto-redirect counter', () => {
  it('starts at 0 and increments on mark', () => {
    const config = makeConfig();
    expect(config.getPlanGateAutoRedirectCount()).toBe(0);
    config.markPlanGateAutoRedirect();
    expect(config.getPlanGateAutoRedirectCount()).toBe(1);
    config.markPlanGateAutoRedirect();
    expect(config.getPlanGateAutoRedirectCount()).toBe(2);
  });

  it('is independent of the plan gate override', () => {
    const config = makeConfig();
    config.markPlanGateAutoRedirect();
    expect(config.getPlanGateOverride()).toBe(false);
  });
});
