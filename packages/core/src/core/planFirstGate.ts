/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames } from '../tools/tool-names.js';

/** The skill whose invocation lifts the gate for the rest of the session. */
export const PLAN_GATE_SKILL = 'superpowers:writing-plans';

/** The skill whose active state enables auto-redirect (vs. the Yes/No prompt). */
export const BRAINSTORMING_SKILL = 'superpowers:brainstorming';

/**
 * Max times the plan-first gate auto-denies a write with the redirect message
 * (no user prompt) in one session before falling back to the Yes/No
 * confirmation, so a stuck model can never trap the user.
 */
export const PLAN_GATE_AUTO_REDIRECT_CAP = 2;

/** Canonical write-tool names the gate applies to. */
const GATED_WRITE_TOOLS = new Set<string>([
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.NOTEBOOK_EDIT,
]);

/**
 * Path-segment matcher for the always-writable planning-docs directory, so the
 * planning skills can produce their spec/plan documents even while the gate is
 * active. Anchored to a segment boundary (start-of-string or a `/`) so a
 * mid-segment match like `mydocs/superpowers/` does NOT slip the gate.
 */
const PLANNING_DOCS_SEGMENT_RE = /(^|\/)docs\/superpowers\//;

/** Confirmation body shown when the gate fires. */
export const PLAN_GATE_PROMPT =
  'Plan-first gate: superpowers:writing-plans has not run this session, so ' +
  'there is no approved plan for these file changes. Choose "Yes" to skip ' +
  'planning and allow file writes for the rest of this session, or "No" to ' +
  'stop and run planning first.';

/** Model-facing message returned when the user chooses to run planning first. */
export const PLAN_GATE_REDIRECT_MESSAGE =
  'Blocked by the plan-first gate: no approved plan exists for this task. ' +
  'Invoke the superpowers:brainstorming skill, then superpowers:writing-plans, ' +
  'get the plan approved, and only then write code. (Writing to ' +
  'docs/superpowers/ is always allowed so the planning skills can save their ' +
  'spec and plan.)';

/**
 * Model-facing message for the auto-redirect path — used only when brainstorming
 * is already active this session, so it does NOT tell the model to invoke
 * brainstorming again (which could bounce a weak model back into clarifying
 * questions). It points straight at superpowers:writing-plans.
 */
export const PLAN_GATE_AUTO_REDIRECT_MESSAGE =
  'Blocked by the plan-first gate: you have designed this but there is no ' +
  'written plan yet. Do NOT write code now. Invoke the superpowers:writing-plans ' +
  "skill (call the Skill tool with skill='superpowers:writing-plans') to produce " +
  'a plan under docs/superpowers/plans/, then continue. (Writing to ' +
  'docs/superpowers/ is always allowed so the skill can save the plan.)';

export interface PlanFirstGateInput {
  /** `skills.planFirstGate` setting (default true). */
  enabled: boolean;
  /** True once the user chose "write anyway" this session. */
  sessionOverride: boolean;
  /** Canonical tool name being scheduled. */
  toolName: string;
  /** Resolved target path of the write, or undefined if not a write. */
  filePath: string | undefined;
  /** True once superpowers:writing-plans ran this session. */
  writingPlansInvoked: boolean;
}

/** Reads the write target path from a gated tool's params, else undefined. */
export function extractGatedWritePath(
  toolName: string,
  params: Record<string, unknown>,
): string | undefined {
  const key =
    toolName === ToolNames.NOTEBOOK_EDIT ? 'notebook_path' : 'file_path';
  if (!GATED_WRITE_TOOLS.has(toolName)) {
    return undefined;
  }
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isUnderPlanningDocs(filePath: string): boolean {
  // Normalize Windows separators so the segment check is platform-independent,
  // then match only on a path-segment boundary (not mid-segment).
  return PLANNING_DOCS_SEGMENT_RE.test(filePath.replace(/\\/g, '/'));
}

/**
 * Pure gate decision. Returns true (BLOCK) only for an unplanned write to a
 * non-planning file while the gate is enabled and not overridden. A gated
 * tool with no resolvable path returns false — the gate cannot judge the
 * planning-docs exemption without a path, so it defers rather than blocks.
 */
export function shouldGatePlanFirst(input: PlanFirstGateInput): boolean {
  if (!input.enabled) return false;
  if (input.sessionOverride) return false;
  if (!GATED_WRITE_TOOLS.has(input.toolName)) return false;
  if (input.writingPlansInvoked) return false;
  if (!input.filePath) return false;
  if (isUnderPlanningDocs(input.filePath)) return false;
  return true;
}

export interface PlanGateAutoRedirectInput {
  /** `hasInvokedSkill('superpowers:brainstorming')`. */
  brainstormingActive: boolean;
  /** `hasInvokedSkill('superpowers:writing-plans')`. */
  writingPlansInvoked: boolean;
  /** How many times the gate has already auto-redirected this session. */
  autoRedirectCount: number;
}

/**
 * Pure decision: given the plan-first gate has ALREADY decided to block this
 * write (see shouldGatePlanFirst), should it AUTO-REDIRECT the model (deny with
 * the redirect message, no user prompt) instead of showing the Yes/No
 * confirmation? True only during an active brainstorming session where
 * writing-plans has not yet run and the per-session cap is not reached.
 */
export function shouldAutoRedirectPlanGate(
  input: PlanGateAutoRedirectInput,
): boolean {
  return (
    input.brainstormingActive &&
    !input.writingPlansInvoked &&
    input.autoRedirectCount < PLAN_GATE_AUTO_REDIRECT_CAP
  );
}
