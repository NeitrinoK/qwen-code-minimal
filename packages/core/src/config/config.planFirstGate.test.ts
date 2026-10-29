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

describe('Config plan-first gate state', () => {
  it('getPlanFirstGateEnabled defaults to true when unset', () => {
    expect(makeConfig().getPlanFirstGateEnabled()).toBe(true);
  });

  it('getPlanFirstGateEnabled respects an explicit false', () => {
    expect(makeConfig({ planFirstGate: false }).getPlanFirstGateEnabled()).toBe(
      false,
    );
  });

  it('hasInvokedSkill reflects markSkillInvoked', () => {
    const config = makeConfig();
    expect(config.hasInvokedSkill('superpowers:writing-plans')).toBe(false);
    config.markSkillInvoked('superpowers:writing-plans');
    expect(config.hasInvokedSkill('superpowers:writing-plans')).toBe(true);
    // unrelated skill stays unmarked
    expect(config.hasInvokedSkill('superpowers:brainstorming')).toBe(false);
  });

  it('plan gate override is off by default and settable', () => {
    const config = makeConfig();
    expect(config.getPlanGateOverride()).toBe(false);
    config.setPlanGateOverride(true);
    expect(config.getPlanGateOverride()).toBe(true);
  });
});
