/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Config, type ConfigParameters } from './config.js';

function makeConfig(overrides: Partial<ConfigParameters> = {}): Config {
  return new Config({
    sessionId: 'test-session',
    targetDir: process.cwd(),
    debugMode: false,
    cwd: process.cwd(),
    model: 'test-model',
    ...overrides,
  } as ConfigParameters);
}

describe('Config writing-plans enforcement', () => {
  it('defaults to true when unset', () => {
    expect(makeConfig().getWritingPlansEnforced()).toBe(true);
  });

  it('respects an explicit false', () => {
    expect(
      makeConfig({ enforceWritingPlans: false }).getWritingPlansEnforced(),
    ).toBe(false);
  });
});
