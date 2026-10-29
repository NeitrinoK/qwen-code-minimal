# Auto-Compaction Threshold Redesign

**Status:** Draft · 2026-05-14

## Background

> This section describes the state **before** this PR lands (pre-redesign behavior). The `COMPRESSION_TOKEN_THRESHOLD`, `thinkingConfig.includeThoughts = true`, `hasFailedCompressionAttempt`, and the specific file:line references that appear below all correspond to the code before PR #4345 was merged — after the merge these symbols / line numbers will no longer be valid.

The current auto-compaction in qwen-code uses only a single ratio threshold `COMPRESSION_TOKEN_THRESHOLD = 0.7` (`chatCompressionService.ts:33`), with all window sizes sharing the same ratio. Compared with claude-code's "absolute token ladder" (autoCompact.ts:62-65), qwen-code has three specific problems:

1. **Over-reservation on large windows**: a 1M model with a 70% threshold triggers at 700K, leaving 300K — far more than the ~33K actually needed for the summary + output
2. **Permanent lock after a single failure**: once `hasFailedCompressionAttempt = true`, the entire session no longer attempts auto-compact (geminiChat.ts:504), which is stricter than claude-code's "3 consecutive failures circuit breaker"
3. **The tip system is decoupled from the auto threshold**: the three `context-*` tips in `tipRegistry.ts` use fixed 50/80/95 percentages, completely independent of the auto-compact threshold (70%). This means that on the "auto works normally" main path the 80% / 95% tips rarely fire, while on the "auto failed / reactive fallback" edge path there is no threshold-aligned semantics
4. **The compression call itself has no output budget control**: [chatCompressionService.ts:374-376](packages/core/src/services/chatCompressionService.ts:374) explicitly enables `thinkingConfig.includeThoughts = true` (comment: "Compression quality drives every subsequent main turn"), while the sideQuery call sets no `maxOutputTokens` cap. The code comment ([:436-437](packages/core/src/services/chatCompressionService.ts:436)) also acknowledges that `compressionOutputTokenCount may include non-persisted tokens (thoughts)`. When compression happens near the top of the window, total output can balloon, leaving the buffer reservation without a predictable upper bound.<br/><br/>Worse, the behavior is inconsistent across providers: Anthropic's thinking budget is fully independent of max_tokens; OpenAI's reasoning tokens are not limited by max_completion_tokens; and Gemini's behavior varies by model version. This means that "just adding maxOutputTokens is enough to control total output" does not hold in a multi-provider project like qwen-code

5. **The `lastPromptTokenCount` used for threshold decisions is systematically biased low.** [geminiChat.ts:1217-1232](packages/core/src/core/geminiChat.ts:1217) shows that this number comes from the previous turn's API response `usageMetadata.totalTokenCount`. Two gaps: (a) it does not include the user message about to be added in the current turn, so every cheap-gate decision is short by a slice compared to the real prompt; (b) the initial value on the first turn is 0, so when `--continue` restores a huge session / a sub-agent inherits a large amount of history, the first send always bypasses all thresholds. By contrast, claude-code's `tokenCountWithEstimation` ([query.ts:638](src/query.ts:638)) uses a dual-track approach of "last assistant API usage + estimation of subsequently added messages" that closes both gaps

## Design Goals

- Introduce a "ratio + absolute" hybrid threshold, so that large-window models are taken over by the absolute value while small windows still fall back to the ratio
- Add warn / hard layers (auto remains the primary trigger point), forming a three-tier ladder
- Rewrite the tip system into trigger conditions that follow the new thresholds
- Upgrade failure handling from "permanent lock after 1 failure" to "3-failure circuit breaker + automatic recovery"
- **Disable thinking for the compression call and add a `maxOutputTokens` cap**: align with claude-code, so that total output is constrained by a single parameter and the buffer budget is predictable; accept the cost of potentially lower compression quality
- **Add token estimation compensation**: eliminate the two systematic low-biases of `lastPromptTokenCount` — "lagging one turn" and "first turn is 0" — so that threshold decisions are closer to the real prompt size
- Remove the `contextPercentageThreshold` configuration entry point in settings (the internal PCT constant is kept)
- **Do not introduce** an env override channel, and **do not** add an explicit enabled switch

## Three-Tier Threshold Ladder

