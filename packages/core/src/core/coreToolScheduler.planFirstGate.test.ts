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
  ToolConfirmationOutcome,
  ToolErrorType,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
} from '../index.js';
import { ToolNames } from '../tools/tool-names.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { CoreToolScheduler } from './coreToolScheduler.js';
import type { ToolCall, WaitingToolCall } from './coreToolScheduler.js';
import {
  PLAN_GATE_SKILL,
  PLAN_GATE_REDIRECT_MESSAGE,
} from './planFirstGate.js';

/**
 * Stateful mock Config that backs the gate methods with real state, so
 * setPlanGateOverride / markSkillInvoked actually change subsequent
 * decisions the way the production Config does.
 */
interface GateConfigOptions {
  gateEnabled?: boolean;
  interactive?: boolean;
  approvalMode?: ApprovalMode;
}

function makeGateConfig(options: GateConfigOptions = {}) {
  const state = {
    gateEnabled: options.gateEnabled ?? true,
    interactive: options.interactive ?? true,
    approvalMode: options.approvalMode ?? ApprovalMode.DEFAULT,
    planGateOverride: false,
    invokedSkills: new Set<string>(),
    autoRedirectCount: 0,
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
    // Post-execution reminder-injection path for filesystem-path tools
    // (write_file) reads these; optional-chained, so undefined disables them.
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
    // ── Auto-redirect counter (Task 2). Backed by real state so the gate's
    // eager argument object (which always reads this) works; brainstorming is
    // never seeded here, so shouldAutoRedirectPlanGate stays false and these
    // tests keep hitting the Yes/No confirmation path. ──
    getPlanGateAutoRedirectCount: () => state.autoRedirectCount,
    markPlanGateAutoRedirect: () => {
      state.autoRedirectCount++;
    },
  } as unknown as Config;

  return { config, state };
}

interface SchedulerToolOptions {
  /**
   * Optional L3 default-permission override for the write tool. Defaults to
   * 'allow' so the clean gate tests get an awaiting_approval-vs-success split.
   * Set 'deny' to drive the `finalPermission === 'deny'` branch, or 'ask' to
   * exercise plan-mode blocking (needs `getConfirmationDetails`).
   */
  getDefaultPermission?: () => Promise<'allow' | 'deny' | 'ask'>;
  /** Confirmation details for an 'ask' write tool (e.g. an 'edit' diff). */
  getConfirmationDetails?: () => Promise<{
    type: string;
    [key: string]: unknown;
  }>;
}

