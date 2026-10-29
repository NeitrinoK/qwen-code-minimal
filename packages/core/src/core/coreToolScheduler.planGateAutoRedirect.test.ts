/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Config, ToolRegistry } from '../index.js';
import {
  ApprovalMode,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
} from '../index.js';
import { ToolNames } from '../tools/tool-names.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { CoreToolScheduler } from './coreToolScheduler.js';
import type { ToolCall, WaitingToolCall } from './coreToolScheduler.js';
import {
  BRAINSTORMING_SKILL,
  PLAN_GATE_SKILL,
  PLAN_GATE_AUTO_REDIRECT_MESSAGE,
} from './planFirstGate.js';

/**
 * Stateful mock Config that backs the gate methods with real state, mirroring
 * coreToolScheduler.planFirstGate.test.ts's `makeGateConfig`, plus the
 * auto-redirect counter (Task 2) and a `hasInvokedSkill` Set seeded per test.
 */
interface GateConfigOptions {
  gateEnabled?: boolean;
  interactive?: boolean;
  approvalMode?: ApprovalMode;
  /** Skills to seed as already-invoked (e.g. BRAINSTORMING_SKILL). */
  invokedSkills?: string[];
  /** Seed the per-session auto-redirect counter (e.g. the cap of 2). */
  autoRedirectCount?: number;
}

function makeGateConfig(options: GateConfigOptions = {}) {
  const state = {
    gateEnabled: options.gateEnabled ?? true,
    interactive: options.interactive ?? true,
    approvalMode: options.approvalMode ?? ApprovalMode.DEFAULT,
    planGateOverride: false,
    invokedSkills: new Set<string>(options.invokedSkills ?? []),
    autoRedirectCount: options.autoRedirectCount ?? 0,
  };

  const registry = {
    getTool: () => undefined,
    ensureTool: async () => undefined,
    getFunctionDeclarations: () => [],
    tools: new Map(),
    discovery: {},
    registerTool: () => {},
    getToolByName: () => undefined,
    getToolByDisplayName: () => undefined,
    getTools: () => [],
    discoverTools: async () => {},
    getAllTools: () => [],
    getToolsByServer: () => [],
  } as unknown as ToolRegistry;

  const config = {
    getSessionId: () => 'test-session-id',
    getUsageStatisticsEnabled: () => false,
    getDebugMode: () => false,
    getApprovalMode: () => state.approvalMode,
    getPermissionsAllow: () => [],
    getContentGeneratorConfig: () => ({
      model: 'test-model',
      authType: 'gemini',
    }),
    getShellExecutionConfig: () => ({
      terminalWidth: 90,
      terminalHeight: 30,
    }),
    storage: {
      getProjectTempDir: () => '/tmp',
    },
    getTruncateToolOutputThreshold: () =>
      DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
    getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
    getToolRegistry: () => registry,
    getUseModelRouter: () => false,
    getGeminiClient: () => null,
    getIdeMode: () => false,
    getInputFormat: () => undefined,
    getExperimentalZedIntegration: () => false,
    getChatRecordingService: () => undefined,
    getMessageBus: vi.fn().mockReturnValue(undefined),
    getDisableAllHooks: vi.fn().mockReturnValue(true),
    getConditionalRulesRegistry: () => undefined,
    getSkillManager: () => undefined,
    addInlineAnnouncedSkillKeys: () => {},
    // ── Plan-first gate surface (Task 1) ──
    isInteractive: () => state.interactive,
    getPlanFirstGateEnabled: () => state.gateEnabled,
    getPlanGateOverride: () => state.planGateOverride,
    setPlanGateOverride: (value: boolean) => {
      state.planGateOverride = value;
    },
    hasInvokedSkill: (name: string) => state.invokedSkills.has(name),
    markSkillInvoked: (name: string) => {
      state.invokedSkills.add(name);
    },
    // ── Auto-redirect counter (Task 2), backed by real state ──
    getPlanGateAutoRedirectCount: () => state.autoRedirectCount,
    markPlanGateAutoRedirect: () => {
      state.autoRedirectCount++;
    },
  } as unknown as Config;

  return { config, state };
}

function makeScheduler(config: Config) {
  const onAllToolCallsComplete: Mock = vi.fn();
  const onToolCallsUpdate: Mock = vi.fn();
  const registry = config.getToolRegistry() as unknown as {
    getTool: (name: string) => unknown;
    ensureTool: (name: string) => Promise<unknown>;
  };
  const writeTool = new MockTool({
    name: ToolNames.WRITE_FILE,
    execute: async () => ({
      llmContent: 'wrote file',
      returnDisplay: 'wrote file',
    }),
  });
  registry.getTool = (name: string) =>
    name === ToolNames.WRITE_FILE ? writeTool : undefined;
  registry.ensureTool = async (name: string) =>
    name === ToolNames.WRITE_FILE ? writeTool : undefined;

  const scheduler = new CoreToolScheduler({
    config,
    onAllToolCallsComplete,
    onToolCallsUpdate,
    getPreferredEditor: () => 'vscode',
    onEditorClose: vi.fn(),
  });
  return { scheduler, onAllToolCallsComplete, onToolCallsUpdate };
}

