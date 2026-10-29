/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  looksLikeDeclarativeImplementationTurn,
  shouldForceWritingPlans,
  WRITING_PLANS_GATE_CAP,
} from './writingPlansGate.js';

// A substantive declarative design/implementation turn (no '?').
const DECLARATIVE_DESIGN = `Here is the design of the script counter.py.

Purpose: connect to the database, read the counter from jobCounters.
Stack: Python 3 + a database driver.
Logic: argparse -> connect -> SELECT count -> print.

Starting the implementation.`;

const SHORT_INTENT = `I'll implement this now.\nStarting with the argument parser.`;

describe('looksLikeDeclarativeImplementationTurn', () => {
  it('fires on a substantive declarative design turn with no question mark', () => {
    expect(looksLikeDeclarativeImplementationTurn(DECLARATIVE_DESIGN)).toBe(
      true,
    );
  });

  it('fires on a short multi-line implementation-intent statement', () => {
    expect(looksLikeDeclarativeImplementationTurn(SHORT_INTENT)).toBe(true);
  });

  it('fires on a long single-line declarative statement (>=200 chars)', () => {
    expect(looksLikeDeclarativeImplementationTurn('x'.repeat(210))).toBe(true);
  });

  it('does NOT fire when the message contains a question mark', () => {
    const withQ = `Вот проект скрипта cache.py.

Логика: argparse -> connect -> SELECT.

Подходит такой дизайн?`;
    expect(looksLikeDeclarativeImplementationTurn(withQ)).toBe(false);
  });

  it('does NOT fire when the message contains a full-width question mark', () => {
    // A CJK question ("这个设计可以吗？") must be treated as a question, not a
    // declarative turn — otherwise the gate misfires on non-ASCII questions.
    const cjkQuestion = `这是 cache.py 的设计。\n\n这个设计可以吗？`;
    expect(looksLikeDeclarativeImplementationTurn(cjkQuestion)).toBe(false);
  });

  it('does NOT fire on a trivial single-line acknowledgement', () => {
    expect(looksLikeDeclarativeImplementationTurn('Ок, схема ясна.')).toBe(
      false,
    );
  });

  it('does NOT fire on an empty message', () => {
    expect(looksLikeDeclarativeImplementationTurn('')).toBe(false);
  });
});

describe('shouldForceWritingPlans', () => {
  const base = {
    enabled: true,
    brainstormingActive: true,
    writingPlansInvoked: false,
    interactive: true,
    underCap: true,
    lastMessage: DECLARATIVE_DESIGN,
  };

  it('fires when all conditions hold and the detector matches', () => {
    expect(shouldForceWritingPlans(base)).toBe(true);
  });

  it('does not fire when disabled', () => {
    expect(shouldForceWritingPlans({ ...base, enabled: false })).toBe(false);
  });

  it('does not fire when brainstorming is inactive', () => {
    expect(
      shouldForceWritingPlans({ ...base, brainstormingActive: false }),
    ).toBe(false);
  });

  it('does not fire when writing-plans already ran', () => {
    expect(
      shouldForceWritingPlans({ ...base, writingPlansInvoked: true }),
    ).toBe(false);
  });

  it('does not fire when non-interactive', () => {
    expect(shouldForceWritingPlans({ ...base, interactive: false })).toBe(
      false,
    );
  });

  it('does not fire when at/over the cap', () => {
    expect(shouldForceWritingPlans({ ...base, underCap: false })).toBe(false);
  });

  it('does not fire when the message is a question', () => {
    expect(
      shouldForceWritingPlans({ ...base, lastMessage: 'Which db? Postgres?' }),
    ).toBe(false);
  });

  it('exposes a cap of 2', () => {
    expect(WRITING_PLANS_GATE_CAP).toBe(2);
  });
});