function makeScheduler(config: Config, toolOptions: SchedulerToolOptions = {}) {
  const onAllToolCallsComplete: Mock = vi.fn();
  const onToolCallsUpdate: Mock = vi.fn();
  const registry = config.getToolRegistry() as unknown as {
    getTool: (name: string) => unknown;
    ensureTool: (name: string) => Promise<unknown>;
  };
  const writeTool = new MockTool({
    name: ToolNames.WRITE_FILE,
    // Default 'allow' permission: when the gate does NOT fire the write is
    // auto-approved and executes, so "gated" vs "not gated" is a clean
    // awaiting_approval-vs-success split.
    ...(toolOptions.getDefaultPermission
      ? {
          getDefaultPermission:
            toolOptions.getDefaultPermission as MockTool['getDefaultPermission'],
        }
      : {}),
    ...(toolOptions.getConfirmationDetails
      ? {
          getConfirmationDetails:
            toolOptions.getConfirmationDetails as unknown as MockTool['getConfirmationDetails'],
        }
      : {}),
    execute: async () => ({
      llmContent: 'wrote file',
      returnDisplay: 'wrote file',
    }),
  });
  registry.getTool = (name: string) =>
    name === ToolNames.WRITE_FILE ? writeTool : undefined;
  // The scheduler resolves tools via ensureTool(); mirror the getTool
  // override so the write_file tool is actually found.
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

/** Every tool-call snapshot ever emitted for the given callId. */
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

/**
 * True iff the plan-first gate ever opened its confirmation for this call —
 * an `awaiting_approval` snapshot whose `confirmationDetails.type === 'info'`.
 * The gate is the only producer of an 'info' confirmation in this harness.
 */
function sawGateInfoConfirmation(
  onToolCallsUpdate: Mock,
  callId: string,
): boolean {
  return snapshotsFor(onToolCallsUpdate, callId).some(
    (tc) =>
      tc.status === 'awaiting_approval' &&
      (tc as WaitingToolCall).confirmationDetails.type === 'info',
  );
}

describe('coreToolScheduler plan-first gate', () => {
  it('opens an awaiting_approval confirmation for an unplanned write_file', async () => {
    const { config } = makeGateConfig();
    const { scheduler, onToolCallsUpdate } = makeScheduler(config);
    await scheduleWrite(
      scheduler,
      new AbortController().signal,
      '/repo/src/foo.ts',
    );

    const awaiting = latestSnapshot(onToolCallsUpdate, 'call-1');
    expect(awaiting?.status).toBe('awaiting_approval');
    expect((awaiting as WaitingToolCall).confirmationDetails.type).toBe('info');
    // The gate must not have executed the write.
    expect(sawStatus(onToolCallsUpdate, 'call-1', 'success')).toBe(false);
  });

  it('proceeds without a gate prompt after markSkillInvoked(writing-plans)', async () => {
    const { config } = makeGateConfig();
    config.markSkillInvoked(PLAN_GATE_SKILL);
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
  });

  it('proceeds without a gate prompt for a docs/superpowers/ write', async () => {
    const { config } = makeGateConfig();
    const { scheduler, onAllToolCallsComplete, onToolCallsUpdate } =
      makeScheduler(config);
    await scheduleWrite(
      scheduler,
      new AbortController().signal,
      '/repo/docs/superpowers/specs/x.md',
    );

    await vi.waitFor(() => expect(onAllToolCallsComplete).toHaveBeenCalled());
    const completed = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    expect(completed[0].status).toBe('success');
    expect(sawStatus(onToolCallsUpdate, 'call-1', 'awaiting_approval')).toBe(
      false,
    );
  });

  it('fails open (no gate prompt) in a non-interactive session', async () => {
    const { config } = makeGateConfig({ interactive: false });
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
  });

  it('choosing "write anyway" sets the session override so the next write is not gated', async () => {
    const { config, state } = makeGateConfig();
    const { scheduler, onAllToolCallsComplete, onToolCallsUpdate } =
      makeScheduler(config);
    const signal = new AbortController().signal;
    await scheduleWrite(scheduler, signal, '/repo/src/foo.ts', 'call-1');

    const awaiting = latestSnapshot(onToolCallsUpdate, 'call-1') as
      | WaitingToolCall
      | undefined;
    expect(awaiting?.status).toBe('awaiting_approval');
    expect(config.getPlanGateOverride()).toBe(false);

    await awaiting!.confirmationDetails.onConfirm(
      ToolConfirmationOutcome.ProceedOnce,
    );

    expect(state.planGateOverride).toBe(true);
    expect(config.getPlanGateOverride()).toBe(true);

    // First write executed after the proceed.
    await vi.waitFor(() => expect(onAllToolCallsComplete).toHaveBeenCalled());

    // A second unplanned write is not gated now that the override is set.
    onToolCallsUpdate.mockClear();
    onAllToolCallsComplete.mockClear();
    await scheduleWrite(scheduler, signal, '/repo/src/bar.ts', 'call-2');
    await vi.waitFor(() => expect(onAllToolCallsComplete).toHaveBeenCalled());
    const completed2 = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    expect(completed2.find((c) => c.request.callId === 'call-2')?.status).toBe(
      'success',
    );
    expect(sawStatus(onToolCallsUpdate, 'call-2', 'awaiting_approval')).toBe(
      false,
    );
  });

  it('choosing "run planning first" cancels with the redirect message', async () => {
    const { config } = makeGateConfig();
    const { scheduler, onAllToolCallsComplete, onToolCallsUpdate } =
      makeScheduler(config);
    await scheduleWrite(
      scheduler,
      new AbortController().signal,
      '/repo/src/foo.ts',
    );

    const awaiting = latestSnapshot(onToolCallsUpdate, 'call-1') as
      | WaitingToolCall
      | undefined;
    expect(awaiting?.status).toBe('awaiting_approval');

    await awaiting!.confirmationDetails.onConfirm(
      ToolConfirmationOutcome.Cancel,
    );

    await vi.waitFor(() => expect(onAllToolCallsComplete).toHaveBeenCalled());
    const completed = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    const cancelled = completed.find((c) => c.request.callId === 'call-1');
    expect(cancelled?.status).toBe('cancelled');
    // Override must NOT be set on cancel.
    expect(config.getPlanGateOverride()).toBe(false);
    // The model-facing response carries the redirect message.
    const text = JSON.stringify(
      (cancelled as { response?: unknown } | undefined)?.response,
    );
    expect(text).toContain(PLAN_GATE_REDIRECT_MESSAGE);
  });

  it('does not gate-approve a write in PLAN mode — plan mode still governs', async () => {
    // Regression for review Findings 1 & 2: the gate must not intercept a
    // write that plan mode would block. The write tool is 'ask'-default with
    // an 'edit' confirmation (like a real write tool), so in plan mode it is
    // plan-mode-blocked. The gate's `!isPlanMode` guard means its 'info'
    // confirmation must NEVER open here — otherwise a user "Yes" could execute
    // a write plan mode forbids.
    const { config } = makeGateConfig({ approvalMode: ApprovalMode.PLAN });
    const { scheduler, onAllToolCallsComplete, onToolCallsUpdate } =
      makeScheduler(config, {
        getDefaultPermission: async () => 'ask',
        getConfirmationDetails: async () => ({
          type: 'edit',
          title: 'Confirm write',
          fileName: 'foo.ts',
          filePath: '/repo/src/foo.ts',
          fileDiff: 'diff',
          originalContent: '',
          newContent: 'x',
          onConfirm: async () => {},
        }),
      });
    await scheduleWrite(
      scheduler,
      new AbortController().signal,
      '/repo/src/foo.ts',
    );

    await vi.waitFor(() => expect(onAllToolCallsComplete).toHaveBeenCalled());
    // Gate never opened its info confirmation — plan mode governs.
    expect(sawGateInfoConfirmation(onToolCallsUpdate, 'call-1')).toBe(false);
    // Plan mode blocked the write: it errored, and never succeeded.
    const completed = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    expect(completed[0].status).toBe('error');
    expect(sawStatus(onToolCallsUpdate, 'call-1', 'success')).toBe(false);
    // The session override was NOT set — the gate never ran.
    expect(config.getPlanGateOverride()).toBe(false);
  });

  it('does not gate-approve a denied write — deny takes precedence', async () => {
    // Regression for review Finding 1: a write whose L3 default permission is
    // 'deny' yields finalPermission === 'deny' at the gate (no Permission
    // Manager needed). The gate's `finalPermission !== 'deny'` guard means its
    // 'info' confirmation must NEVER open; the write falls through to the deny
    // branch and ends in EXECUTION_DENIED, never executing.
    const { config } = makeGateConfig();
    const { scheduler, onAllToolCallsComplete, onToolCallsUpdate } =
      makeScheduler(config, { getDefaultPermission: async () => 'deny' });
    await scheduleWrite(
      scheduler,
      new AbortController().signal,
      '/repo/src/foo.ts',
    );

    await vi.waitFor(() => expect(onAllToolCallsComplete).toHaveBeenCalled());
    // Gate never opened its info confirmation — deny governs.
    expect(sawGateInfoConfirmation(onToolCallsUpdate, 'call-1')).toBe(false);
    const completed = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    const call = completed.find((c) => c.request.callId === 'call-1');
    expect(call?.status).toBe('error');
    if (call?.status === 'error') {
      expect(call.response.errorType).toBe(ToolErrorType.EXECUTION_DENIED);
    }
    expect(sawStatus(onToolCallsUpdate, 'call-1', 'success')).toBe(false);
    // The session override was NOT set — the gate never ran.
    expect(config.getPlanGateOverride()).toBe(false);
  });
});
