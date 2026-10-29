# Auto-Compaction Threshold Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade qwen-code's single-tier proportional auto-compaction threshold (70%) into a "proportional + absolute" mixed three-tier threshold ladder (warn / auto / hard), while also capping the compression call itself with a `maxOutputTokens` limit, disabling thinking, introducing a failure circuit breaker, fixing the lag / first-turn gaps in `lastPromptTokenCount`, and cleaning up the user configuration surface.

**Architecture:**

- `chatCompressionService.ts` adds `computeThresholds(window)` that outputs `{ warn, auto, hard }`; the cheap-gate uses `auto`, and the `sendMessageStream` entry point adds proactive hard-tier rescue.
- Add `tokenEstimation.ts` providing a local char/4 estimation function to compensate for the two gaps in `lastPromptTokenCount` ("lags by one turn" + "0 on the first turn").
- Failure handling is upgraded from the single-shot `hasFailedCompressionAttempt: boolean` lock to a three-strike `consecutiveFailures: number` circuit breaker.
- The compression sideQuery call disables thinking + adds `maxOutputTokens: 20K`.
- Remove the `chatCompression.contextPercentageThreshold` settings field; on startup, when an old config is encountered, print a stderr warning and ignore it.
- The three context-\* tips in `tipRegistry.ts` are rewritten to follow the new thresholds; the `/context` command displays the three-tier values.

**Tech Stack:** TypeScript, Vitest, `@google/genai`, the existing `compactionInputSlimming` estimation utility.

**Merge order:** P6 → P7 → P1 → P2 → P4 → P3 → P5. Each Task is a single-PR candidate.

---

## File Structure

| Path                                                        | Operation     | Responsibility                                                                                                 |
| ----------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/services/tokenEstimation.ts`             | Create        | Character-level token estimation + `estimatePromptTokens` entry point                                          |
| `packages/core/src/services/tokenEstimation.test.ts`        | Create        | Unit tests for the estimation functions                                                                        |
| `packages/core/src/services/chatCompressionService.ts`      | Modify        | Add constants + `computeThresholds`; change cheap-gate; disable thinking + maxOutput; change failure counting  |
| `packages/core/src/services/chatCompressionService.test.ts` | Modify        | computeThresholds unit tests + cheap-gate / sideQuery config assertions                                        |
| `packages/core/src/core/geminiChat.ts`                      | Modify        | Add a hard check at the `sendMessageStream` entry point; `hasFailedCompressionAttempt` → `consecutiveFailures` |
| `packages/core/src/core/geminiChat.test.ts`                 | Modify        | hard trigger + circuit breaker + first-turn coverage integration tests                                         |
| `packages/core/src/config/config.ts`                        | Modify        | `ChatCompressionSettings` removes `contextPercentageThreshold`; startup warning                                |
| `packages/cli/src/services/tips/tipRegistry.ts`             | Modify        | The three context-\* tips switch to absolute threshold comparison; `TipContext` adds `thresholds`              |
| `packages/cli/src/services/tips/tipRegistry.test.ts`        | Create/Modify | tip trigger-range tests                                                                                        |
| `packages/cli/src/ui/commands/contextCommand.ts`            | Modify        | Display the new three-tier thresholds                                                                          |
| `packages/cli/src/ui/commands/contextCommand.test.ts`       | Modify        | Output snapshot                                                                                                |
| `packages/cli/src/ui/AppContainer.tsx`                      | Modify        | Inject `thresholds` when constructing `TipContext`                                                             |

---

## Phase P6 — Compression sideQuery disables thinking + adds maxOutputTokens

Lands first so the subsequent threshold assumptions are credible. Standalone PR.

### Task 1: Change the sideQuery call in chatCompressionService

**Files:**

- Modify: `packages/core/src/services/chatCompressionService.ts:374-376`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

Add a spy entry to the import section at the top of `chatCompressionService.test.ts`, and add the test in an appropriate describe block. `runSideQuery` is already a module export, so it can be spied on:

```ts
import * as sideQueryModule from '../utils/sideQuery.js';

describe('ChatCompressionService.compress sideQuery config', () => {
  it('passes maxOutputTokens=20_000 and includeThoughts=false to runSideQuery', async () => {
    const spy = vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>summary</state_snapshot>',
      usage: {
        promptTokenCount: 1000,
        candidatesTokenCount: 500,
        totalTokenCount: 1500,
      },
    } as any);

    const service = new ChatCompressionService();
    await service.compress(makeFakeChat(), {
      promptId: 'p',
      force: true,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      hasFailedCompressionAttempt: false,
      originalTokenCount: 180_000,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const callArg = spy.mock.calls[0]![1];
    expect(callArg.config?.thinkingConfig?.includeThoughts).toBe(false);
    expect(callArg.config?.maxOutputTokens).toBe(20_000);
  });
});
```

`makeFakeChat` / `makeFakeConfig` reuse the existing test helpers (if they already exist in the file, use them directly; otherwise inline a minimal stub).

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts -t 'passes maxOutputTokens=20_000'
```

Expected: FAIL — currently `{ thinkingConfig: { includeThoughts: true } }` is passed in, and there is no `maxOutputTokens`.

- [ ] **Step 3: Implement — modify chatCompressionService.ts**

Replace the entire `config:` block at [chatCompressionService.ts:374-376](packages/core/src/services/chatCompressionService.ts:374):

```ts
const summaryResult = await runSideQuery(config, {
  purpose: 'chat-compression',
  model,
  maxAttempts: 1,
  systemInstruction: getCompressionPrompt(),
  contents: [
    ...slim.slimmedHistory,
    {
      role: 'user',
      parts: [
        {
          text: 'First, reason in your scratchpad. Then, generate the <state_snapshot>.',
        },
      ],
    },
  ],
  // Compression output is bounded by maxOutputTokens to guarantee a predictable
  // reserve across providers (see docs/design/auto-compaction-threshold-redesign.md).
  // Thinking is disabled because per-provider thinking-budget semantics are
  // inconsistent (Anthropic/OpenAI count it separately, Gemini varies by model).
  config: {
    thinkingConfig: { includeThoughts: false },
    maxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS,
  },
  abortSignal: signal ?? new AbortController().signal,
  promptId,
});
```

In the constants section at the top of the file (right after `TOOL_ROUND_RETAIN_COUNT`), add:

