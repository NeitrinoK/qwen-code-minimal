/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  shouldAutoRedirectPlanGate,
  PLAN_GATE_AUTO_REDIRECT_CAP,
  BRAINSTORMING_SKILL,
} from './planFirstGate.js';

const base = {
  brainstormingActive: true,
  writingPlansInvoked: false,
  autoRedirectCount: 0,
};

describe('shouldAutoRedirectPlanGate', () => {
  it('auto-redirects when brainstorming active, no plan, under cap', () => {
    expect(shouldAutoRedirectPlanGate(base)).toBe(true);
  });

  it('does NOT auto-redirect when brainstorming is inactive', () => {
    expect(
      shouldAutoRedirectPlanGate({ ...base, brainstormingActive: false }),
    ).toBe(false);
  });

  it('does NOT auto-redirect once writing-plans has run', () => {
    expect(
      shouldAutoRedirectPlanGate({ ...base, writingPlansInvoked: true }),
    ).toBe(false);
  });

  it('does NOT auto-redirect at the cap', () => {
    expect(
      shouldAutoRedirectPlanGate({
        ...base,
        autoRedirectCount: PLAN_GATE_AUTO_REDIRECT_CAP,
      }),
    ).toBe(false);
  });

  it('does NOT auto-redirect over the cap', () => {
    expect(
      shouldAutoRedirectPlanGate({
        ...base,
        autoRedirectCount: PLAN_GATE_AUTO_REDIRECT_CAP + 5,
      }),
    ).toBe(false);
  });

  it('still auto-redirects at cap-1 (boundary)', () => {
    expect(
      shouldAutoRedirectPlanGate({
        ...base,
        autoRedirectCount: PLAN_GATE_AUTO_REDIRECT_CAP - 1,
      }),
    ).toBe(true);
  });

  it('exposes cap 2 and the brainstorming skill id', () => {
    expect(PLAN_GATE_AUTO_REDIRECT_CAP).toBe(2);
    expect(BRAINSTORMING_SKILL).toBe('superpowers:brainstorming');
  });
});