async function scheduleWrite(
  scheduler: CoreToolScheduler,
  signal: AbortSignal,
  filePath: string,
  callId = 'call-1',
) {
  await scheduler.schedule(
    [
      {
        callId,
        name: ToolNames.WRITE_FILE,
        args: { file_path: filePath, content: 'x' },
        isClientInitiated: false,
        prompt_id: `prompt-${callId}`,
      },
    ],
    signal,
  );
}

function snapshotsFor(onToolCallsUpdate: Mock, callId: string): ToolCall[] {
  return onToolCallsUpdate.mock.calls
    .flatMap((call) => call[0] as ToolCall[])
    .filter((tc) => tc.request.callId === callId);
}

function sawStatus(
  onToolCallsUpdate: Mock,
  callId: string,
  status: ToolCall['status'],
): boolean {
  return snapshotsFor(onToolCallsUpdate, callId).some(
    (tc) => tc.status === status,
  );
}

function latestSnapshot(
  onToolCallsUpdate: Mock,
  callId: string,
): ToolCall | undefined {
  const snaps = snapshotsFor(onToolCallsUpdate, callId);
  return snaps[snaps.length - 1];
}

describe('coreToolScheduler plan-gate auto-redirect', () => {
  it('auto-denies a gated write with the redirect message when brainstorming is active (no prompt)', async () => {
    // brainstorming invoked, writing-plans NOT, enabled, interactive,
    // autoRedirectCount 0.
    const { config, state } = makeGateConfig({
      invokedSkills: [BRAINSTORMING_SKILL],
    });
    const { scheduler, onAllToolCallsComplete, onToolCallsUpdate } =
      makeScheduler(config);
    await scheduleWrite(
      scheduler,
      new AbortController().signal,
      '/repo/src/foo.ts',
    );

    await vi.waitFor(() => expect(onAllToolCallsComplete).toHaveBeenCalled());
    const completed = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    const call = completed.find((c) => c.request.callId === 'call-1');

    // Ends in 'error' with the model-facing redirect message.
    expect(call?.status).toBe('error');
    const text = JSON.stringify(
      (call as { response?: unknown } | undefined)?.response,
    );
    expect(text).toContain(PLAN_GATE_AUTO_REDIRECT_MESSAGE);

    // Never opened the Yes/No confirmation, never executed.
    expect(sawStatus(onToolCallsUpdate, 'call-1', 'awaiting_approval')).toBe(
      false,
    );
    expect(sawStatus(onToolCallsUpdate, 'call-1', 'success')).toBe(false);

    // The auto-redirect was recorded exactly once.
    expect(state.autoRedirectCount).toBe(1);
  });

  it('falls back to the Yes/No confirmation once the cap (2) is reached', async () => {
    const { config, state } = makeGateConfig({
      invokedSkills: [BRAINSTORMING_SKILL],
      autoRedirectCount: 2,
    });
    const { scheduler, onToolCallsUpdate } = makeScheduler(config);
    await scheduleWrite(
      scheduler,
      new AbortController().signal,
      '/repo/src/foo.ts',
    );

    // At the cap: fall through to the existing plan-first confirmation.
    const awaiting = latestSnapshot(onToolCallsUpdate, 'call-1');
    expect(awaiting?.status).toBe('awaiting_approval');
    expect((awaiting as WaitingToolCall).confirmationDetails.type).toBe('info');
    // Not an auto-deny: no error, counter untouched.
    expect(sawStatus(onToolCallsUpdate, 'call-1', 'error')).toBe(false);
    expect(state.autoRedirectCount).toBe(2);
  });

  it('shows the confirmation (not auto-deny) when brainstorming was never invoked', async () => {
    // No skills seeded → hasInvokedSkill(BRAINSTORMING_SKILL) === false.
    const { config, state } = makeGateConfig();
    const { scheduler, onToolCallsUpdate } = makeScheduler(config);
    await scheduleWrite(
      scheduler,
      new AbortController().signal,
      '/repo/src/foo.ts',
    );

    const awaiting = latestSnapshot(onToolCallsUpdate, 'call-1');
    expect(awaiting?.status).toBe('awaiting_approval');
    expect((awaiting as WaitingToolCall).confirmationDetails.type).toBe('info');
    expect(sawStatus(onToolCallsUpdate, 'call-1', 'error')).toBe(false);
    // Current behavior preserved: nothing auto-redirected.
    expect(state.autoRedirectCount).toBe(0);
  });

  it('does not gate at all once writing-plans has been invoked', async () => {
    // brainstorming AND writing-plans invoked → shouldGatePlanFirst false.
    const { config, state } = makeGateConfig({
      invokedSkills: [BRAINSTORMING_SKILL, PLAN_GATE_SKILL],
    });
    const { scheduler, onAllToolCallsComplete, onToolCallsUpdate } =
      makeScheduler(config);
    await scheduleWrite(
      scheduler,
      new AbortController().signal,
      '/repo/src/foo.ts',
    );

    await vi.waitFor(() => expect(onAllToolCallsComplete).toHaveBeenCalled());
    const completed = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    expect(completed[0].status).toBe('success');
    expect(sawStatus(onToolCallsUpdate, 'call-1', 'awaiting_approval')).toBe(
      false,
    );
    expect(sawStatus(onToolCallsUpdate, 'call-1', 'error')).toBe(false);
    expect(state.autoRedirectCount).toBe(0);
  });
});
