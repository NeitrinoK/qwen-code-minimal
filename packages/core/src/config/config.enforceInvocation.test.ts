/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { Config } from './config.js';

// Minimal Config construction mirrors the sibling `makeConfig` helper in
// config.hubLoad.test.ts, adding only the `skillEnforceInvocation` field.
function makeConfig(skillEnforceInvocation?: boolean): Config {
  return new Config({
    cwd: '/tmp',
    targetDir: '/tmp',
    debugMode: false,
    model: 'test-model',
    skillEnforceInvocation,
  });
}

describe('getSkillEnforcementEnabled', () => {
  it('defaults to true when unset', () => {
    expect(makeConfig().getSkillEnforcementEnabled()).toBe(true);
  });
  it('respects an explicit false', () => {
    expect(makeConfig(false).getSkillEnforcementEnabled()).toBe(false);
  });
  it('respects an explicit true', () => {
    expect(makeConfig(true).getSkillEnforcementEnabled()).toBe(true);
  });
});