```
                       window  (raw context window)
                          │
                          │  ← SUMMARY_RESERVE = 20K
                          ▼
                    effectiveWindow
                          │
                          │  ← HARD_BUFFER = 3K
                          ▼
              hard_threshold = effectiveWindow - 3K
                          │
                          │  ← (AUTOCOMPACT_BUFFER - HARD_BUFFER) = 10K
                          ▼
auto_threshold = max(PCT * window, effectiveWindow - AUTOCOMPACT_BUFFER)
                          │
                          │  ← WARN_BUFFER = 20K
                          ▼
warn_threshold = max((PCT - WARN_OFFSET) * window, auto_threshold - WARN_BUFFER)
                          │
                          ▼
                          0
```

### Tier Semantics

| Tier     | Trigger condition              | Behavior                                                                              |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| **warn** | `tokenCount >= warn_threshold` | UI prompt "X tokens left until auto-compaction", does not change send behavior        |
| **auto** | `tokenCount >= auto_threshold` | `tryCompress(force=false)` before send, normal compression flow                       |
| **hard** | `tokenCount >= hard_threshold` | `tryCompress(force=true)` before send, resets the failure lock and forces compression |

The `hard` tier is equivalent to moving the fallback logic of the existing reactive overflow (geminiChat.ts:711) earlier, to before send, avoiding one round-trip of a failed oversized request.

## Internal Constants

```ts
// chatCompressionService.ts
const DEFAULT_PCT = 0.7; // auto ratio fallback
const WARN_PCT_OFFSET = 0.1; // warn ratio = PCT - WARN_OFFSET = 0.6
const COMPACT_MAX_OUTPUT_TOKENS = 20_000; // hard cap on compression sideQuery output (thinking + summary combined)
const SUMMARY_RESERVE = 20_000; // output reservation subtracted from the top of the window by the threshold ladder = maxOutput
const AUTOCOMPACT_BUFFER = 13_000; // gap between auto and effectiveWindow
const WARN_BUFFER = 20_000; // gap between warn and auto
const HARD_BUFFER = 3_000; // gap between hard and effectiveWindow
const MAX_CONSECUTIVE_FAILURES = 3; // failure circuit-breaker threshold
```

Source of the values: all carried over from claude-code's measured values ([autoCompact.ts:30,62-65](src/services/compact/autoCompact.ts:30)).

`SUMMARY_RESERVE = COMPACT_MAX_OUTPUT_TOKENS` is the key relationship: the model is constrained by the `maxOutputTokens` hard limit, so output cannot exceed 20K, and therefore the reserve does not need an extra safety margin. Note: this design's equality holds once thinking is disabled (the entire output budget goes to the summary); if thinking is kept, `thinking + summary` share the budget (the `maxOutputTokens` semantics of the Gemini SDK / most providers), the model allocates between the two on its own, and in that case the summary's actually available space is less than 20K (see "Risks and Caveats" items 1 and 2).

## Computation Function

```ts
export interface CompactionThresholds {
  warn: number;
  auto: number;
  hard: number; // equals auto when hard < auto (small-window degeneration)
  effectiveWindow: number;
}

export function computeThresholds(window: number): CompactionThresholds {
  const effectiveWindow = window - SUMMARY_RESERVE;

  const absAuto = effectiveWindow - AUTOCOMPACT_BUFFER;
  const auto = Math.max(DEFAULT_PCT * window, absAuto);

  const absWarn = auto - WARN_BUFFER;
  const warn = Math.max((DEFAULT_PCT - WARN_PCT_OFFSET) * window, absWarn);

  const rawHard = effectiveWindow - HARD_BUFFER;
  const hard = Math.max(rawHard, auto); // degenerates to auto on small windows

  return { warn, auto, hard, effectiveWindow };
}
```

### Measured Data

| Window | warn        | auto        | hard          | Notes                            |
| ------ | ----------- | ----------- | ------------- | -------------------------------- |
| 32K    | 19.2K (pct) | 22.4K (pct) | 22.4K (degen) | ratio fallback                   |
| 64K    | 38.4K (pct) | 44.8K (pct) | 44.8K (degen) | ratio fallback                   |
| 128K   | 76.8K (pct) | 95K (abs)   | 105K (abs)    | hybrid (warn=pct, auto/hard=abs) |
| 200K   | 147K (abs)  | 167K (abs)  | 177K (abs)    | absolute takes over              |
| 256K   | 203K (abs)  | 223K (abs)  | 233K (abs)    | absolute takes over              |
| 1M     | 947K (abs)  | 967K (abs)  | 977K (abs)    | fully absolute                   |

