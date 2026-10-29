// Request timeout (ms) handed to the provider SDK. For a streaming call this
// bounds connect + response headers only — once the SSE stream is open the
// stream guards below take over.
//
// 120s was too short for large-context self-hosted models: time-to-first-token
// scales with prompt size, and a 27B vLLM deployment crossed 120s at ~90k prompt
// tokens.
// Every request past that point then failed identically, and the failure was
// invisible for eight minutes because the SDK silently re-ran it (see
// DEFAULT_MAX_RETRIES). 600s covers a full-window prefill on a loaded shared
// gateway with headroom; a genuinely unreachable endpoint is still bounded,
// just by one long wait instead of many short doomed ones.
export const DEFAULT_TIMEOUT = 600000;
/**
 * Sentinel request timeout (ms) representing a *disabled* timeout.
 *
 * The OpenAI and Anthropic SDKs treat `timeout: 0` as an immediate abort rather
 * than "no timeout", so a configured `0` (disable — matching the
 * `QWEN_STREAM_IDLE_TIMEOUT_MS=0` convention) is mapped to the maximum JS timer
 * delay (2^31 − 1 ms ≈ 24.8 days). `setTimeout` silently compresses larger
 * delays to 1ms, so this is the effective ceiling.
 */
export const DISABLED_REQUEST_TIMEOUT_MS = 2_147_483_647;

/**
 * Resolve the request timeout (ms) to pass to a provider SDK client.
 *
 * - `undefined` / `null` → {@link DEFAULT_TIMEOUT}
 * - `0` or negative → disabled ({@link DISABLED_REQUEST_TIMEOUT_MS})
 * - otherwise → the configured value
 */
export function resolveRequestTimeout(
  timeout: number | null | undefined,
): number {
  if (timeout === undefined || timeout === null) {
    return DEFAULT_TIMEOUT;
  }
  return timeout <= 0 ? DISABLED_REQUEST_TIMEOUT_MS : timeout;
}
// Inactivity (no-chunk) timeout for streaming responses. The SDK `timeout`
// only bounds connect + first response, so a stream that returns 200 then
// goes silent is otherwise unbounded. The 4-minute default gives large-prompt
// ingest and long thinking phases room while staying below
// LoggingContentGenerator's stream-span idle timer, so this watchdog fires first.
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 240000;
// Env override (deployment knob) for the streaming inactivity timeout, so a
// daemon deployment can tune it without code — the same way the QWEN_SERVE_*
// params are set. An explicit ContentGeneratorConfig.streamIdleTimeoutMs still
// takes precedence; a malformed value is ignored (falls back to the default).
export const QWEN_STREAM_IDLE_TIMEOUT_MS_ENV = 'QWEN_STREAM_IDLE_TIMEOUT_MS';
// Maximum JS timer delay (~24.8 days). setTimeout silently compresses larger
// delays to 1ms, which would make a watchdog fire almost immediately, so a
// stream-guard timeout above this is treated as invalid.
export const MAX_STREAM_GUARD_TIMEOUT_MS = 2_147_483_647;

// Total-lifetime cap for a single streaming response, measured from the
// stream's first iteration (when the response wrapper starts consuming it)
// and NOT refreshed by chunk arrival. The idle watchdog above cannot see
// a drip-fed stream — an upstream delivering one tiny chunk per window keeps
// resetting it while the message never completes (issue #8597: CI review runs
// burned 2.5–4.5 h on such a stream and died by the outer kill). 15 minutes
// gives even a slow, oversized single response ample room, and a false trip
// is bounded and visible: a text-only generation cut by the cap resumes via
// the transport-continuation recovery, while a turn that already streamed a
// functionCall (the tool-heavy common case, where continuation is excluded
// and replay needs no prior content) ends in a classified ETIMEDOUT the
// caller sees and can retry — never hours of silence. Note the cap bounds
// ONE attempt — each replay/continuation the recovery earns gets a fresh
// stream (TRANSPORT_STREAM_RETRY_CONFIG), so a pathological upstream's
// wall-clock bound per request is a small multiple of this value, not this
// value alone.
export const DEFAULT_STREAM_MAX_LIFETIME_MS = 900000;
// Env override (deployment knob) for the stream lifetime cap — same
// conventions as QWEN_STREAM_IDLE_TIMEOUT_MS: an explicit
// ContentGeneratorConfig.streamMaxLifetimeMs wins, `0` disables, a malformed
// value falls back to the default with a warning.
export const QWEN_STREAM_MAX_LIFETIME_MS_ENV = 'QWEN_STREAM_MAX_LIFETIME_MS';
// Provider-SDK-level retries. Deliberately 0: this fork already retries at the
// application layer (`retryWithBackoff`, utils/retry.ts), and stacking the two
// multiplies rather than adds. With the SDK's own 3 retries, one doomed request
// burned 1 + 3 = 4 x DEFAULT_TIMEOUT before surfacing a single
// APIConnectionTimeoutError (measured: durationMs 482763 for a 120s timeout),
// which retryWithBackoff then treated as one retryable failure and repeated up
// to 7 more times — 28 re-sends of the same oversized prompt, ~56 minutes of
// wall clock, and nothing in the log between them. Leaving retries to the outer
// layer keeps one retry policy, with backoff and a log line per attempt.
export const DEFAULT_MAX_RETRIES = 0;

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/**
 * Normalize an OpenAI-family baseUrl to the origin the Responses wire dials:
 * the pipeline strips any trailing `/v1` and appends `/v1/responses` itself,
 * so a bare origin, a `/v1`-suffixed URL, and an unset/default URL are the
 * same endpoint. ModelsConfig's credential-reuse comparison imports this so
 * the wire and the credential-carry decision can never drift apart on what
 * "same origin" means. It lives in this dependency-free leaf (not the
 * streaming pipeline module) so config/model modules can import it without
 * dragging the Responses pipeline's SDK imports into their static closure.
 */
export function normalizeOpenAiWireBaseUrl(
  baseUrl: string | undefined,
): string {
  return (baseUrl || DEFAULT_OPENAI_BASE_URL)
    .replace(/\/v1\/?$/, '')
    .replace(/\/$/, '');
}
