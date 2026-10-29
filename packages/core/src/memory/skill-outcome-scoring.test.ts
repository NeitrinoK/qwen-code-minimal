/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isCorrection,
  scoreLaunch,
  type NextTurnSignals,
  type PendingLaunch,
} from './skill-outcome-scoring.js';

function launch(overrides: Partial<PendingLaunch> = {}): PendingLaunch {
  return {
    skill: 'my-skill',
    sessionId: 'session-1',
    launchTs: 1000,
    launchSucceeded: true,
    ...overrides,
  };
}

function signals(overrides: Partial<NextTurnSignals> = {}): NextTurnSignals {
  return {
    toolErrorInLaunchTurn: false,
    sameSkillRelaunched: false,
    nextUserMessage: 'ok thanks, next please build the login page',
    sessionEnded: false,
    ...overrides,
  };
}

describe('scoreLaunch', () => {
  it('scores a launch failure as hurt/tool-error', () => {
    const result = scoreLaunch(launch({ launchSucceeded: false }), signals(), {
      useCorrectionHeuristic: true,
    });
    expect(result).toEqual({ outcome: 'hurt', evidenceKind: 'tool-error' });
  });

  it('scores a tool error in the launch turn as hurt/tool-error', () => {
    const result = scoreLaunch(
      launch(),
      signals({ toolErrorInLaunchTurn: true }),
      { useCorrectionHeuristic: true },
    );
    expect(result).toEqual({ outcome: 'hurt', evidenceKind: 'tool-error' });
  });

  it('scores launch failure + tool error together as hurt/tool-error (still one evidence kind)', () => {
    const result = scoreLaunch(
      launch({ launchSucceeded: false }),
      signals({ toolErrorInLaunchTurn: true }),
      { useCorrectionHeuristic: true },
    );
    expect(result).toEqual({ outcome: 'hurt', evidenceKind: 'tool-error' });
  });

  it('scores a same-skill relaunch as hurt/retry', () => {
    const result = scoreLaunch(
      launch(),
      signals({ sameSkillRelaunched: true }),
      { useCorrectionHeuristic: true },
    );
    expect(result).toEqual({ outcome: 'hurt', evidenceKind: 'retry' });
  });

  it('sameSkillRelaunched takes precedence over a correction message', () => {
    const result = scoreLaunch(
      launch(),
      signals({ sameSkillRelaunched: true, nextUserMessage: 'no, wrong' }),
      { useCorrectionHeuristic: true },
    );
    expect(result).toEqual({ outcome: 'hurt', evidenceKind: 'retry' });
  });

  it('scores a correction message as hurt/user-correction when heuristic enabled', () => {
    const result = scoreLaunch(
      launch(),
      signals({ nextUserMessage: 'no, that is wrong' }),
      { useCorrectionHeuristic: true },
    );
    expect(result).toEqual({
      outcome: 'hurt',
      evidenceKind: 'user-correction',
    });
  });

  it('does NOT treat the same correction message as hurt when heuristic disabled', () => {
    const result = scoreLaunch(
      launch(),
      signals({ nextUserMessage: 'no, that is wrong' }),
      { useCorrectionHeuristic: false },
    );
    expect(result.outcome).not.toBe('hurt');
    // With the heuristic off, the message is no longer treated as hurt
    // evidence, but its content is still a correction, not forward progress,
    // so it reads as neutral (ambiguous) rather than helped.
    expect(result).toEqual({ outcome: 'neutral', evidenceKind: null });
  });

  it('scores a clean forward-moving message as helped with no evidenceKind', () => {
    const result = scoreLaunch(launch(), signals(), {
      useCorrectionHeuristic: true,
    });
    expect(result).toEqual({ outcome: 'helped', evidenceKind: null });
  });

  it('scores a session end with no message as neutral', () => {
    const result = scoreLaunch(
      launch(),
      signals({ sessionEnded: true, nextUserMessage: null }),
      { useCorrectionHeuristic: true },
    );
    expect(result).toEqual({ outcome: 'neutral', evidenceKind: null });
  });

  it('scores a null next message with no other signal as neutral', () => {
    const result = scoreLaunch(launch(), signals({ nextUserMessage: null }), {
      useCorrectionHeuristic: true,
    });
    expect(result).toEqual({ outcome: 'neutral', evidenceKind: null });
  });

  it('never returns a non-null evidenceKind for helped', () => {
    const result = scoreLaunch(launch(), signals(), {
      useCorrectionHeuristic: true,
    });
    expect(result.outcome).toBe('helped');
    expect(result.evidenceKind).toBeNull();
  });

  it('never returns a non-null evidenceKind for neutral', () => {
    const result = scoreLaunch(launch(), signals({ nextUserMessage: null }), {
      useCorrectionHeuristic: true,
    });
    expect(result.outcome).toBe('neutral');
    expect(result.evidenceKind).toBeNull();
  });
});

describe('isCorrection', () => {
  it.each([
    ['no', true],
    ['Nope', true],
    ["that's wrong", true],
    ['thats wrong', true],
    ['  try again', true],
    ['not what I meant', true],
    ['not right', true],
    ['undo that', true],
    ['revert this please', true],
    ['wrong approach', true],
  ])('treats %j as a correction: %s', (msg, expected) => {
    expect(isCorrection(msg)).toBe(expected);
  });

  it.each([
    ['yes do it', false],
    ['nomad', false],
    ['not bad, keep going', false],
    ['', false],
  ])('does not treat %j as a correction: %s', (msg, expected) => {
    expect(isCorrection(msg)).toBe(expected);
  });

  it('returns false for null', () => {
    expect(isCorrection(null)).toBe(false);
  });
});