`(pct)` means the tier is determined by the ratio formula, `(abs)` means it is determined by the absolute-value formula.

## User Configuration

### ChatCompressionSettings Changes

```ts
// packages/core/src/config/config.ts:217
export interface ChatCompressionSettings {
  /** Kept (unrelated to this design, used by compactionInputSlimming) */
  imageTokenEstimate?: number;
}
```

**Removed:** the `contextPercentageThreshold` field. Rationale:

1. Under the new formula, for mainstream windows (>= 128K) this field has almost no effect — the absolute value takes over
2. On small windows, user configuration could instead cause the threshold to compress "earlier", which is counter to the intuition of saving tokens
3. claude-code does not expose this field, so there is no comparable precedent for a user-facing configuration

### Breaking Change Handling

**User-facing:** when `Config` loading at startup finds that `chatCompression.contextPercentageThreshold` is present:

- Write one warning line to stderr: `"chatCompression.contextPercentageThreshold has been removed and is now controlled by built-in thresholds."`
- Does **not** error out and does **not** block startup
- The field value is ignored

**SDK-facing (R5.4):** the `hasFailedCompressionAttempt: boolean` field of `CompressOptions` is renamed to `consecutiveFailures: number`. Two differences:

|           | Old field                                 | New field                                                                                         |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Name      | `hasFailedCompressionAttempt`             | `consecutiveFailures`                                                                             |
| Type      | `boolean`                                 | `number`                                                                                          |
| Semantics | `true` = permanently disable auto-compact | `>= MAX_CONSECUTIVE_FAILURES` (default 3) = temporarily disable until a force succeeds and resets |

Within the repo there is only one internal consumer, `GeminiChat.tryCompress`, so the internal migration risk is low; but `@qwen-code/qwen-code-core` is a published package, `CompressOptions` is visible in the d.ts, so downstream SDK code that directly calls `service.compress({ ..., hasFailedCompressionAttempt: true })` will get a TS compile error. **Migration guide:** change `true` to `MAX_CONSECUTIVE_FAILURES` (or any integer >= 3), and change `false` to `0`. If the caller maintains its own failure count, just pass it in directly.

## Token Estimation Compensation

qwen-code's `lastPromptTokenCount` comes from the previous turn's API response `usageMetadata.totalTokenCount` ([geminiChat.ts:1217-1232](packages/core/src/core/geminiChat.ts:1217)). This leads to:

1. **Lagging one turn**: the cheap-gate uses `lastPromptTokenCount` to decide, but the actual prompt of this send = it + this turn's user message. The under-counted part may cause a false-negative in the threshold decision
2. **First turn is 0**: the initial value is 0, so on the first send no threshold fires no matter how large the history is (including `--continue` restore / sub-agent inheritance scenarios)

Introduce a lightweight local estimation function `estimatePromptTokens` to fill in these two missing pieces during the cheap-gate / hard decision before send:

```ts
// chatCompressionService.ts (or a new file packages/core/src/services/tokenEstimation.ts)

const BYTES_PER_TOKEN = 4; // general char/4 estimation (same as claude-code)
const BYTES_PER_TOKEN_JSON = 2; // JSON / tool_call input is denser

/**
 * Estimate the token count of a set of Content, used to compensate for the lag in API usage metadata.
 * For image / document, reuse the existing imageTokenEstimate (default 1600).
 */
export function estimateContentTokens(
  contents: Content[],
  imageTokenEstimate = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  // Reuse estimateContentChars (compactionInputSlimming.ts), then divide by bytesPerToken
  // Internally use BYTES_PER_TOKEN_JSON for functionCall / functionResponse
  // ...
}

/**
 * Unified entry point for the cheap-gate and hard decisions.
 * Main path: lastPromptTokenCount is accurate + estimate this turn's user message
 * First-turn path: estimate full history
 */
export function estimatePromptTokens(
  history: Content[],
  userMessage: Content,
  lastPromptTokenCount: number,
): number {
  if (lastPromptTokenCount > 0) {
    return lastPromptTokenCount + estimateContentTokens([userMessage]);
  }
  return estimateContentTokens([...history, userMessage]);
}
```

Application sites:

- The cheap-gate of `chatCompressionService.compress()`: change the source of `originalTokenCount` to `estimatePromptTokens(history, userMessage, lastPromptTokenCount)`
- The hard decision at the entry of `geminiChat.sendMessageStream` (see the next section)

