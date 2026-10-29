/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { SkillTool } from './skill.js';
import type { Config } from '../config/config.js';

// A minimal Config test double capturing markSkillInvoked calls and
// providing the getters skill.ts touches on the success path.
//
// Additions beyond the brief's literal mock (see task-4-report.md for why):
// - skillManager.addChangeListener: the SkillTool constructor calls this
//   synchronously and unconditionally; without it `new SkillTool(config)`
//   throws immediately (TypeError: not a function).
// - skillManager.isSkillActive: collectAvailableSkillEntries (invoked by
//   refreshSkills) calls this to filter the active skill set. Without it,
//   the call throws inside refreshSkills's try/catch, silently resetting
//   availableSkills to [] — so the target skill would never validate.
// - config.getModelInvocableCommandsProvider: also read by
//   collectAvailableSkillEntries; same failure mode as isSkillActive above.
function makeConfigDouble() {
  const invoked = new Set<string>();
  const skill = {
    name: 'superpowers:writing-plans',
    description: 'Writing plans',
    body: 'plan body',
    filePath: '/skills/superpowers-writing-plans/SKILL.md',
    allowedTools: undefined,
    hooks: undefined,
    model: undefined,
  };
  const skillManager = {
    loadSkillForRuntime: vi.fn().mockResolvedValue(skill),
    getParseErrors: vi.fn().mockReturnValue(new Map()),
    listSkills: vi.fn().mockResolvedValue([skill]),
    getCachedSkills: vi.fn().mockReturnValue([skill]),
    recordCatalogSize: vi.fn(),
    isSkillActive: vi.fn().mockReturnValue(true),
    addChangeListener: vi.fn().mockReturnValue(() => {}),
  };
  const config = {
    getSkillManager: () => skillManager,
    getDisabledSkillNames: () => new Set<string>(),
    isSkillEnabled: () => true,
    getModelInvocableCommandsProvider: () => undefined,
    getModelInvocableCommandsExecutor: () => undefined,
    getPermissionManager: () => undefined,
    getHookSystem: () => undefined,
    getSessionId: () => 'sid',
    getProjectRoot: () => '/repo',
    getTelemetryEnabled: () => false,
    getUsageStatisticsEnabled: () => false,
    getContentGeneratorConfig: () => ({}),
    markSkillInvoked: (name: string) => invoked.add(name),
    hasInvokedSkill: (name: string) => invoked.has(name),
  } as unknown as Config;
  return { config, invoked, skillManager };
}

describe('SkillTool marks the plan-first lift skill', () => {
  it('records superpowers:writing-plans on successful load', async () => {
    const { config, invoked } = makeConfigDouble();
    const tool = new SkillTool(config);
    // The constructor kicks off `refreshSkills()` without awaiting it
    // (fire-and-forget, so construction stays synchronous). Await it
    // explicitly here so `availableSkills` is populated before `build()`
    // validates — otherwise validateToolParams sees an empty skill set and
    // `build()` throws "not found" before we ever reach execute().
    await tool.refreshSkills();

    const invocation = tool.build({ skill: 'superpowers:writing-plans' });
    await invocation.execute(new AbortController().signal);

    expect(invoked.has('superpowers:writing-plans')).toBe(true);
  });
});