```ts
/**
 * Hard cap on the compression sideQuery output (summary text only, since
 * thinking is disabled). Mirrors claude-code's MAX_OUTPUT_TOKENS_FOR_SUMMARY
 * (autoCompact.ts:30) which is based on p99.99 of real compaction outputs.
 */
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;
```

Also clean up the `"may include non-persisted tokens (thoughts)"` comment in the token math section inside `compress()` (around line 436-437) — there is no thinking output anymore, so change the sentence to "compressionOutputTokenCount reflects the summary tokens only since thinking is disabled".

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts
```

Expected: PASS (the new test + existing tests should not regress)

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/chatCompressionService.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
feat(core): cap compression sideQuery output and disable thinking

Add COMPACT_MAX_OUTPUT_TOKENS=20_000 and pass maxOutputTokens to the
runSideQuery call, disable thinkingConfig.includeThoughts. Aligns with
claude-code's autoCompact reserve so the downstream threshold ladder
(P1/P3) can rely on a predictable upper bound on summary output across
providers (Anthropic / OpenAI / Gemini handle thinking budgets
inconsistently).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P7 — Token estimation compensation

Fix the lag / first-turn gaps in `lastPromptTokenCount`. 3 Tasks.

### Task 2: Create the tokenEstimation.ts unit

**Files:**

- Create: `packages/core/src/services/tokenEstimation.ts`
- Create: `packages/core/src/services/tokenEstimation.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/src/services/tokenEstimation.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import {
  estimateContentTokens,
  estimatePromptTokens,
} from './tokenEstimation.js';

const textContent = (text: string): Content => ({
  role: 'user',
  parts: [{ text }],
});

describe('estimateContentTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateContentTokens([])).toBe(0);
  });

  it('estimates plain text at ~chars/4', () => {
    // "hello world" = 11 chars → ceil(11/4) = 3
    expect(estimateContentTokens([textContent('hello world')])).toBe(3);
  });

  it('sums tokens across multiple messages', () => {
    const a = textContent('aaaa'); // 4/4 = 1
    const b = textContent('bbbbbbbb'); // 8/4 = 2
    expect(estimateContentTokens([a, b])).toBe(3);
  });

  it('estimates inlineData via imageTokenEstimate', () => {
    const c: Content = {
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'xxx' } }],
    };
    expect(estimateContentTokens([c], 1600)).toBe(1600);
  });

  it('estimates functionCall (json-dense) at ~chars/2', () => {
    const c: Content = {
      role: 'model',
      parts: [{ functionCall: { name: 'foo', args: { a: 1, b: 2 } } }],
    };
    // estimateContentChars stringifies; the resulting JSON is short but the
    // ratio (chars/2) should make this >= chars/4 path.
    const result = estimateContentTokens([c]);
    expect(result).toBeGreaterThan(0);
  });
});