**Estimation is used only to trigger earlier, never to "skip triggering".** Because char/4 is a rough lower-bound estimate, it is safe on the false-positive side (better to compress a little early), but unreliable on the false-negative side.

## Trigger Path Changes

### chatCompressionService.ts

1. **Export `computeThresholds`**, for reuse by the cheap-gate / UI / commands
2. **`compress()` cheap-gate** (line 221-249):
   ```ts
   if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !force) {
     return NOOP;
   }
   const { auto } = computeThresholds(contextLimit);
   const effectiveTokens = estimatePromptTokens(
     curatedHistory,
     userMessage,
     originalTokenCount,
   );
   if (!force && effectiveTokens < auto) return NOOP;
   ```
3. **The runSideQuery call in `compress()`** (line 356-380): disable thinking + add `maxOutputTokens`:

   ```ts
   const summaryResult = await runSideQuery(config, {
     // ...
     config: {
       thinkingConfig: { includeThoughts: false }, // disable thinking (consistent with claude-code)
       maxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS, // hard cap 20K
     },
     // ...
   });
   ```

   Or just delete `thinkingConfig` and let `runSideQuery`'s default value ([sideQuery.ts:118](packages/core/src/utils/sideQuery.ts:118) defaults to `includeThoughts: false`) take over.

   With thinking disabled, `maxOutputTokens` directly constrains the total output (there is no separate thinking budget problem), and `SUMMARY_RESERVE = maxOutput = 20K` is a clean hard relationship.

   Also update the comment at [chatCompressionService.ts:374-376](packages/core/src/services/chatCompressionService.ts:374), changing it from "Compression quality drives every subsequent main turn — keep reasoning on" to explain "to guarantee a predictable output cap across providers, aligned with the claude-code design".

   The "may include non-persisted tokens (thoughts)" comment in the token math section ([:436-437](packages/core/src/services/chatCompressionService.ts:436)) can also be cleaned up at the same time

### geminiChat.ts: `sendMessageStream` entry (line 562)

```ts
// Before: tryCompress(force=false)
// After: use the estimated token count to decide whether to trigger hard, determining the force flag

const { hard } = computeThresholds(contextLimit);
const effectiveTokens = estimatePromptTokens(
  this.getHistory(true),
  createUserContent(params.message),
  this.lastPromptTokenCount,
);
const shouldForceFromHard = effectiveTokens >= hard;

if (shouldForceFromHard) {
  // Reset the circuit breaker, equivalent to force compress
  this.consecutiveFailures = 0;
}

compressionInfo = await this.tryCompress(
  prompt_id,
  model,
  shouldForceFromHard,
  params.config?.abortSignal,
);
```

### Failure Handling Upgrade (`geminiChat.ts:504-510`)

```ts
// Before
hasFailedCompressionAttempt: boolean;

// After
consecutiveFailures: number;  // default 0

// Failure branch
} else if (isCompressionFailureStatus(info.compressionStatus)) {
  if (!force) {
    this.consecutiveFailures += 1;
  }
}

// Success branch
this.consecutiveFailures = 0;
```

A failed `force=true` call does not count toward the counter (preserving the existing semantics that reactive / manual calls do not "use up quota").

## UI Changes

### tipRegistry.ts: rewrite the three context-\* tips

The three threshold tiers map one-to-one onto the three tips. The mapping (by token count from low to high):

| Tip ID             | Current condition                             | New condition                                                       | Copy change                                                                              |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `compress-intro`   | `pct >= 50 && < 80 && sessionPromptCount > 5` | `tokenCount >= warn && tokenCount < auto && sessionPromptCount > 5` | unchanged                                                                                |
| `context-high`     | `pct >= 80 && < 95`                           | `tokenCount >= auto && tokenCount < hard`                           | unchanged                                                                                |
| `context-critical` | `pct >= 95`                                   | `tokenCount >= hard`                                                | add a line "Auto-compact will force on next send." reflecting the new hard-tier behavior |

**Impact on trigger frequency:**

- Main path (auto works normally): once `tokenCount` crosses auto, compression triggers immediately, the next turn's tokenCount drops back, so `context-high` is only briefly visible "between triggering and compression taking effect"
- Edge path (auto failed / circuit-broken / reactive too late): `tokenCount` keeps rising and passes through warn → auto → hard in turn, triggering all three tips, consistent with the user's view of "context getting tighter and tighter"
- When `context-critical` fires, the hard tier has already force-compressed before send (the "trigger path changes" section of the spec), so this tip is actually a "post-rescue notice" rather than a "pre-rescue warning", and the copy adds a line to explain this

