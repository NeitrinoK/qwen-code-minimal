/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { fetch } from 'undici';
import { createHttpDispatcher } from '../utils/proxyUtils.js';

export type ProbeResult =
  | 'supported'
  | 'accepted_no_thinking'
  | 'rejected'
  | 'unknown';

export interface ReasoningTrial {
  key: string;
  body: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 15000;

/** Pure classification of one trial's HTTP result. */
export function classifyProbeResponse(
  status: number,
  json: unknown,
): ProbeResult {
  if (status === 400) return 'rejected';
  if (status !== 200) return 'unknown';
  const reasoning = (
    json as { choices?: Array<{ message?: { reasoning?: unknown } }> }
  )?.choices?.[0]?.message?.reasoning;
  return typeof reasoning === 'string' && reasoning.trim().length > 0
    ? 'supported'
    : 'accepted_no_thinking';
}

interface ProbeDeps {
  baseUrl: string;
  apiKey: string;
  model: string;
  trials: ReasoningTrial[];
  proxy?: string;
  noProxy?: string[];
  caCertificates?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function runTrial(
  deps: ProbeDeps,
  trial: ReasoningTrial,
): Promise<ProbeResult> {
  try {
    const dispatcher = createHttpDispatcher({
      proxyUrl: deps.proxy,
      noProxy: deps.noProxy,
      caCertificates: deps.caCertificates,
    });
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = deps.signal
      ? AbortSignal.any([deps.signal, timeout])
      : timeout;
    const url = `${deps.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deps.apiKey}`,
      },
      body: JSON.stringify({
        model: deps.model,
        messages: [
          { role: 'user', content: 'What is 23*17? Show brief reasoning.' },
        ],
        // Reasoning tokens count against the completion budget, so a
        // thinking-capable model needs enough headroom to emit its
        // `reasoning` content before the answer — too small a budget would
        // misclassify it as accepted_no_thinking for running out of tokens
        // mid-thought rather than for lacking reasoning support.
        max_tokens: 256,
        temperature: 0,
        ...trial.body,
      }),
      signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    let json: unknown = undefined;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return classifyProbeResponse(res.status, json);
  } catch {
    return 'unknown';
  }
}

/**
 * Probe each reasoning trial against the live provider. One retry on `unknown`
 * (transient 5xx/timeout). NEVER throws; a failed trial yields `unknown`.
 * Fires only from the explicit Verify action.
 */
export async function probeReasoningSupport(
  deps: ProbeDeps,
): Promise<Map<string, ProbeResult>> {
  const out = new Map<string, ProbeResult>();
  for (const trial of deps.trials) {
    let result = await runTrial(deps, trial);
    if (result === 'unknown') {
      result = await runTrial(deps, trial); // one retry on transient
    }
    out.set(trial.key, result);
  }
  return out;
}
