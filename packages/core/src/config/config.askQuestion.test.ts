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

describe('Config askQuestion menu enforcement', () => {
  it('defaults to true when unset', () => {
    expect(makeConfig().getAskQuestionMenuEnforced()).toBe(true);
  });

  it('respects an explicit false', () => {
    expect(
      makeConfig({ enforceAskQuestion: false }).getAskQuestionMenuEnforced(),
    ).toBe(false);
  });
});