The `TipContext` interface adds:

```ts
export interface TipContext {
  lastPromptTokenCount: number;
  contextWindowSize: number;
  sessionPromptCount: number;
  sessionCount: number;
  platform: string;
  // New: let the isRelevant function get the thresholds.
  // computeThresholds is computed by the caller and injected, to avoid tipRegistry depending on core directly.
  thresholds?: CompactionThresholds;
}
```

Inject it at the same time when `AppContainer.tsx:1150` constructs `TipContext`.

### /context Command Sync (`contextCommand.ts:177-183`)

```ts
// Replace the hardcoded (1 - threshold) * contextWindowSize
const { warn, auto, hard, effectiveWindow } =
  computeThresholds(contextWindowSize);

// Display four lines:
//   Effective window:   180K   (window − 20K reserve)
//   Warn threshold:     147K   (...)
//   Auto threshold:     167K   ← current position
//   Hard threshold:     177K
// Mark which tier the current token count falls into
```

### Footer Persistent Prompt (optional follow-up)

This spec does not require implementing a footer persistent prompt, for the following reasons:

- The existing tip system can already surface prompts in the history
- A footer persistent prompt requires changing ink rendering and increasing the redraw frequency
- It can be a post-spec follow-up (a separate PR)

If it is done later, the recommended trigger condition is `tokenCount >= warn && tokenCount < auto`, hidden once auto is exceeded (compression has already begun).

## Test Coverage

### Unit Tests (chatCompressionService.test.ts)

- `computeThresholds(32K)` → ratio fallback branch (both warn/auto are pct, hard degenerates)
- `computeThresholds(128K)` → hybrid branch (warn=pct, auto=abs, hard=abs)
- `computeThresholds(200K)` → absolute-takeover branch (warn/auto/hard all abs)
- `computeThresholds(1M)` → fully-absolute branch
- `computeThresholds(window=10K)` → extremely small window (absolute values all negative), the formula does not break
- The three thresholds always satisfy `warn <= auto <= hard`
- The max() formula is stable at the boundary point (pct \* window == abs)

### Unit Tests (tokenEstimation.test.ts)

- `estimateContentTokens` uses the corresponding bytesPerToken for plain text / json / functionCall / functionResponse / image / document respectively
- `estimatePromptTokens` takes the "main path" when `lastPromptTokenCount > 0`, and the "first-turn path" when it equals 0
- A large user message, once added in the cheap-gate stage, can cross the auto threshold
- The deviation between the estimate and the real API usage is within ±30% (regression against real history samples)

### Integration Tests (geminiChat.test.ts / chatCompressionService.test.ts)

- After 3 consecutive failures the cheap-gate NOOPs; recovery after the next force
- A single failure no longer permanently locks
- After the estimated token count crosses hard, send automatically force-compresses
- The compression sideQuery call passes `maxOutputTokens = COMPACT_MAX_OUTPUT_TOKENS` correctly through to `runSideQuery`, and `thinkingConfig.includeThoughts` is `false` (or taken over by the sideQuery default)
- **First-turn coverage**: construct a chat with `lastPromptTokenCount = 0` but a huge history (simulating `--continue` restore); on the first send the auto threshold can be triggered via the estimation path

### Compatibility Tests

- Starting with `contextPercentageThreshold = 0.5` set → stderr warning + the field is ignored, and behavior follows the internal PCT constant

### Tip System Tests (tipRegistry.test.ts)

- The three context-\* tips trigger correctly when crossing warn/auto/hard, and the ranges do not overlap
- On the main path, after the auto threshold triggers compression, `context-high` is not persistently visible
- On the edge path (circuit-broken + token keeps rising), the three tips trigger in turn
- Behavior is reasonable when TipContext lacks `thresholds` (fallback)

## Implementation Phasing

| Phase | Content                                                                                                        | Independence                             |
| ----- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1     | Internal constants + `computeThresholds` + cheap-gate change (without estimation compensation)                 | can be merged independently              |
| 2     | Failure handling upgrade (1 → 3 circuit breaker)                                                               | can be merged independently              |
| 3     | Move the hard-tier force compress earlier                                                                      | depends on P1 + P7                       |
| 4     | Configuration-surface change + breaking-change warning                                                         | depends on P1                            |
| 5     | UI (tip rewrite + /context)                                                                                    | depends on P1                            |
| 6     | Compression sideQuery: disable thinking + add `maxOutputTokens` cap                                            | independent, can land before P1          |
| 7     | Token estimation compensation (`estimateContentTokens` + `estimatePromptTokens`, applied to cheap-gate / hard) | independent, can run in parallel with P1 |

