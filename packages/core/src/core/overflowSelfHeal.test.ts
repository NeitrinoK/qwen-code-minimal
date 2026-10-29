/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isLikelyContextOverflow,
  shouldPreCompactOnSwitch,
} from './overflowSelfHeal.js';

describe('isLikelyContextOverflow', () => {
  it('true when the error text is recognised as overflow (regardless of size)', () => {
    expect(
      isLikelyContextOverflow({
        textRecognized: true,
        estimatedPromptTokens: 10,
        contextWindow: 1000,
      }),
    ).toBe(true);
  });

  it('true when estimated tokens exceed the window even if text is not recognised', () => {
    expect(
      isLikelyContextOverflow({
        textRecognized: false,
        estimatedPromptTokens: 900_000,
        contextWindow: 262_144,
      }),
    ).toBe(true);
  });

  it('false for a normal-sized context with an unrecognised error (no false positive)', () => {
    expect(
      isLikelyContextOverflow({
        textRecognized: false,
        estimatedPromptTokens: 50_000,
        contextWindow: 262_144,
      }),
    ).toBe(false);
  });

  it('false when the window is unknown (0) and text is not recognised', () => {
    expect(
      isLikelyContextOverflow({
        textRecognized: false,
        estimatedPromptTokens: 900_000,
        contextWindow: 0,
      }),
    ).toBe(false);
  });
});

describe('shouldPreCompactOnSwitch', () => {
  it('true when the current context exceeds the new window', () => {
    expect(
      shouldPreCompactOnSwitch({
        estimatedContextTokens: 900_000,
        newContextWindow: 262_144,
      }),
    ).toBe(true);
  });

  it('false when the context still fits the new window', () => {
    expect(
      shouldPreCompactOnSwitch({
        estimatedContextTokens: 100_000,
        newContextWindow: 262_144,
      }),
    ).toBe(false);
  });

  it('false when the new window is unknown (0)', () => {
    expect(
      shouldPreCompactOnSwitch({
        estimatedContextTokens: 900_000,
        newContextWindow: 0,
      }),
    ).toBe(false);
  });
});