describe('estimatePromptTokens', () => {
  const history: Content[] = [
    textContent('older message a'),
    textContent('older message b'),
  ];
  const user = textContent('current user message');

  it('uses lastPromptTokenCount + user-message estimate when count > 0', () => {
    const userEst = estimateContentTokens([user]);
    expect(estimatePromptTokens(history, user, 5000)).toBe(5000 + userEst);
  });

  it('falls back to full estimate when lastPromptTokenCount is 0', () => {
    const fullEst = estimateContentTokens([...history, user]);
    expect(estimatePromptTokens(history, user, 0)).toBe(fullEst);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/tokenEstimation.test.ts
```

Expected: FAIL — `tokenEstimation.ts` has not been created yet.

- [ ] **Step 3: Implement — create tokenEstimation.ts**

`packages/core/src/services/tokenEstimation.ts`:

```ts
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  estimateContentChars,
} from './compactionInputSlimming.js';

/**
 * Average bytes-per-token for char-based token estimation.
 * Matches claude-code's roughTokenCountEstimation default (tokens.ts).
 */
const BYTES_PER_TOKEN = 4;

/**
 * Estimate the token count of a list of Content objects via char/4.
 *
 * Reuses `estimateContentChars` so that inlineData / functionCall /
 * functionResponse get the same treatment they receive when computing
 * compression split points — keeping the two estimators in sync prevents
 * the auto-compaction trigger and the splitter from disagreeing on size.
 *
 * Intended for the pre-send threshold gate only. Char/4 is a conservative
 * lower bound (real tokenizers vary ±30%); using it to TRIGGER compaction
 * earlier is safe (false-positive), using it to SKIP compaction is not.
 */
export function estimateContentTokens(
  contents: Content[],
  imageTokenEstimate: number = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  let totalChars = 0;
  for (const content of contents) {
    totalChars += estimateContentChars(content, imageTokenEstimate);
  }
  return Math.ceil(totalChars / BYTES_PER_TOKEN);
}

/**
 * Compute an effective prompt-token count for the auto-compaction gate.
 *
 * `lastPromptTokenCount` (from the previous turn's usage metadata) lacks
 * two things: the current user message, and any initial value on the
 * very first send. This helper closes both gaps via local estimation.
 */
export function estimatePromptTokens(
  history: Content[],
  userMessage: Content,
  lastPromptTokenCount: number,
  imageTokenEstimate: number = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  if (lastPromptTokenCount > 0) {
    return (
      lastPromptTokenCount +
      estimateContentTokens([userMessage], imageTokenEstimate)
    );
  }
  return estimateContentTokens([...history, userMessage], imageTokenEstimate);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/tokenEstimation.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/tokenEstimation.ts packages/core/src/services/tokenEstimation.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add token estimation helper for compaction gate

Introduce estimateContentTokens / estimatePromptTokens built on the
existing estimateContentChars (compactionInputSlimming) divided by a
char/4 ratio. Will replace raw lastPromptTokenCount usage at the cheap-
gate and hard-threshold checks so the system can react to (a) the
current user message and (b) the very first send (where the API-
reported count is 0).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3: Apply estimation at the chatCompressionService cheap-gate

**Files:**

- Modify: `packages/core/src/services/chatCompressionService.ts`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

This Task lands before P1, so it uses the **existing** `threshold * contextLimit` formula (70% \* 200K = 140K) and only replaces `originalTokenCount` with `estimatePromptTokens(...)`:

```ts
import * as sideQueryModule from '../utils/sideQuery.js';

describe('ChatCompressionService.compress cheap-gate uses estimated tokens', () => {
  it('triggers compaction when API-reported tokens are below threshold but estimated tokens with the pending user message exceed it', async () => {
    // Current threshold for a 200K window = 0.7 * 200K = 140K
    // originalTokenCount = 135K (5K short)
    // user message estimate ~10K → 145K, crosses 140K
    const userMessage: Content = {
      role: 'user',
      parts: [{ text: 'x'.repeat(40_000) }], // 40K chars ≈ 10K tokens
    };
    const chat = makeFakeChat({ historyChars: 500_000 });

    // Mock runSideQuery so the later steps of compress don't blow up
    vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>x</state_snapshot>',
      usage: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150,
      },
    } as any);

    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      hasFailedCompressionAttempt: false,
      originalTokenCount: 135_000,
      pendingUserMessage: userMessage,
    });
    expect(result.info.compressionStatus).not.toBe(CompressionStatus.NOOP);
  });

  it('NOOPs when neither originalTokenCount nor estimated total reaches threshold', async () => {
    const chat = makeFakeChat();
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      hasFailedCompressionAttempt: false,
      originalTokenCount: 80_000,
      pendingUserMessage: {
        role: 'user',
        parts: [{ text: 'short' }],
      },
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
  });
});
```

`makeFakeChat({ historyChars })` is an inline helper in the test file: it constructs a `GeminiChat` stand-in whose `getHistory()` returns a Content array whose length approximately matches `historyChars` (reuse the helper if the file already has one).

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts -t 'cheap-gate uses estimated tokens'
```

Expected: FAIL — the current cheap-gate only looks at `originalTokenCount`, so it decides NOOP.

- [ ] **Step 3: Implement — change the compress() cheap-gate**

Modify this block at [chatCompressionService.ts:235-249](packages/core/src/services/chatCompressionService.ts:235):

```ts
// Don't compress if not forced and we are under the limit. This is the
// steady-state path on every send; we want to exit before paying for the
// full `getHistory(true)` clone below.
if (!force) {
  const contextLimit =
    config.getContentGeneratorConfig()?.contextWindowSize ??
    DEFAULT_TOKEN_LIMIT;
  const pendingUserMessage = opts.pendingUserMessage;
  const effectiveTokens = pendingUserMessage
    ? estimatePromptTokens(
        chat.getHistory(true),
        pendingUserMessage,
        originalTokenCount,
        slimmingConfig.imageTokenEstimate,
      )
    : originalTokenCount;
  if (effectiveTokens < threshold * contextLimit) {
    return {
      newHistory: null,
      info: {
        originalTokenCount,
        newTokenCount: originalTokenCount,
        compressionStatus: CompressionStatus.NOOP,
      },
    };
  }
}
```

The `CompressOptions` interface ([:172-196](packages/core/src/services/chatCompressionService.ts:172)) gains a new field:

```ts
export interface CompressOptions {
  // ... existing fields ...
  /**
   * Pending user message about to be sent. When present, the cheap-gate
   * adds its estimated token count to `originalTokenCount` (which reflects
   * only the prior turn's API usage) so the gate sees the real prompt size.
   * Optional for backward compatibility with callers that don't have a
   * user message in hand (e.g. manual /compress force=true paths).
   */
  pendingUserMessage?: Content;
}
```

Add the import: `import { estimatePromptTokens } from './tokenEstimation.js';`

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/chatCompressionService.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
feat(core): cheap-gate uses estimated tokens when user message is pending

Add `pendingUserMessage` to CompressOptions and feed it through
estimatePromptTokens at the auto-compaction cheap-gate. Closes the
'lag by one turn' gap where the threshold check missed the user
message about to be sent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4: Pass pendingUserMessage through the geminiChat sendMessageStream entry point

**Files:**

- Modify: `packages/core/src/core/geminiChat.ts`
- Modify: `packages/core/src/core/geminiChat.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/core/geminiChat.test.ts`:

```ts
describe('sendMessageStream first-turn estimation', () => {
  it('triggers auto-compaction on the very first send when inherited history is huge', async () => {
    // Simulate a sub-agent inheriting a large history / --continue scenario:
    // lastPromptTokenCount = 0, but history is already filled close to the auto threshold
    const chat = makeChatWithLargeInheritedHistory(/* ~150K chars worth */);
    expect(chat.getLastPromptTokenCount()).toBe(0);

    const mockGen = mockContentGeneratorWithUsage({
      totalTokenCount: 80_000,
    });
    chat.setContentGenerator(mockGen);

    const stream = await chat.sendMessageStream(
      'qwen-test',
      { message: 'next user prompt' },
      'prompt-1',
    );
    // Collect the first event of the stream; it should be COMPRESSED
    const first = await stream.next();
    expect(first.value?.type).toBe(StreamEventType.COMPRESSED);
  });
});
```

The `makeChatWithLargeInheritedHistory` helper is inline in the test file: it constructs a `GeminiChat` with `history` loaded with 1500 simple user/model contents of 100 chars each, ~150K chars in total.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts -t 'first-turn estimation'
```

Expected: FAIL — the current `tryCompress` uses `lastPromptTokenCount = 0`, so the cheap-gate decides NOOP.

- [ ] **Step 3: Implement — change sendMessageStream and tryCompress**

Change [geminiChat.ts:562](packages/core/src/core/geminiChat.ts:562) to:

```ts
compressionInfo = await this.tryCompress(
  prompt_id,
  model,
  false,
  params.config?.abortSignal,
  {
    pendingUserMessage: createUserContent(params.message),
  },
);
```

The `options` interface `TryCompressOptions` of the `tryCompress` function signature (around [:460-478](packages/core/src/core/geminiChat.ts:460)) gains:

```ts
interface TryCompressOptions {
  originalTokenCountOverride?: number;
  trigger?: CompactTrigger;
  pendingUserMessage?: Content; // ← new
}
```

Pass `pendingUserMessage` through to `service.compress`:

```ts
const { newHistory, info } = await service.compress(this, {
  // ... existing fields ...
  pendingUserMessage: options?.pendingUserMessage,
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/geminiChat.ts packages/core/src/core/geminiChat.test.ts
git commit -m "$(cat <<'EOF'
feat(core): pass pendingUserMessage from sendMessageStream to tryCompress

Closes the 'first send after inherited history' gap where
lastPromptTokenCount is 0 and the cheap-gate would always NOOP.
estimatePromptTokens falls back to a full-history estimate in that
case once the user message is provided.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P1 — Three-tier threshold constants + computeThresholds + cheap-gate

### Task 5: Add the constants and the computeThresholds function

**Files:**

- Modify: `packages/core/src/services/chatCompressionService.ts`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `chatCompressionService.test.ts`:

```ts
import { computeThresholds } from './chatCompressionService.js';

describe('computeThresholds', () => {
  it('32K window — proportional fallback for all tiers, hard degrades to auto', () => {
    const t = computeThresholds(32_000);
    expect(t.warn).toBe(19_200); // 0.6 * 32K
    expect(t.auto).toBe(22_400); // 0.7 * 32K
    expect(t.hard).toBe(22_400); // max(window-23K=9K, auto=22.4K) = auto
    expect(t.effectiveWindow).toBe(12_000);
  });

  it('128K window — mixed (warn=pct, auto/hard=abs)', () => {
    const t = computeThresholds(128_000);
    expect(t.warn).toBe(76_800); // 0.6 * 128K (pct wins: 76.8K vs auto-20K=75K)
    expect(t.auto).toBe(95_000); // abs: window-33K (abs wins: 95K vs 0.7*128K=89.6K)
    expect(t.hard).toBe(105_000); // abs: window-23K
    expect(t.effectiveWindow).toBe(108_000);
  });

  it('200K window — absolute takes over all tiers', () => {
    const t = computeThresholds(200_000);
    expect(t.warn).toBe(147_000); // abs: auto-20K (abs wins: 147K vs 0.6*200K=120K)
    expect(t.auto).toBe(167_000); // abs: 200K-33K
    expect(t.hard).toBe(177_000); // abs: 200K-23K
  });

  it('1M window — fully absolute', () => {
    const t = computeThresholds(1_000_000);
    expect(t.warn).toBe(947_000);
    expect(t.auto).toBe(967_000);
    expect(t.hard).toBe(977_000);
  });

  it('extreme small window (10K) does not crash; returns sane values', () => {
    const t = computeThresholds(10_000);
    expect(t.warn).toBeGreaterThan(0);
    expect(t.auto).toBeGreaterThan(0);
    expect(t.warn).toBeLessThanOrEqual(t.auto);
    expect(t.auto).toBeLessThanOrEqual(t.hard);
  });

  it('thresholds always satisfy warn <= auto <= hard', () => {
    for (const w of [32_000, 64_000, 128_000, 200_000, 256_000, 1_000_000]) {
      const t = computeThresholds(w);
      expect(t.warn).toBeLessThanOrEqual(t.auto);
      expect(t.auto).toBeLessThanOrEqual(t.hard);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts -t 'computeThresholds'
```

Expected: FAIL — `computeThresholds` does not exist.

- [ ] **Step 3: Implement — add the constants and function**

In the constants section of [chatCompressionService.ts](packages/core/src/services/chatCompressionService.ts) (right after `COMPACT_MAX_OUTPUT_TOKENS`), add:

```ts
/**
 * Default proportional auto-compaction threshold (legacy semantics
 * preserved as a small-window fallback / safety net).
 */
export const DEFAULT_PCT = 0.7;

/**
 * Warn-tier proportional offset: warn-pct = PCT - WARN_PCT_OFFSET (= 0.6).
 */
export const WARN_PCT_OFFSET = 0.1;

/**
 * Token budget reserved for compression output. Matches COMPACT_MAX_OUTPUT_TOKENS
 * because thinking is disabled (see Task 1) so maxOutputTokens is the hard
 * ceiling on summary output.
 */
export const SUMMARY_RESERVE = COMPACT_MAX_OUTPUT_TOKENS; // 20_000

/** Distance between auto threshold and effectiveWindow. */
export const AUTOCOMPACT_BUFFER = 13_000;

/** Distance between warn threshold and auto threshold. */
export const WARN_BUFFER = 20_000;

/** Distance between hard threshold and effectiveWindow (claude-code MANUAL_COMPACT_BUFFER). */
export const HARD_BUFFER = 3_000;

/** Auto-compaction consecutive-failure circuit breaker. */
export const MAX_CONSECUTIVE_FAILURES = 3;

export interface CompactionThresholds {
  /** Token count at which UI warn tier triggers. */
  warn: number;
  /** Token count at which auto-compaction triggers. */
  auto: number;
  /** Token count at which auto-compaction is forced (resets failure counter). */
  hard: number;
  /** Window minus SUMMARY_RESERVE; the budget available for input + summary. */
  effectiveWindow: number;
}

/**
 * Compute the three-tier threshold ladder for a given context window.
 *
 * Each tier is `max(proportional, absolute)`:
 *   auto  = max(PCT * window,                effectiveWindow - AUTOCOMPACT_BUFFER)
 *   warn  = max((PCT - WARN_OFFSET) * window, auto - WARN_BUFFER)
 *   hard  = max(effectiveWindow - HARD_BUFFER, auto)  // hard degrades to auto for tiny windows
 *
 * Small windows (where the absolute branch goes negative) automatically fall
 * back to the proportional branch. Large windows are dominated by the absolute
 * branch, capping wasted reservation to ~33K instead of 30% of the window.
 */
export function computeThresholds(window: number): CompactionThresholds {
  const effectiveWindow = window - SUMMARY_RESERVE;

  const absAuto = effectiveWindow - AUTOCOMPACT_BUFFER;
  const auto = Math.max(DEFAULT_PCT * window, absAuto);

  const absWarn = auto - WARN_BUFFER;
  const warn = Math.max((DEFAULT_PCT - WARN_PCT_OFFSET) * window, absWarn);

  const rawHard = effectiveWindow - HARD_BUFFER;
  const hard = Math.max(rawHard, auto);

  return { warn, auto, hard, effectiveWindow };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/chatCompressionService.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add computeThresholds for three-tier compaction ladder

Introduces warn/auto/hard thresholds combining proportional fallback
(small windows) with absolute reservation (large windows). Matches the
formula in docs/design/auto-compaction-threshold-redesign.md. Pure
function with full coverage across 32K/128K/200K/1M/extreme-small
windows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6: Switch the cheap-gate to computeThresholds.auto

**Files:**

- Modify: `packages/core/src/services/chatCompressionService.ts`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('compress cheap-gate uses computeThresholds.auto', () => {
  it('on a 200K window with originalTokenCount=160K, NOOP (below auto=167K)', async () => {
    const chat = makeFakeChat();
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      hasFailedCompressionAttempt: false,
      originalTokenCount: 160_000,
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
  });

  it('on a 200K window with originalTokenCount=168K, proceeds past gate', async () => {
    // 168K > 167K (auto), the cheap-gate lets it through and enters the curatedHistory stage
    const chat = makeFakeChat({ historyChars: 500_000 });
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      hasFailedCompressionAttempt: false,
      originalTokenCount: 168_000,
    });
    // The actual result depends on the mocked sideQuery; only verify it isn't an early NOOP blocked by the cheap-gate
    expect(result.info.compressionStatus).not.toBe(CompressionStatus.NOOP);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts -t 'cheap-gate uses computeThresholds'
```

Expected: FAIL — the current threshold is `threshold * contextLimit = 0.7 * 200K = 140K`, so 160K already exceeds 140K and is let straight through by the cheap-gate (failing assertion ①); 168K is the same.

- [ ] **Step 3: Implement — switch the cheap-gate formula**

Modify the `if (!force) { ... }` block at [chatCompressionService.ts:235-249](packages/core/src/services/chatCompressionService.ts:235):

```ts
if (!force) {
  const contextLimit =
    config.getContentGeneratorConfig()?.contextWindowSize ??
    DEFAULT_TOKEN_LIMIT;
  const { auto } = computeThresholds(contextLimit);
  const pendingUserMessage = opts.pendingUserMessage;
  const effectiveTokens = pendingUserMessage
    ? estimatePromptTokens(
        chat.getHistory(true),
        pendingUserMessage,
        originalTokenCount,
        slimmingConfig.imageTokenEstimate,
      )
    : originalTokenCount;
  if (effectiveTokens < auto) {
    return {
      newHistory: null,
      info: {
        originalTokenCount,
        newTokenCount: originalTokenCount,
        compressionStatus: CompressionStatus.NOOP,
      },
    };
  }
}
```

Also delete the `const threshold = chatCompressionSettings?.contextPercentageThreshold ?? COMPRESSION_TOKEN_THRESHOLD;` line at [chatCompressionService.ts:214-217](packages/core/src/services/chatCompressionService.ts:214), since `threshold` is no longer used by the cheap-gate. Also remove the `threshold <= 0` branch at line 221 (the implicit-disable semantics, handled in detail in P4).

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/chatCompressionService.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
refactor(core): cheap-gate uses computeThresholds.auto

Replace the legacy `threshold * contextLimit` formula with
computeThresholds.auto, which combines proportional fallback with
absolute reservation. On large windows (>=128K) the gate now triggers
later than 70% but reserves a fixed ~33K, freeing tens of thousands of
context tokens that the old formula wasted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P2 — Failure handling upgrade (single-shot lock → three-strike circuit breaker)

### Task 7: hasFailedCompressionAttempt → consecutiveFailures

**Files:**

- Modify: `packages/core/src/core/geminiChat.ts`
- Modify: `packages/core/src/services/chatCompressionService.ts`
- Modify: `packages/core/src/core/geminiChat.test.ts`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

`geminiChat.test.ts`:

```ts
describe('compression failure circuit breaker', () => {
  it('tolerates 2 consecutive failures, NOOPs the third', async () => {
    const chat = makeChatWithMockedFailingCompression();
    // Trigger 3 consecutive failures:
    await chat.sendMessageStream('m', { message: 'a' }, 'p1'); // attempt 1 fails
    await chat.sendMessageStream('m', { message: 'b' }, 'p2'); // attempt 2 fails
    const events = await collectEvents(
      await chat.sendMessageStream('m', { message: 'c' }, 'p3'), // attempt 3 should NOOP
    );
    expect(
      events.find((e) => e.type === StreamEventType.COMPRESSED),
    ).toBeUndefined();
    // Verify that service.compress is not called at all the 3rd time (the circuit-breaker NOOP is at the cheap-gate)
    expect(getCompressCallCount()).toBe(2);
  });

  it('resets counter on a successful force compress', async () => {
    const chat = makeChatWithMockedFailingCompression();
    await chat.sendMessageStream('m', { message: 'a' }, 'p1'); // fail
    await chat.sendMessageStream('m', { message: 'b' }, 'p2'); // fail
    // User manually runs /compress
    await chat.tryCompress('p3', 'm', /* force */ true);
    // The circuit breaker should now be reset
    await chat.sendMessageStream('m', { message: 'c' }, 'p4');
    expect(getCompressCallCount()).toBeGreaterThan(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts -t 'circuit breaker'
```

Expected: FAIL — currently a single failure locks permanently; the 2nd send is already NOOP'd by the cheap-gate and the 3rd is also NOOP, but assertion ② expects that after a force it can recover and sendMessageStream reaches compress.

- [ ] **Step 3: Implement — replace the field**

The internal field in [geminiChat.ts](packages/core/src/core/geminiChat.ts) (grep `hasFailedCompressionAttempt`):

```ts
// before
private hasFailedCompressionAttempt = false;

// after
private consecutiveFailures = 0;
```

The fields passed to `service.compress` by the `tryCompress` function at [geminiChat.ts:467-478](packages/core/src/core/geminiChat.ts:467):

```ts
const { newHistory, info } = await service.compress(this, {
  promptId,
  force,
  model,
  config: this.config,
  consecutiveFailures: this.consecutiveFailures, // ← replaces hasFailedCompressionAttempt
  originalTokenCount:
    options?.originalTokenCountOverride ?? this.lastPromptTokenCount,
  pendingUserMessage: options?.pendingUserMessage,
  trigger: options?.trigger,
  signal,
});
```

The failure/success branches at [geminiChat.ts:503-510](packages/core/src/core/geminiChat.ts:503):

```ts
if (info.compressionStatus === CompressionStatus.COMPRESSED && newHistory) {
  // ... existing logic ...
  this.setHistory(newHistory);
  this.config.getFileReadCache().clear();
  this.lastPromptTokenCount = info.newTokenCount;
  this.telemetryService?.setLastPromptTokenCount(info.newTokenCount);
  this.consecutiveFailures = 0; // ← replaces hasFailedCompressionAttempt = false
} else if (isCompressionFailureStatus(info.compressionStatus)) {
  if (!force) {
    this.consecutiveFailures += 1; // ← replaces hasFailedCompressionAttempt = true
  }
}
```

The `CompressOptions` interface in [chatCompressionService.ts](packages/core/src/services/chatCompressionService.ts):

```ts
export interface CompressOptions {
  // ... existing fields ...
  /**
   * Number of consecutive auto-compaction failures for this chat. When
   * it reaches MAX_CONSECUTIVE_FAILURES, the gate stops trying until a
   * successful force=true call resets it.
   */
  consecutiveFailures: number;
  // remove hasFailedCompressionAttempt
}
```

The cheap-gate check at [:221](packages/core/src/services/chatCompressionService.ts:221) inside the `compress()` function:

```ts
// Cheap gates first — these don't need the curated history.
if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !force) {
  return {
    newHistory: null,
    info: {
      originalTokenCount: 0,
      newTokenCount: 0,
      compressionStatus: CompressionStatus.NOOP,
    },
  };
}
```

Update the destructuring `const { ... } = opts;` to replace `hasFailedCompressionAttempt` with `consecutiveFailures`.

In `chatCompressionService.test.ts`, change everywhere that passes `hasFailedCompressionAttempt: false/true` to `consecutiveFailures: 0` / `consecutiveFailures: MAX_CONSECUTIVE_FAILURES`, fixing the test expectations one by one.

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts packages/core/src/services/chatCompressionService.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/geminiChat.ts packages/core/src/services/chatCompressionService.ts packages/core/src/core/geminiChat.test.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
refactor(core): replace hasFailedCompressionAttempt with circuit breaker

Switches from a one-shot permanent lock to a three-strike circuit
breaker (MAX_CONSECUTIVE_FAILURES=3). Successful force compress
(manual /compress, reactive overflow, or hard-tier rescue) resets the
counter. Aligns with claude-code's design and unblocks recovery from
transient failures (rate limits, transient model errors) that
previously disabled auto-compaction for the rest of the session.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P4 — Configuration surface: remove contextPercentageThreshold + breaking-change warning

### Task 8: Remove the field + startup warning

**Files:**

- Modify: `packages/core/src/config/config.ts`
- Modify: `packages/cli/src/config/settingsSchema.ts` (if there are references)
- Modify: `packages/core/src/services/chatCompressionService.ts`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/src/config/config.test.ts` (create it if it doesn't exist):

```ts
import { describe, it, expect, vi } from 'vitest';

describe('Config — chatCompression.contextPercentageThreshold deprecation', () => {
  it('logs a stderr warning when the deprecated field is set', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Config({
      // ... minimal required Config params ...
      chatCompression: { contextPercentageThreshold: 0.5 } as any,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'chatCompression.contextPercentageThreshold has been removed',
      ),
    );
    warnSpy.mockRestore();
  });

  it('does not warn when the deprecated field is absent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Config({
      // ... minimal params, no chatCompression.contextPercentageThreshold ...
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('chatCompression.contextPercentageThreshold'),
    );
    warnSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/config/config.test.ts
```

Expected: FAIL — Config currently accepts this field outright, with no warning.

- [ ] **Step 3: Implement — change ChatCompressionSettings + the Config constructor**

[config.ts:217-227](packages/core/src/config/config.ts:217):

```ts
export interface ChatCompressionSettings {
  /**
   * Estimated tokens for a single inline image / document part when
   * apportioning chars across history in `findCompressSplitPoint`.
   * Also used as the placeholder budget when stripping inline media
   * out of the side-query compaction prompt. Default 1600.
   * Env override: `QWEN_IMAGE_TOKEN_ESTIMATE`.
   */
  imageTokenEstimate?: number;
}
```

(Remove the `contextPercentageThreshold` field.)

In [config.ts](packages/core/src/config/config.ts), find where the Config constructor handles `params.chatCompression` (around line 933) and, before the assignment, add:

```ts
if (
  params.chatCompression &&
  typeof (params.chatCompression as Record<string, unknown>)
    .contextPercentageThreshold !== 'undefined'
) {
  console.warn(
    '[qwen-code] chatCompression.contextPercentageThreshold has been removed ' +
      'and is now controlled by built-in thresholds. Setting will be ignored.',
  );
}
this.chatCompression = params.chatCompression;
```

Also clean up `chatCompressionService.ts`: the block at [:214-217](packages/core/src/services/chatCompressionService.ts:214) was already deleted in Task 6; recheck the file for any residual `chatCompressionSettings?.contextPercentageThreshold` or the exported constant `COMPRESSION_TOKEN_THRESHOLD`:

- If `COMPRESSION_TOKEN_THRESHOLD` no longer has any references, delete the constant.
- If there are still references (e.g. telemetry or docs), change them to reference `DEFAULT_PCT`.

cli/config/settingsSchema.ts does not need changing — `chatCompression` is still `type: 'object'` with no schema fields inside ([settingsSchema.ts:1020-1028](packages/cli/src/config/settingsSchema.ts:1020)). If the schema has any reference to `contextPercentageThreshold` internally, delete it.

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core
npm test --workspace=packages/cli
```

Expected: PASS (including the existing compression-related tests)

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/config.ts packages/core/src/config/config.test.ts packages/core/src/services/chatCompressionService.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
refactor(core)!: remove chatCompression.contextPercentageThreshold setting

The proportional threshold is now an internal constant (DEFAULT_PCT) and
the auto-compaction threshold is computed from a mixed proportional /
absolute formula (computeThresholds). User-facing tuning of the bare
percentage no longer maps to meaningful behavior on large-window models.

Existing settings.json files containing the field will log a one-line
stderr warning on startup; the field is otherwise ignored.

BREAKING CHANGE: chatCompression.contextPercentageThreshold is removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P3 — Hard-tier proactive rescue

### Task 9: Add a hard check + force compress at the sendMessageStream entry point

**Files:**

- Modify: `packages/core/src/core/geminiChat.ts`
- Modify: `packages/core/src/core/geminiChat.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('sendMessageStream hard-tier rescue', () => {
  it('triggers force compress when estimated tokens cross hard threshold', async () => {
    // Construct a 200K window: hard = 177K
    const chat = makeChatWithLastPromptTokenCount(176_000);
    // This turn's user message estimate + 176K crosses 177K
    const userMessage = makeBigUserMessage(/* ~3K tokens */);
    const stream = await chat.sendMessageStream(
      'm',
      { message: userMessage },
      'p',
    );
    const first = await stream.next();
    expect(first.value?.type).toBe(StreamEventType.COMPRESSED);
    expect(getLastCompressCallForce()).toBe(true);
  });

  it('hard rescue resets consecutiveFailures before forcing', async () => {
    const chat = makeChatWithLastPromptTokenCount(176_000);
    // First produce 3 failures so consecutiveFailures = 3
    setMockedCompressionToFail(3);
    await chat.sendMessageStream('m', { message: 'a' }, 'p1');
    await chat.sendMessageStream('m', { message: 'b' }, 'p2');
    await chat.sendMessageStream('m', { message: 'c' }, 'p3');
    expect(chat.getConsecutiveFailures()).toBe(3);
    // 4th time: tokens cross hard, the hard rescue resets the circuit breaker and forces force=true
    setMockedCompressionToSucceed();
    await chat.sendMessageStream('m', { message: 'd' }, 'p4');
    expect(getLastCompressCallForce()).toBe(true);
    expect(chat.getConsecutiveFailures()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts -t 'hard-tier rescue'
```

Expected: FAIL — sendMessageStream currently always calls tryCompress with `force=false`.

- [ ] **Step 3: Implement — add a hard check at the sendMessageStream entry point**

[geminiChat.ts:560-567](packages/core/src/core/geminiChat.ts:560):

```ts
// Hard-tier rescue: if pending prompt is large enough to risk overflow,
// force compress before the send and reset the failure counter so a
// session already in circuit-breaker NOOP can recover. This proactively
// covers what reactive overflow (line ~711) would otherwise catch
// after a wasted round-trip.
const contextLimit =
  this.config.getContentGeneratorConfig()?.contextWindowSize ??
  DEFAULT_TOKEN_LIMIT;
const { hard } = computeThresholds(contextLimit);
const pendingUserMessage = createUserContent(params.message);
const effectiveTokens = estimatePromptTokens(
  this.getHistory(true),
  pendingUserMessage,
  this.lastPromptTokenCount,
);
const shouldForceFromHard = effectiveTokens >= hard;
if (shouldForceFromHard) {
  this.consecutiveFailures = 0;
}

compressionInfo = await this.tryCompress(
  prompt_id,
  model,
  shouldForceFromHard,
  params.config?.abortSignal,
  { pendingUserMessage },
);
```

Note: `createUserContent` was originally called once inside sendMessageStream at [:569](packages/core/src/core/geminiChat.ts:569); now we call it earlier, so the line `const userContent = createUserContent(params.message);` at [:569](packages/core/src/core/geminiChat.ts:569) can be deleted/replaced with `const userContent = pendingUserMessage;`.

Add the import: `import { computeThresholds } from '../services/chatCompressionService.js';`
Add the import: `import { estimatePromptTokens } from '../services/tokenEstimation.js';`

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/geminiChat.ts packages/core/src/core/geminiChat.test.ts
git commit -m "$(cat <<'EOF'
feat(core): hard-tier rescue forces compaction before oversized send

When estimated tokens cross computeThresholds.hard, sendMessageStream
now resets the consecutive-failure counter and calls tryCompress with
force=true. This pulls reactive overflow recovery forward to before
the send, saving one wasted round-trip and unblocking sessions whose
circuit breaker had latched off.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P5 — UI changes (tip rewrite + /context display)

### Task 10: Rewrite the three context-\* tips in tipRegistry

**Files:**

- Modify: `packages/cli/src/services/tips/tipRegistry.ts`
- Modify: `packages/cli/src/services/tips/tipRegistry.test.ts` (create it if it doesn't exist)
- Modify: `packages/cli/src/ui/AppContainer.tsx`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/services/tips/tipRegistry.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { tipRegistry, type TipContext } from './tipRegistry.js';

const baseCtx: TipContext = {
  lastPromptTokenCount: 0,
  contextWindowSize: 200_000,
  sessionPromptCount: 10,
  sessionCount: 1,
  platform: 'darwin',
  thresholds: {
    warn: 147_000,
    auto: 167_000,
    hard: 177_000,
    effectiveWindow: 180_000,
  },
};

function tipById(id: string) {
  return tipRegistry.find((t) => t.id === id)!;
}

describe('context-* tip thresholds align with computeThresholds', () => {
  it('compress-intro fires between warn and auto', () => {
    const t = tipById('compress-intro');
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 100_000 })).toBe(
      false,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 150_000 })).toBe(
      true,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 168_000 })).toBe(
      false,
    );
  });

  it('context-high fires between auto and hard', () => {
    const t = tipById('context-high');
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 150_000 })).toBe(
      false,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 170_000 })).toBe(
      true,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 178_000 })).toBe(
      false,
    );
  });

  it('context-critical fires at or above hard', () => {
    const t = tipById('context-critical');
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 170_000 })).toBe(
      false,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 178_000 })).toBe(
      true,
    );
  });

  it('falls back gracefully when thresholds undefined (legacy callers)', () => {
    const ctx = { ...baseCtx, thresholds: undefined };
    // All three tips should not fire when thresholds are missing (cannot compare)
    expect(tipById('compress-intro').isRelevant(ctx)).toBe(false);
    expect(tipById('context-high').isRelevant(ctx)).toBe(false);
    expect(tipById('context-critical').isRelevant(ctx)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/cli -- --run packages/cli/src/services/tips/tipRegistry.test.ts
```

Expected: FAIL — `TipContext` has no `thresholds` field; the three tips still fire at 50/80/95 percentages.

- [ ] **Step 3: Implement — change tipRegistry**

[tipRegistry.ts:15-21](packages/cli/src/services/tips/tipRegistry.ts:15):

```ts
import type { CompactionThresholds } from '@qwen-code/qwen-code-core';
import { DEFAULT_TOKEN_LIMIT } from '@qwen-code/qwen-code-core';

export type TipTrigger = 'startup' | 'post-response';

export interface TipContext {
  lastPromptTokenCount: number;
  contextWindowSize: number;
  sessionPromptCount: number;
  sessionCount: number;
  platform: string;
  /**
   * Three-tier auto-compaction thresholds, computed by callers.
   * Optional for backward compat; tip checks return false when missing.
   */
  thresholds?: CompactionThresholds;
}
```

Keep `getContextUsagePercent` (other startup tips may use it), but the context-\* tips no longer depend on it.

Replace the `isRelevant` of the three tips at [tipRegistry.ts:37-69](packages/cli/src/services/tips/tipRegistry.ts:37):

```ts
export const tipRegistry: ContextualTip[] = [
  // --- Post-response contextual tips (priority: higher = more urgent) ---
  {
    id: 'context-critical',
    content:
      'Context near hard limit — auto-compact will force on next send. Consider /clear if you want to start fresh.',
    trigger: 'post-response',
    isRelevant: (ctx) =>
      ctx.thresholds !== undefined &&
      ctx.lastPromptTokenCount >= ctx.thresholds.hard,
    cooldownPrompts: 3,
    priority: 100,
  },
  {
    id: 'context-high',
    content: 'Context is getting full. Use /compress to free up space.',
    trigger: 'post-response',
    isRelevant: (ctx) =>
      ctx.thresholds !== undefined &&
      ctx.lastPromptTokenCount >= ctx.thresholds.auto &&
      ctx.lastPromptTokenCount < ctx.thresholds.hard,
    cooldownPrompts: 5,
    priority: 90,
  },
  {
    id: 'compress-intro',
    content: 'Long conversation? /compress summarizes history to free context.',
    trigger: 'post-response',
    isRelevant: (ctx) =>
      ctx.thresholds !== undefined &&
      ctx.lastPromptTokenCount >= ctx.thresholds.warn &&
      ctx.lastPromptTokenCount < ctx.thresholds.auto &&
      ctx.sessionPromptCount > 5,
    cooldownPrompts: 10,
    priority: 50,
  },

  // --- Startup tips ---  ← unchanged
  // ... the startup tips below stay the same ...
```

Around `packages/cli/src/ui/AppContainer.tsx:1150` (known to be the contextual-tips construction site), change it to:

```tsx
// pseudo — depends on the existing code
const thresholds = computeThresholds(contextWindowSize);
const tipCtx: TipContext = {
  lastPromptTokenCount,
  contextWindowSize,
  sessionPromptCount,
  sessionCount,
  platform: process.platform,
  thresholds,
};
```

Add the import to AppContainer.tsx:

```tsx
import { computeThresholds } from '@qwen-code/qwen-code-core';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/cli -- --run packages/cli/src/services/tips/tipRegistry.test.ts
npm test --workspace=packages/cli
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/services/tips/tipRegistry.ts packages/cli/src/services/tips/tipRegistry.test.ts packages/cli/src/ui/AppContainer.tsx
git commit -m "$(cat <<'EOF'
feat(cli): align context-* tips with new compaction thresholds

The three context-usage tips now compare tokenCount against the
warn/auto/hard ladder from computeThresholds instead of fixed 50/80/95
percentages. compress-intro fires between warn and auto, context-high
between auto and hard, context-critical at or above hard. Threshold
data is injected into TipContext from the AppContainer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 11: The /context command displays the three-tier thresholds

**Files:**

- Modify: `packages/cli/src/ui/commands/contextCommand.ts`
- Modify: `packages/cli/src/ui/commands/contextCommand.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('/context shows three-tier thresholds', () => {
  it('renders warn/auto/hard with current tier marker', () => {
    const result = renderContextCommand({
      contextWindowSize: 200_000,
      lastPromptTokenCount: 150_000, // between warn and auto
    });
    expect(result).toMatch(/Warn threshold:\s+147[,.]?000/);
    expect(result).toMatch(/Auto threshold:\s+167[,.]?000/);
    expect(result).toMatch(/Hard threshold:\s+177[,.]?000/);
    expect(result).toMatch(/current tier:\s+warn/i);
  });

  it('correctly identifies "below warn" tier when tokens are low', () => {
    const result = renderContextCommand({
      contextWindowSize: 200_000,
      lastPromptTokenCount: 50_000,
    });
    expect(result).toMatch(/current tier:\s+(safe|below warn|normal)/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/cli -- --run packages/cli/src/ui/commands/contextCommand.test.ts -t 'three-tier'
```

Expected: FAIL — the current [contextCommand.ts:177-183](packages/cli/src/ui/commands/contextCommand.ts:177) uses the `(1 - threshold) * contextWindowSize` formula and only shows a single "autocompactBuffer" number.

- [ ] **Step 3: Implement — change the contextCommand output**

Replace the block at [contextCommand.ts:177-183](packages/cli/src/ui/commands/contextCommand.ts:177):

```ts
import { computeThresholds } from '@qwen-code/qwen-code-core';

// ... inside buildContextSummary or a similar entry point:
const thresholds = computeThresholds(contextWindowSize);
const { warn, auto, hard, effectiveWindow } = thresholds;

function currentTier(tokens: number): string {
  if (tokens >= hard) return 'hard (force compress imminent)';
  if (tokens >= auto) return 'auto (compaction in progress / just ran)';
  if (tokens >= warn) return 'warn';
  return 'safe';
}

// Append to the formatted-output section:
const lines = [
  // ... existing output ...
  `Effective window:   ${formatNum(effectiveWindow)}  (window − 20K reserve)`,
  `Warn threshold:     ${formatNum(warn)}`,
  `Auto threshold:     ${formatNum(auto)}`,
  `Hard threshold:     ${formatNum(hard)}`,
  `Current tier:       ${currentTier(lastPromptTokenCount)}`,
];
```

Note: `formatNum` is the project's existing `.toLocaleString()` etc.; if it isn't in the file, inline a `(n: number) => n.toLocaleString('en-US')`.

Also **delete** the original code that computed `autocompactBuffer` ([:180-183](packages/cli/src/ui/commands/contextCommand.ts:180)) and the use of `compressionThreshold` — now just look at `auto` directly.

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/cli -- --run packages/cli/src/ui/commands/contextCommand.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/ui/commands/contextCommand.ts packages/cli/src/ui/commands/contextCommand.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): /context shows three-tier thresholds and current tier

Replace the legacy single-buffer display with effective window + warn /
auto / hard threshold lines and a "current tier" label so users can see
exactly where in the ladder the session sits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance (final full regression)

After all tasks have landed, run a full validation pass at the end:

- [ ] **Step 1: Full test suite**

```bash
npm test
```

Expected: all workspace tests pass.

- [ ] **Step 2: Full typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Full lint**

```bash
npm run lint
```

- [ ] **Step 4: Manual smoke**

Start the CLI and run:

1. `/context` — check whether the new three-tier display looks reasonable
2. Run a conversation that will trigger compression (you can use a 200K-window model and fill the prompt up to 170K+)
3. Start with `chatCompression.contextPercentageThreshold = 0.5` set — check whether stderr prints the deprecation warning
4. Use `--continue` to resume a huge session, and check whether compression is triggered by the first-turn estimation path on the first send

- [ ] **Step 5: Unified PR description script (optional)**

If the PRs are submitted in batches, each PR description should link [docs/design/auto-compaction-threshold-redesign.md](docs/design/auto-compaction-threshold-redesign.md) and label the Phase / Task.