Each Phase can be a separate PR. The recommended merge order is **P6 → P7 → P1 → P2 → P4 → P3 → P5**: first put a `maxOutputTokens` cap on the compression call (so the buffer assumption is trustworthy); then add estimation compensation (so the token-count decision is more reliable); then land the threshold infrastructure; then do the failure circuit breaker and configuration-surface change; and only last open the hard tier for proactive rescue (by which point there is already a reliable token count + circuit breaker). Each PR can be verified independently and rolled back independently.

## Risks and Caveats

1. **Disabling thinking may affect summary quality.** The original author's comment "Compression quality drives every subsequent main turn — keep reasoning on" expressed this concern. This spec's judgment is that "a predictable token cap" takes priority over "maximizing quality", but after landing we need to observe the distribution of `compression_input_token_count` / `compression_output_token_count` in telemetry, as well as the change in main-conversation quality after compression (user feedback, `COMPRESSION_FAILED_*` status rate). If quality drops noticeably, consider rolling back to thinking enabled + provider-specific thinkingBudget control.

2. **Hitting the `maxOutputTokens` cap may cause the summary to be truncated.** With thinking disabled, 20K directly limits the summary body; claude-code measured p99.99 ≈ 17K, leaving ~3K of safety margin. But qwen-code's compression prompt differs from claude-code's, so the distribution needs to be observed. It is recommended to add a "detected finish_reason = MAX_TOKENS" NOOP path in the compression failure branch ([chatCompressionService.ts:464-491](packages/core/src/services/chatCompressionService.ts:464)), to avoid persisting a half-finished summary.

3. **Differences in the cross-provider maxOutputTokens mapping.** OpenAI compat (dashscope) → `max_tokens`, Anthropic → `max_tokens`, Gemini SDK → `maxOutputTokens`. qwen-code already has this mapping layer ([contentGenerator.ts:94](packages/core/src/core/contentGenerator.ts:94) etc.); when implementing P6, we need to verify that on the sideQuery path the `maxOutputTokens` field really threads through to the request body of every provider.

4. **Token estimation is a rough lower bound and should not be used in reverse as the basis for "skip triggering".** `char/4` may deviate ±30% from each provider's real tokenizer. This spec uses the estimate only to "trigger the threshold earlier" (the false-positive direction, better to compress early than late). All code paths that "reduce the token count / skip compression" should still use `lastPromptTokenCount` (the authoritative API value).

5. **The relationship between the estimation function and the existing `estimateContentChars`.** [compactionInputSlimming.ts](packages/core/src/services/compactionInputSlimming.ts) already has `estimateContentChars` (used for compression split-point calculation), and the new `estimateContentTokens` should reuse it (dividing by bytesPerToken) rather than writing a separate one, to avoid the two estimation conventions diverging.

## Out of Scope for This Spec

- Env-variable override channel (option D): maintain the "minimal configuration surface" principle
- Persistent footer visualization: left as a follow-up
- Summary prompt improvements, `MIN_COMPRESSION_FRACTION` adjustments: orthogonal to the threshold design

## Open Questions (pending review)

1. **Strength of the breaking change**: warn + ignore the field vs. error out at startup. Currently warn is chosen; needs confirmation on whether it is friendly enough for enterprise deployments / team configurations

## Resolved

2. **On small windows (≤ ~76.7K), hard and auto degenerate to the same value** — decided **not to make it explicit in `/context`**. Rationale:
   - The collapse range is not only 32K; all windows where `effectiveWindow - HARD_BUFFER ≤ 0.7 × window` collapse (including 64K)
   - User behavior does not change: on a collapsed window `currentTier` skips `'auto'` and reports `'hard'` directly (`contextCommand.ts:43-44` checks `>= hard` first), and the `context-high` band (`auto ≤ t < hard`) becomes an empty band; having one fewer prompt tier on small windows is reasonable — the window itself is small, and the user most likely manages context manually
   - If a real user later reports "can't see the middle-tier prompt on small windows", then decide whether to add a UI annotation or adjust the `context-high` trigger condition (this is UI work, not spec work). For now we choose not to add UI complexity
