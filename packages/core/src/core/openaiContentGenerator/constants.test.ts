/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT,
  DISABLED_REQUEST_TIMEOUT_MS,
  resolveRequestTimeout,
} from './constants.js';

describe('resolveRequestTimeout', () => {
  it('returns DEFAULT_TIMEOUT when timeout is undefined', () => {
    expect(resolveRequestTimeout(undefined)).toBe(DEFAULT_TIMEOUT);
  });

  it('returns DEFAULT_TIMEOUT when timeout is null', () => {
    expect(resolveRequestTimeout(null)).toBe(DEFAULT_TIMEOUT);
  });

  it('maps 0 to the disabled sentinel', () => {
    expect(resolveRequestTimeout(0)).toBe(DISABLED_REQUEST_TIMEOUT_MS);
  });

  it('maps negative values to the disabled sentinel', () => {
    expect(resolveRequestTimeout(-5)).toBe(DISABLED_REQUEST_TIMEOUT_MS);
  });

  it('passes a positive value through unchanged', () => {
    expect(resolveRequestTimeout(60000)).toBe(60000);
  });
});

describe('provider SDK defaults', () => {
  // Pinned deliberately: these two values interact, and regressing either one
  // reintroduces a failure mode that is invisible in logs for minutes at a
  // time. See the rationale comments in constants.ts.
  it('allows a full-window prefill to complete before timing out', () => {
    // Time-to-first-token on a loaded shared vLLM gateway scales with prompt
    // size; the previous 120s default cut off requests at ~90k prompt tokens.
    expect(DEFAULT_TIMEOUT).toBe(600000);
  });

  it('leaves retries to the application layer so budgets add, not multiply', () => {
    // retryWithBackoff (utils/retry.ts) is the single retry policy. A non-zero
    // value here multiplies with it: N SDK attempts x M outer attempts, each
    // re-sending the whole prompt, with no log line between them.
    expect(DEFAULT_MAX_RETRIES).toBe(0);
  });
});
