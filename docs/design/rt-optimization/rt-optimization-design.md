# Qwen Code Agent Loop RT Optimization Technical Design

## 1. Background and Problem Definition

### 1.1 Current State

Qwen Code's Agent Loop is a strictly serial model:

```
User Prompt → [LLM decision] → Tool Execution → [LLM decision] → Tool Execution → ... → [LLM reply] → Idle
               ~3-4s            ~Xms-Ns           ~3-4s            ~Xms-Ns               ~3-4s
```

Each LLM call (including network RTT + model inference) takes about 3-4s, which is the primary cost of end-to-end RT.

### 1.2 Measured Data

Test scenario: "What workspaces do I have" (3-round agent loop, 2 tool calls, single sample)

| Stage                                      | Time      | Share |
| ------------------------------------------ | --------- | ----- |
| LLM Round 1 (decide to call skill)         | 3.8s      | 28%   |
| Skill execution                            | 1ms       | <1%   |
| LLM Round 2 (decide to call shell)         | 3.0s      | 22%   |
| Shell execution                            | 2.5s      | 19%   |
| LLM Round 3 (text summary)                 | 3.8s      | 28%   |
| Framework overhead (state sync, rendering) | 0.3s      | 3%    |
| **Total**                                  | **13.4s** | 100%  |

**Conclusion**: LLM calls account for 78%, tool execution 19%, framework 3%. The core of optimization is to **reduce the number of LLM calls** and **lower the latency of a single LLM call**.

> Note: single sample, single scenario. The 19% tool execution is dominated by slow shell calls; in read-heavy scenarios tool execution can drop to <5%. Before this design lands, baselines for ≥3 scenario classes (write operations, cross-tool reasoning, error recovery) need to be collected.

### 1.3 Key Constraints of the Current Architecture

| Constraint                                | Code Location                                                                              | Description                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Tool result has no post-execution control | `tools.ts` `ToolResult` interface (L422)                                                   | Only has `llmContent`/`returnDisplay`/`error`, cannot express "skip LLM"                                                              |
| Result unconditionally returned to LLM    | `useGeminiStream.ts` `handleCompletedTools` (L2038) → `submitQuery(ToolResult, …)` (L2355) | All gemini-initiated tool results are returned                                                                                        |
| Scheduling only after stream completes    | `useGeminiStream.ts` `processGeminiStreamEvents` (L1365)                                   | `scheduleToolCalls` only runs after the stream loop ends; no incremental scheduling                                                   |
| Model layer selection has no policy layer | `client.ts` `modelOverride ?? getModel()` (L1305, L1598)                                   | Infrastructure is already wired through to `turn.run(model, …)` (L1707), but callers only use it when a skill explicitly specifies it |

### 1.4 Already-Available Infrastructure (Heavily Reused by This Design)

| Capability                                                    | Location                                              | Current State                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `fastModel` config + `/model --fast <id>`                     | `config.ts:684`, `1987`, `2021`                       | Ready                                                                                            |
| `SendMessageOptions.modelOverride`                            | `client.ts:142` → `1598` → `turn.run`                 | Wired end-to-end through to `geminiChat.sendMessageStream(model, …)`                             |
| Hook-layer `modelOverrideRef` (carries skill model selection) | `useGeminiStream.ts:376`, `2225`, `1841`              | Wired through                                                                                    |
| fast-model **non-streaming** side query precedent             | `services/toolUseSummary.ts:108` (via `runSideQuery`) | Already shipped, proves the fast model config is sound; but it is a **non-streaming path**       |
| fast-model **streaming** precedent                            | `followup/speculation.ts:224`                         | Already shipped, but it **uses a forked chat** (`createForkedChat`), isolated from the main chat |

**Key gap**: **No production code** runs the fast model with streaming on the main chat. This design's D2 is the first such case and requires a validation experiment first (see §3.2 prerequisites).

---

## 2. Design Principles

1. **Generality**: the design is not bound to any specific tool/skill
2. **Backward compatibility**: existing tools continue to work without modification
3. **Progressive + explicit signals**: the policy defaults to conservative; tool authors opt in to optimizations via explicit fields
4. **Rollbackable**: all optimizations are controlled by feature flags; can be force-disabled at the user level
5. **Honest trade-offs**: quality risks, cost risks, and applicability boundaries are clearly labeled

---

## 3. Optimization Designs

### 3.1 Direction One: Tool Post-Execution Directive (ToolResult Post-Execution Directive)

#### Problem

The current `ToolResult` contains no information about "what to do next". Regardless of whether the tool result is self-explanatory, it unconditionally triggers a round of LLM.

#### Design

Extend the `ToolResult` interface (`packages/core/src/tools/tools.ts` L422):

```typescript
export interface ToolResult {
  llmContent: PartListUnion;
  returnDisplay: ToolResultDisplay;
  error?: { message: string; type?: ToolErrorType };

  // New: post-execution directive
  postExecution?: {
    /**
     * The tool result is not returned to the LLM; it is shown directly to
     * the user as the final reply. Applicable when the result is fully
     * self-contained and does not need the model to interpret it again.
     * This is a local property of ToolResult.
     */
    skipLlmRound?: boolean;

    /**
     * The tool result is "self-contained and can be shown directly to the
     * user"—i.e., `returnDisplay` is already the final form the user expects
     * to see and does not need model processing.
     * This is a local property of ToolResult; it does **not** predict
     * "whether the next round is a summary".
     * Works together with Direction Three (presentation decoupling):
     * true → enter the Summarizing state and allow user input.
     */
    resultIsTerminal?: boolean;
  };
}
```

> **Design revision**: an early version had a single `selfExplanatory` field carry both responsibilities—"tool output property" and "conversation-flow prediction signal"—but the two do not overlap (example: the user prompt is "read X then fix Y", read_file's output is self-contained, but the next round is clearly not a summary). **The prediction signal is a global property of the conversation flow** and should not be expressed via a tool field—D2 switched to relying entirely on conversation-flow heuristics (see §3.2).

#### Behavior Change

A new check is added in `handleCompletedTools`:

```
Tool batch completes
  → Check postExecution.skipLlmRound for all tools in the batch
  → All true?
    → YES: markToolsAsSubmitted, do not call submitQuery, go idle directly
    → NO: keep existing behavior (submitQuery)
```

**Important constraint**: `skipLlmRound` only takes effect when **all tools in the current batch declare skip**. A mixed batch is still returned.

#### History Invariant

After skipping the LLM, history looks like: `user → function_call → function_response → <no assistant>`.

- Review whether `repairOrphanedToolUseTurnsInHistory` (called at session-load) tolerates this shape
- Review the behavior of auto-compaction when assistant text is missing
- PR #4176 just closed the tool_use↔tool_result invariant; before landing, add unit-test coverage for the alternation of "the next user message after a skip"
- Qwen / OpenAI-style APIs tolerate this; Anthropic enforces strict alternation—if direct Anthropic connectivity is later supported, a fallback is needed (inject empty assistant text into history)

> **Unified fix point**: this and §3.3 (D3 interrupting Summarizing mid-stream) break the **same history invariant**. Pick one of the two fix approaches (inject empty assistant / accept Qwen tolerance); both directions must use the same choice.

#### Signal Ecosystem (Phase 2 work)

| Tool                                 | `skipLlmRound`           | `resultIsTerminal`  | Notes                                                                                                                        |
| ------------------------------------ | ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `read_file`                          | for query-only scenarios | true                | File content is the answer                                                                                                   |
| `cat` (via shell)                    | scenario-dependent       | true                | Same as read_file                                                                                                            |
| `grep` / `glob` / `ls`               | false                    | **false (default)** | Results often need the model to select/sort/summarize; the skill layer explicitly sets true for known "pure query" scenarios |
| `git status` / `git log` (via shell) | false                    | true                | Output is already formatted                                                                                                  |
| Skill tools                          | each skill decides       | each skill decides  | Query-type skills tend toward true                                                                                           |
| MCP tools                            | false by default         | false by default    | Explicitly opt in via allowlist                                                                                              |

Third-party/MCP tools are untrusted and are not tagged by default; enable them explicitly via `config.toolPostExecAllowlist`.

> `grep/glob/ls` defaulting to false is a strict choice: it avoids D2/D3 misjudging scenarios that need model summarization/sorting.

#### Applicable and Not Applicable

- **Applicable**: terminal queries (read/cat/print types), self-contained results (skills with already-formatted output)
- **Not applicable**: intermediate steps in multi-step tasks, write-operation confirmations, complex logs that need interpretation

#### Risks and Mitigations

| Risk                                                             | Severity | Mitigation                                                         |
| ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| A tool sets skipLlmRound incorrectly, breaking a multi-step task | Medium   | Batch-level semantics + llmContent still in history is recoverable |
| Third-party tool abuse                                           | Medium   | MCP disabled by default, explicitly enabled via allowlist          |
| History invariant broken                                         | Medium   | Add unit tests before landing; session-load replay coverage        |
| User-expectation mismatch (expects a summary but gets none)      | Low      | The setting `alwaysSummarize: true` can override                   |

#### Benefit

Saves 3-4s in terminal-query scenarios (skips the final LLM round).

---

### 3.2 Direction Two: fast-model Routing Policy for the summary Round

#### Positioning

**This direction introduces no new pipeline, but it does require extending the GeminiChat interface to support runtime model switching**.

The infrastructure in §1.4 provides fast-model config and end-to-end modelOverride wiring, but there is **no precedent for running fastModel + streaming on the main chat**, which requires:

- Decision function: when to pass `config.getFastModel()` down as an override
- Safe fallback: the new `GeminiChat.retryStreamWithModel` interface (handles chat-internal state)
- Experimental validation: switching fast/primary on the main chat does not break compaction / history-recording

#### Scope of Application

D2 applies only to:

- **useGeminiStream** (TUI main path)—the `sendMessageStream` call site at L1841
- **ACP Session** (IDE integration path)—`acp-integration/session/Session.ts:1182`, modified in sync during Phase 3

D2 **does not apply** to the following paths, to avoid introducing extra failure modes in non-interactive or independent contexts:

- **Subagent runtime** (`agents/runtime/agent-core.ts:614`): subagents already carry their own model config
- **Cron-triggered turn** (`SendMessageType.Cron`, client.ts:127): non-interactive, no RT urgency
- **Notification turn** (`SendMessageType.Notification`, client.ts:129): same as above

#### Core Difficulty

When `submitQuery` is called, **we do not know** whether the model, after reading the result, will issue a new tool call or produce text directly. If we call with the fast model but the model actually still needs to call a tool—the consequence is **silent**: fast may call the wrong tool or with wrong parameters, and the error has no obvious signal.

**No tool-level field can reliably predict** "whether the next round is a summary", because it depends on the conversation flow (user prompt + accumulated context), not on a local property of the tool output. Example:

```
User: "Read utils.ts then change all the console.log inside to logger.info"
  → Tool 1: read_file → result is self-contained
  → But the next round is clearly not a summary
```

Therefore D2 predicts entirely using **conversation-flow heuristics** and does not rely on tool fields.

#### Decision Function: Conversation-Flow Heuristics + Vetoes

```typescript
import { Kind, MUTATOR_KINDS } from '../tools/tools.js';

function selectContinuationTier(
  turn: Turn,
  userPrompt: string,
  batch: ToolCall[],
): 'fast' | 'primary' {
  // ===== User-level force switch (highest priority) =====
  const userPref = config.getSummaryTierStrategy();
  if (userPref === 'always_primary') return 'primary';
  if (userPref === 'always_fast') return 'fast'; // still subject to the runtime safeguard

  // ===== User-intent vetoes =====
  // 1. user prompt contains an action verb → the next round likely still needs a tool call
  if (requestImpliesFurtherAction(userPrompt)) return 'primary';

  // 2. this round already has a mutator tool → likely a verify/read follow-up
  if (batch.some((c) => MUTATOR_KINDS.includes(c.tool.kind))) return 'primary';

  // 3. this round or history has an unresolved error → the model needs primary to diagnose
  if (hasUnresolvedError(turn.toolResults, batch)) return 'primary';

  // ===== Output-complexity vetoes =====
  // 4. user prompt requires deep analysis (explain/compare/why type)
  if (needsDeepReasoning(userPrompt)) return 'primary';

  // 5. ≥3 distinct tools called → cross-result narration relies on primary
  if (needsCrossResultReasoning(turn)) return 'primary';

  // 6. tool output too long → summarizing long content relies on primary
  if (estimateTotalToolOutputTokens(turn) > 4000) return 'primary';

  // ===== Model-feasibility vetoes =====
  // 7. fast model's context window is insufficient → switching to fast would trigger compression
  //    (compression itself requires an LLM call, which instead slows things down and adds cost)
  if (wouldTriggerCompression(turn.history, config.getFastModel()))
    return 'primary';

  // ===== Multilingual fallback =====
  if (!isPromptLanguageSupported(userPrompt)) return 'primary';

  // ===== Session-state fallback =====
  if (turn.justCompacted || turn.justCleared) return 'primary';

  return 'fast';
}
```

Meaning of the eight veto items:

- **`requestImpliesFurtherAction`**: action verbs (`改|删|加|替换|修复|实现|新建|create|fix|change|add|remove|implement|write|update`) → multi-step task
- **`MUTATOR_KINDS` hit**: this round already wrote → likely a read/verify follows. **Reuse the existing `MUTATOR_KINDS = [Edit, Delete, Move, Execute]` at `tools.ts:806`** (the `kind: Kind` property of each Tool instance is the authoritative classification; do not reinvent `isWriteTool`)
- **`hasUnresolvedError(turnResults, currentBatch)`**: a two-part judgment—
  - **Any error in the current batch → always unresolved** (do not assume parallel batches self-correct)
  - **History deduplicated by `(toolName, args fingerprint)`; if the last occurrence is still an error, treat it as unresolved** (deduplicating by toolName alone would misjudge same-name calls with different parameters)
  - shell etc. must correctly fill `ToolResult.error` (an upstream data-quality dependency)
- **`needsDeepReasoning`**: contains keywords like "analyze/explain/why/compare/diagnose"
- **`needsCrossResultReasoning`**: ≥3 distinct tool calls (same tool + same args counts as one)
- **output tokens > 4000**: an empirical threshold, **to be adjusted after measuring the fast-model baseline**
- **`wouldTriggerCompression`**: the fast model's context window is usually smaller than primary's; the same history will trigger `tryCompress` (geminiChat.ts:1418) earlier on fast—compression itself requires an LLM call and may **worsen RT and cost in reverse**. Budget estimate: `estimateHistoryTokens(history) > fastModelContextWindow × COMPACTION_THRESHOLD` is treated as "will trigger"
- **unsupported language**: only Chinese and English keywords are detected; other languages (Japanese, Korean, etc.) default to primary
- **session-state change**: the first continuation right after `/compact` or `/clear` → primary to rebuild the mental model

The veto direction **biases toward primary** (better to spend an extra 2s than to degrade quality).

#### Key Implementation: `GeminiChat.retryStreamWithModel`

**Problem**: directly aborting + calling `client.sendMessageStream` breaks chat state:

1. `geminiChat.ts:1428` pushes `userContent` into history when the stream starts; restarting will **push it again**, causing a duplicate `function_response` in history
2. The `sendPromise` lock (`geminiChat.ts:1392, 1398`)—after abort, ensure `streamDoneResolver` is called
3. Invariant markers introduced by PR #4176 such as `pendingPartialState` need to be cleaned up correctly
4. The Telemetry span's model attribute needs to be updated

**New interface** (`packages/core/src/core/geminiChat.ts`):

```typescript
/**
 * Retry an in-flight or just-aborted streaming send with a different model.
 * Does NOT re-push userContent (kept from original send).
 * Resets pendingPartialState; releases stale sendPromise; re-opens span.
 */
async retryStreamWithModel(
  model: string,
  signal: AbortSignal,
): Promise<AsyncGenerator<StreamEvent>>;
```

Calling contract:

- Only called after the original send has already been aborted (no concurrency)
- prompt_id is reused (same user intent)
- userContent already pushed into history is not pushed again

Implementation effort about 1.5d plus unit tests.

#### Runtime Safeguard

If `selectContinuationTier` returns `'fast'` but a `ServerGeminiEventType.ToolCallRequest` event appears in the stream → **immediately abort the current stream and call `retryStreamWithModel(primaryModel)`**.

This covers the only silent misrouting scenario of "predicted summary but a tool is actually still needed". Cost: the tokens wasted on one fast call (cost attribution in §5.3).

#### Decoupling from skill `modelOverride`

`useGeminiStream.modelOverrideRef` (L376, L2225) currently carries the **model explicitly chosen by a skill**, which is "business semantics". This direction's fast routing is "optimization semantics"; the two **must be separated**:

```typescript
// New independent ref
const summaryTierRef = useRef<'fast' | 'primary' | undefined>(undefined);

// Merged at the call site (does not reuse modelOverrideRef)
const stream = geminiClient.sendMessageStream(
  finalQueryToSend,
  abortSignal,
  prompt_id!,
  {
    type: submitType,
    notificationDisplayText: metadata?.notificationDisplayText,
    modelOverride:
      modelOverrideRef.current ?? // skill explicit selection takes priority
      (summaryTierRef.current === 'fast' ? config.getFastModel() : undefined),
  },
);
```

Lifecycle:

| Timing                                          | `modelOverrideRef` (skill) | `summaryTierRef` (fast routing)                       |
| ----------------------------------------------- | -------------------------- | ----------------------------------------------------- |
| New user turn (`!Retry && !ToolResult`)         | clear                      | clear                                                 |
| skill tool returns a `modelOverride` field      | write                      | unchanged                                             |
| tool batch completes → `selectContinuationTier` | unchanged                  | write                                                 |
| Runtime fallback (saw a ToolCallRequest)        | unchanged                  | upgrade to `'primary'`                                |
| Retry (user manually presses Ctrl+Y)            | retained                   | upgrade to `'primary'` (no fast after a fast failure) |

A skill's explicit selection **always wins**—the user's explicit intent takes priority over the optimization policy.

#### Telemetry Fix

The interaction span at `client.ts:1303` records the `model` attribute when the turn starts. When a fallback triggers, the model actually changes and the span data becomes distorted. We need:

```typescript
// when a fallback triggers
span.setAttribute('llm.model.requested', fastModel);
span.setAttribute('llm.model.actual', primaryModel);
span.setAttribute('llm.fallback.reason', 'tool_call_seen');
```

And distinguish `requested` / `actual` models in `addUserPromptAttributes` to avoid billing/audit confusion.

#### User-Level Force Switch

New setting (`packages/cli/src/config/settingsSchema.ts`):

```typescript
summaryTierStrategy: 'auto' | 'always_primary' | 'always_fast';
// default: 'auto'
```

- `'auto'`: use `selectContinuationTier` (recommended)
- `'always_primary'`: fully disable the D2 optimization (production-sensitive scenarios)
- `'always_fast'`: skip vetoes, **still subject to the runtime safeguard** (advanced users)

Rationale: D2 trades quality for speed; some users/scenarios need an explicit opt-out.

#### Prerequisites

- `config.getFastModel()` is configured
- **Main-chat fastModel-streaming validation experiment** (1d before coding):
  - Mock a `resultIsTerminal=true` tool and repeatedly trigger summary rounds on the main chat
  - Observe whether `tryCompress` is erroneously triggered (the fast model's small context window may trigger it early)
  - Observe whether chatRecordingService output has a model mismatch
  - Observe whether the next primary call after a single fast call can read history normally
- **Fast candidate-model baseline measurement** (1d):
  - Run 100 summary-round prompts (input containing `function_response`), measuring P50/P95 end-to-end latency and time-to-first-token
  - Measure the `tryCompress` trigger rate `P_compact`, verifying net RT benefit = `(1 - P_compact) × ΔRT − P_compact × compression_RT > 0`
  - Enable only when fast P50 ≤ primary P50 × 0.5 and P95 ≤ primary P95 × 0.6
- The fast model and primary model are in the same family (to avoid function_response encoding differences); cross-family requires rejection at the `getFastModel()` layer
- **`thinkingConfig` compatibility**:
  - The fast model must be consistent with primary on `thinkingConfig.includeThoughts` support; or
  - The fast path forces `includeThoughts: false` (aligned with `sideQuery.ts:118-122`)
  - Validate: when history contains thought parts, the fast model handles them correctly (no errors, does not treat a thought as user input)

#### Risks and Mitigations

| Risk                                                                                             | Severity | Mitigation                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fast model silently misroutes a tool call                                                        | High     | Conversation-flow heuristics + runtime ToolCallRequest abort safeguard                                                                                                                                                   |
| Fast hallucinates a "user-visible wrong answer" on input containing an error                     | **High** | The `hasUnresolvedError` veto; monitor the user follow-up rate (note: the same risk in `emitToolUseSummaries` only affects a 60-token label, whereas this risk affects the final answer and is much larger in magnitude) |
| The fast path triggers `tryCompress` → an extra LLM call, **worsening RT and cost in reverse**   | **High** | The `wouldTriggerCompression` predictive gate (see decision function #7); the upstream baseline-measured P_compact threshold                                                                                             |
| Whose model compression itself uses                                                              | Medium   | Triggering compression means giving up fast routing (gate #7 backstop); avoids answer problems                                                                                                                           |
| Switching models on the main chat causes chat-internal-state/recording anomalies                 | Medium   | Covered by the upstream validation experiment; session-resume replay tests                                                                                                                                               |
| D2 and `emitToolUseSummaries` trigger concurrent fast calls simultaneously, exceeding rate-limit | Medium   | Pick one: disable `emitToolUseSummaries` when D2 is enabled (the title does not affect functionality), or share a rate-limit token bucket                                                                                |
| `thinkingConfig` inconsistency between fast / primary causes history-parsing anomalies           | Medium   | Same family + force `includeThoughts: false` on the fast path (see prerequisites)                                                                                                                                        |
| The fallback path is more expensive instead (wasted fast tokens + full primary)                  | Medium   | `fast_tokens_consumed` decision-log monitoring; auto-disable the flag when the fallback rate >20%                                                                                                                        |
| Telemetry span model distortion                                                                  | Medium   | `requested` / `actual` split (see Telemetry Fix)                                                                                                                                                                         |
| Context format incompatibility (cross-family)                                                    | Medium   | `getFastModel()` rejects cross-family selection                                                                                                                                                                          |
| Semantic conflict with skill modelOverride                                                       | Medium   | Independent ref + skill priority                                                                                                                                                                                         |
| `summaryTierRef` decision becomes stale after switching the main model at runtime via `/model`   | Low      | Clear `summaryTierRef` synchronously when handling the `/model` command                                                                                                                                                  |
| fast tokens/s is slower instead                                                                  | Low      | Measure TTFT as well during testing, not just total RT                                                                                                                                                                   |

#### Benefit (Pending Measurement)

- **RT**: the summary round saves 2-3s (do not write into the PR title before measuring)
- **Cost**: the fast model's unit price is usually significantly lower than primary's; in high-frequency summary scenarios token cost may drop 30-50%; but waste on the fallback path offsets part of the benefit, and net benefit needs to be confirmed via measured `fast_tokens_consumed`

---

### 3.3 Direction Three: Decoupling Result Presentation from Interaction (Presentation Decoupling)

#### Problem

From tool completion to being able to type again, the user must wait for the LLM summary round to complete:

```
Tool completes → [render result] → [submitQuery] → [wait for LLM streaming reply 3-4s] → Idle → can type
                                                    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
                                                    user already saw the result but cannot act
```

#### Design

Add a new `StreamingState.Summarizing` state:

```typescript
export enum StreamingState {
  Idle = 'idle',
  Responding = 'responding',
  WaitingForConfirmation = 'waiting_for_confirmation',
  Summarizing = 'summarizing', // new
}
```

#### State-Machine Change

```
Tool completes and result already displayed
  → If the batch all has postExecution.resultIsTerminal === true:
    → enter Summarizing (user can type)
    → submitQuery runs asynchronously
    → the LLM summary is appended to history (or cancelled by a new user message)
  → Otherwise:
    → stay in Responding (user cannot type)
```

#### Handling New User Messages

- When the user submits a new message while in the `Summarizing` state → abort the current summary → handle the new message
- The **partial summary text already generated is discarded** (not added to history), to avoid polluting context with a half-sentence assistant
- The `function_response` is still kept in history (the model knows the tool was executed)
- followup suggestions and the like are triggered only after Summarizing completes or is cancelled

#### Partial-Text Cleanup Checklist on Abort

Partial text is spread across multiple places and must be cleaned up **simultaneously**; missing one causes state inconsistency:

| Location                                                      | Cleanup Action                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pendingHistoryItemRef.current` (useGeminiStream React state) | set to `null`, do not call `addItem`                                                                                         |
| Internal accumulation in `GeminiChat.history`                 | if partial assistant content was already pushed before abort, roll it back via the new `discardPendingAssistant()` interface |
| `ChatRecordingService` buffered turn                          | mark as cancelled, do not write to JSONL                                                                                     |
| `dualOutput.emitText` (if enabled)                            | send an abort sentinel; the sidecar discards on its own                                                                      |
| `loopDetectorRef` accumulated tokens                          | reset the current turn's count                                                                                               |

Execution order: abort signal fires → collect all five cleanups above → only then allow a new user message into `submitQuery`. Race-test coverage: abort fires exactly as the last chunk arrives.

#### Applicability Condition

The batch all has `postExecution.resultIsTerminal === true`.

#### History Invariant (Same Source as §3.1)

Interrupting Summarizing mid-stream produces:

```
[user_1, function_call, function_response, user_2]
                                          ↑ no assistant turn
```

**This is the same invariant that §3.1's skipped-LLM-round breaks**, and must use the same fix strategy as D1 (inject empty assistant / accept Qwen tolerance).

- Reuse D1's invariant unit-test coverage
- session-load replay (including `repairOrphanedToolUseTurnsInHistory`) must cover this shape
- Anthropic alternation: provide a fallback at the same time as D1 when connecting directly

#### Risks and Mitigations

| Risk                                              | Severity   | Mitigation                                                                                                           |
| ------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| A half-sentence assistant enters history on abort | **Medium** | Explicitly discard partial text; keep only function_response; unit-test cover the race                               |
| History invariant broken (no assistant follow-up) | **Medium** | Same-source problem as D1, unified fix (see §3.1 History Invariant)                                                  |
| Increased UI-state complexity                     | Medium     | Summarizing = Idle + background task; the input path reuses Idle                                                     |
| Perceived benefit depends on behavior pattern     | Low        | If the user does not type within 3s, the summary has already completed → no perceived benefit; but **no regression** |

#### Benefit

- **Theoretical upper bound**: 3-4s perceived RT (the user can type the moment the tool completes)
- **Actual median**: depends on the user's typing interval—a user who only types 2-5s after reading the result will not feel a difference, but it is **never slower**

---

### 3.4 Direction Four: Stream-Ahead Scheduling (Stream-Ahead Scheduling)

#### Problem

`processGeminiStreamEvents` batches and schedules tools only after the stream fully ends. The `ToolCallRequest` event may already be yielded mid-stream.

#### Design

In stream-event processing, immediately begin **pre-validation** (not execution) for `ToolCallRequest`:

```typescript
case ServerGeminiEventType.ToolCallRequest:
  toolCallRequests.push(event.value);
  scheduler.prevalidate(event.value, signal);  // new
  break;
```

`CoreToolScheduler.prevalidate(request)`:

1. Look up the tool registration
2. Build the invocation
3. Execute `shouldConfirmExecute` (cache the result)
4. Use the cached result directly at `schedule()` time

#### Purity Contract and Allowlist

`prevalidate` requires `shouldConfirmExecute` to be side-effect-free **and** the result to not be invalidated by external modification in the prevalidate→schedule gap.

**Directly reuse `CONCURRENCY_SAFE_KINDS` at `tools.ts:818`**:

```typescript
export const CONCURRENCY_SAFE_KINDS: ReadonlySet<Kind> = new Set([
  Kind.Read,
  Kind.Search,
  Kind.Fetch,
]);
```

This is the project's existing "no side effects + concurrency-safe" classification, which exactly matches the prevalidate requirement.

| Tool Kind                     | In allowlist              | Rationale                                                                                       |
| ----------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `Read` (read_file etc.)       | ✅                        | Pure read                                                                                       |
| `Search` (grep / glob)        | ✅                        | Pure read                                                                                       |
| `Fetch` (web_fetch etc.)      | ✅                        | Remote read, no write side effects                                                              |
| `Edit`                        | **❌** (see TOCTOU below) | shouldConfirmExecute is purely read-only, but the diff can become invalid in the scheduling gap |
| `Delete` / `Move` / `Execute` | ❌                        | MUTATOR_KINDS                                                                                   |
| `Think`                       | ❌                        | Contains implicit writes like save_memory / todo_write                                          |
| MCP tools                     | ❌                        | Untrusted                                                                                       |

**TOCTOU: why Edit is not in the allowlist**

In theory, Edit's `shouldConfirmExecute` is purely read-only (read the file, compute the diff). But there is a time window between prevalidate and schedule:

```
T=0      stream receives Edit(file=a.ts, ...) → prevalidate
T=10ms   shouldConfirmExecute reads a.ts, caches diff_v0
T=300ms  stream ends, scheduler.schedule()
T=305ms  meanwhile another tool/IDE/external process modifies a.ts
T=310ms  scheduler shows diff_v0 to the user
T=320ms  user confirms based on v0
T=330ms  Edit applies old params to the v1 file → content corruption / merge failure
```

This is TOCTOU. Fix directions:

- **A (recommended)**: Edit is not in the allowlist; prevalidate only covers the three `CONCURRENCY_SAFE_KINDS` classes. Cost: the benefit drops from "50-200ms (Edit-dominated)" to "50-100ms (read types only)"
- **B (optional strengthening)**: Edit enters the allowlist but the cache attaches `(mtime, size, content_hash)`; at schedule() time, verify it is unchanged before using the cache, otherwise recompute

The doc tentatively chooses A.

#### Interaction with Existing Parallel Scheduling

`coreToolScheduler.attemptExecutionOfScheduledCalls` (L2436+) uses `partitionToolCalls` to split tools into a "concurrency-safe batch" and a "serial batch", and the concurrent batch executes via `runConcurrently` (L2473).

prevalidate must align with this batching model:

- Cache is indexed by `callId` (not `(toolName, args)`, to avoid conflicts between concurrent same-name calls)
- A call whose prevalidate fails → does not affect other calls; at schedule time that call takes the original `shouldConfirmExecute` path
- On stream cancellation, cascade-abort all in-flight prevalidates by `signal`

#### Risks

| Risk                                                                        | Severity | Mitigation                                                                                            |
| --------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| Cached diff inconsistent with the actual file at confirmation time (TOCTOU) | High     | Approach A: Edit not in allowlist; approach B: cache attaches `(mtime, size, hash)` for verification  |
| prevalidate failure affecting scheduling                                    | Low      | On failure/timeout, fall back to the original `shouldConfirmExecute` path; a cache miss ≡ not enabled |
| Concurrent prevalidate sharing fds / resource contention                    | Low      | `QWEN_CODE_MAX_TOOL_CONCURRENCY` already caps concurrency (default 10)                                |

#### Benefit

50-100ms/round (within `CONCURRENCY_SAFE_KINDS` only). If approach B including Edit is chosen, theoretical benefit 100-200ms.

---

## 4. Overall Assessment and Roadmap

### 4.1 Overall Assessment

| Direction                        | RT Benefit                                            | Implementation Complexity          | Quality Risk | Dependencies                                                     | Priority |
| -------------------------------- | ----------------------------------------------------- | ---------------------------------- | ------------ | ---------------------------------------------------------------- | -------- |
| D1 Tool post-execution directive | 3-4s/terminal round                                   | Low (2-3d)                         | Low          | None                                                             | **P0**   |
| D2 summary fast routing          | 2-3s/summary round (pending measurement)              | **Medium-high (9d)**               | Medium-high  | D2's own heuristics + main-chat validation experiment + ACP sync | **P1**   |
| D3 Presentation decoupling       | 3-4s perceived improvement (depends on user behavior) | Medium (3-5d, incl. invariant fix) | Medium       | D1 history-invariant fix                                         | **P1**   |
| D4 Stream-ahead scheduling       | 50-200ms/round                                        | High (5-7d)                        | Very low     | None                                                             | P2       |

#### D2 Effort Breakdown

| Subtask                                                                                                                      | Estimate |
| ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| Main-chat fastModel-streaming validation experiment (incl. P_compact measurement)                                            | 1d       |
| Fast candidate-model baseline measurement (incl. TTFT, P95, `thinkingConfig` compatibility)                                  | 1d       |
| `selectContinuationTier` + `summaryTierRef` integration (useGeminiStream)                                                    | 0.5d     |
| Heuristics implementation (incl. `MUTATOR_KINDS` reuse / `wouldTriggerCompression` estimation / multilingual / state change) | 1d       |
| `GeminiChat.retryStreamWithModel` + `discardPendingAssistant` interface implementation                                       | 1.5d     |
| ACP Session sync modification (acp-integration/session/Session.ts)                                                           | 1d       |
| Telemetry span fix (`requested` / `actual` split)                                                                            | 0.5d     |
| User-level setting `summaryTierStrategy` + JSON schema + `/config` integration                                               | 0.5d     |
| Unit tests (race, abort timing, history invariant, fallback path, ACP path)                                                  | 2d       |
| **Total**                                                                                                                    | **9d**   |

> Note: the earlier estimate of 6.5d did not include the ACP path, the `wouldTriggerCompression` gate, the cleanup checklist, settings-schema engineering, etc.

### 4.2 Implementation Roadmap

#### Phase 1: D1 Tool Post-Execution Directive (1 week)

- Extend `ToolResult.postExecution` (tools.ts L422): `skipLlmRound` + `resultIsTerminal`
- Implement the `skipLlmRound` short-circuit in `handleCompletedTools` (useGeminiStream.ts L2038)
- Unit-test coverage of the history invariant
- **Phase 1 does not consume `resultIsTerminal`** (left for Phase 3)

#### Phase 2: Building the Signal Ecosystem (2 weeks, in parallel with Phase 4)

- Built-in tools are progressively tagged with `skipLlmRound` / `resultIsTerminal` (see the §3.1 table)
- Verify tagging coverage ≥60% (weighted by turn count, not by call count)
- Collect production data to calibrate the §3.2 veto-gate thresholds
- Run the §3.2 main-chat validation experiment and baseline measurement at the end of Phase 2

#### Phase 3: D2 + D3 (about 3 weeks, including ACP sync)

> **Revision**: the early roadmap estimated 1 week, not including the fastModel-streaming validation experiment, the `retryStreamWithModel` implementation, the unified invariant fix, and the ACP-path sync.

- Before coding: complete the main-chat validation experiment + baseline measurement (incl. `P_compact` and thinkingConfig compatibility)
- Add `summaryTierRef` + `selectContinuationTier` (incl. the `wouldTriggerCompression` gate)
- Add `GeminiChat.retryStreamWithModel` + `discardPendingAssistant`
- **Sync-modify the ACP Session path** (acp-integration/session/Session.ts) to use the same decision function
- Add `StreamingState.Summarizing` + input-path reuse + abort cleanup checklist
- Unified history-invariant fix (D1+D3 same source)
- Feature flag `experimental.summaryRoundFastModel: false`, **off by default in Release N**
- User setting `summaryTierStrategy`
- Telemetry span fix
- Runtime safeguard (ToolCallRequest abort + retryStreamWithModel)

#### Phase 4: D4 Stream-Ahead Scheduling (can be inserted independently)

- `CoreToolScheduler.prevalidate` + allowlist
- `processGeminiStreamEvents` incremental scheduling

---

## 5. Metrics, Acceptance, and Limitations

### 5.1 Performance Metrics

| Metric                                  | Baseline | Phase 1 | Phase 3                   |
| --------------------------------------- | -------- | ------- | ------------------------- |
| End-to-end RT P50 (3-round loop)        | 13.4s    | <10s    | <8s (pending measurement) |
| End-to-end RT P95                       | -        | <13s    | <12s (fallback-path cap)  |
| User-perceived time-to-first-result P50 | 13.4s    | <10s    | <5s (D3 enabled)          |
| User-perceived time-to-first-result P95 | -        | <13s    | <8s                       |
| LLM call count (skippable scenarios)    | 3        | 2       | 2 (faster)                |

> Note: the baseline is a single sample; baselines for ≥3 scenario classes need to be collected before landing.

### 5.2 Quality Metrics

| Metric                                                            | Baseline | Allowed Regression                 |
| ----------------------------------------------------------------- | -------- | ---------------------------------- |
| Tool-calling accuracy (fast model summary round)                  | 100%     | ≥98%                               |
| skipLlmRound misuse rate (user asks "more detail")                | -        | <1%                                |
| Fast model fallback_triggered rate                                | -        | <10% (>20% auto-disables the flag) |
| Half-sentence assistant entering history in the Summarizing state | 0        | 0 (hard requirement)               |

### 5.3 Cost Metrics

| Metric                                           | Baseline | Phase 3 Target                                                    |
| ------------------------------------------------ | -------- | ----------------------------------------------------------------- |
| Token cost per thousand sessions (summary round) | 100%     | <70%                                                              |
| Share of wasted tokens on the fallback path      | 0        | <15% (fallback rate × single fast tokens / single primary tokens) |

### 5.4 Decision-Log Schema

For each key decision in `selectContinuationTier` and `handleCompletedTools`, write one structured log line:

```
{
  turn_id, prompt_id,
  decision: 'skip' | 'fast' | 'primary',
  tier_requested: 'fast' | 'primary',          // decision (before fallback)
  tier_actual:    'fast' | 'primary',          // actually ran (after fallback)
  signal_skipLlmRound: bool,
  signal_resultIsTerminal: bool,
  user_strategy: 'auto' | 'always_primary' | 'always_fast',
  veto_reason: 'further_action' | 'write_tool' | 'unresolved_error' |
               'deep_reasoning' | 'cross_result' | 'output_tokens' |
               'lang_unsupported' | 'compact_or_clear' | null,
  tool_count, distinct_tool_count,
  has_write_tool: bool,
  has_error: bool, has_cancel: bool,
  output_tokens_est: int,
  user_prompt_classification: 'query' | 'action' | 'analysis',
  fast_ttft_ms, primary_ttft_ms,                // both on fallback
  fast_tokens_consumed: int,                    // tokens wasted on fallback (cost attribution)
  total_rt_ms,
  fallback_triggered: bool,
  fallback_reason: 'tool_call_seen' | 'timeout' | 'error' | null,
}
```

Observation metrics:

- fast trigger rate (expected 30-50%)
- fallback_triggered rate (expected <10%; >20% suggests disabling the default flag in the next release)
- share of each veto (identify too-strict/too-loose)
- fast_tokens_consumed × fallback_rate (reverse cost risk)
- frequency of users asking "more detail" (a fast quality-regression signal)

**`fast_tokens_consumed` measurement note**:

An abort-interrupted stream **most likely will not receive `finishReason` / `usageMetadata`**—the latter is only populated when the stream fully ends. The implementation must estimate:

- Preferred: before aborting, try `stream.return()` to let the generator take the finally path, which may obtain partial usage
- Fallback: estimate output tokens as the accumulated text length of received chunks × 4; estimate input tokens from history
- Tagging: attach `tokens_source: 'usage' | 'estimated'` to the log field; downstream analysis must distinguish them

### 5.5 Validation Method and Release Strategy

#### Validation

- Reuse the `/tmp/tool-timing.log` timing framework
- Add `T_userIdle` (the moment the user can type again)
- Add `T_firstToken` (the moment of the first streaming token)
- A/B test comparing the RT and cost distributions before and after each Phase

#### Release Strategy (Adapted for a Local CLI)

Qwen Code is a local CLI with **no runtime push capability**—the traditional "5% / 25% / 100% canary" does not apply. We adopt a **staged release rollout**:

| Stage                    | Release Node                 | feature flag default | Trigger Condition                                                               |
| ------------------------ | ---------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| Phase 3a: dogfood        | Release N                    | `false`              | Internal users self-enable with `summaryTierStrategy=always_fast`               |
| Phase 3b: opt-in default | Release N+1 (≥2 weeks later) | `false` (unchanged)  | dogfood-stage decision logs meet the bar: fallback <10%, net RT/cost benefit >0 |
| Phase 3c: on by default  | Release N+2 (≥4 weeks later) | `true`               | No quality regression reports at the user level in Phase 3b                     |
| Rollback                 | Release N+3 (if needed)      | `true → false`       | Large-scale fallback >20% or quality metrics regress                            |

**Rollback mechanism**:

- No runtime push; **rollback = ship a new release that turns off the default flag**
- User-level `summaryTierStrategy=always_primary` always provides an "I want to opt out right now" channel, independent of a new release
- The decision log's `fallback_rate` / `cost_regression` is evaluated each release cycle to decide the next step

### 5.6 Known Limitations

1. **Thin baseline data**: a single sample cannot cover all task patterns; scenarios need to be collected before landing
2. **fast-model premise**: if no significantly faster same-family model with adequate tool-calling exists → D2 is not enabled
3. **`skipLlmRound` trades quality for speed**: skipping the LLM = giving up model understanding and error correction; only applicable to high-certainty scenarios
4. **D2 trades quality+cost for speed**: the fast model's quality is below primary's; the fallback path is more expensive instead—net benefit must be measured via the decision log
5. **A `tryCompress` trigger may worsen things in reverse**: the fast model's small context means compression itself consumes an LLM call—the `wouldTriggerCompression` gate is an essential defense
6. **Presentation decoupling changes the interaction model**: the new mode requires user adaptation; user behavior determines the actual perceived benefit
7. **Network latency is uncontrollable**: this design reduces the number of calls, not the latency of a single call
8. **Direct Anthropic connectivity not covered**: the current alternation tolerance relies on Qwen / OpenAI-style APIs
9. **fastModel-streaming on the main chat is a first-time landing**: no production precedent, requires a dedicated validation experiment
10. **Local CLI has no runtime push**: the release strategy can only do staged release rollout, with no fast canary tuning
11. **D2 applies only to interactive paths**: Subagent / Cron / Notification do not benefit, deliberately so
12. **Long-term impact of mixed-model history is unknown**: once D2 is enabled, turns within a session switch between fast/primary; the coherence of long-session resume and context needs observation
13. **D4 benefit shrinks**: after Edit leaves the allowlist, prevalidate only covers pure-read tools (50-100ms benefit); the 200ms benefit including Edit requires approach B's mtime/hash verification mechanism

### 5.7 Key Code Locations

| File                                                  | Key Symbol                                                    | Location                 |
| ----------------------------------------------------- | ------------------------------------------------------------- | ------------------------ |
| `packages/core/src/tools/tools.ts`                    | `ToolResult` interface                                        | L422                     |
| `packages/core/src/tools/tools.ts`                    | `Kind` enum + `MUTATOR_KINDS` + `CONCURRENCY_SAFE_KINDS`      | L793, L806, L818         |
| `packages/core/src/tools/tools.ts`                    | `DeclarativeTool.kind: Kind` (every Tool instance carries it) | L165                     |
| `packages/core/src/core/client.ts`                    | `SendMessageOptions.modelOverride`                            | L142                     |
| `packages/core/src/core/client.ts`                    | `sendMessageStream`                                           | L1216                    |
| `packages/core/src/core/client.ts`                    | `modelOverride ?? getModel()`                                 | L1305, L1598             |
| `packages/core/src/core/client.ts`                    | `turn.run(model, …)`                                          | L1707                    |
| `packages/core/src/core/geminiChat.ts`                | `sendMessageStream(model, …)`                                 | L1387                    |
| `packages/core/src/core/geminiChat.ts`                | `history.push(userContent)`                                   | L1428                    |
| `packages/core/src/core/geminiChat.ts`                | `sendPromise` lock                                            | L1392                    |
| `packages/cli/src/ui/hooks/useGeminiStream.ts`        | `modelOverrideRef` (skill model selection)                    | L376, L2225              |
| `packages/cli/src/ui/hooks/useGeminiStream.ts`        | `processGeminiStreamEvents`                                   | L1365                    |
| `packages/cli/src/ui/hooks/useGeminiStream.ts`        | `sendMessageStream` call site                                 | L1841                    |
| `packages/cli/src/ui/hooks/useGeminiStream.ts`        | `handleCompletedTools`                                        | L2038                    |
| `packages/cli/src/ui/hooks/useGeminiStream.ts`        | `submitQuery(ToolResult, …)`                                  | L2355                    |
| `packages/core/src/services/toolUseSummary.ts`        | fast-model side query (non-streaming precedent)               | L108                     |
| `packages/core/src/followup/speculation.ts`           | fast-model streaming (forked-chat precedent)                  | L224                     |
| `packages/core/src/config/config.ts`                  | `fastModel` + `getFastModel` + `setFastModel`                 | L684, L1987, L2021       |
| `packages/core/src/core/coreToolScheduler.ts`         | `attemptExecutionOfScheduledCalls`                            | L2436                    |
| `packages/core/src/core/coreToolScheduler.ts`         | `runConcurrently` + `partitionToolCalls`                      | L2473                    |
| `packages/cli/src/acp-integration/session/Session.ts` | `sendMessageStream` call site (ACP / IDE path)                | L705, L965, L1182, L1423 |
| `packages/core/src/agents/runtime/agent-core.ts`      | Subagent `sendMessageStream` (unaffected by D2)               | L614                     |

---

## 6. Review Validation Record (2026-05-26)

### 6.1 Validation Method

For the few upstream data-quality assumptions and benefit estimates in the design doc that are **only asserted, not quantified**, we launched 4 parallel Explore subagents to do read-only code investigation. Each subagent answers only one factual question, makes no judgments, and gives no optimization advice. The investigation is based on the current `main` branch (HEAD: `026f2f768`).

| Validation Question                                                                    | Related Section                                |
| -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Q3 The fill rate of the `ToolResult.error` field across all current tools              | §3.2 `hasUnresolvedError` upstream dependency  |
| Q4 The actual availability of `usageMetadata` after a stream abort                     | §5.4 `fast_tokens_consumed` measurement        |
| Q5 The existence of "user follow-up / clarification" instrumentation                   | §5.2 fast quality-regression monitoring signal |
| Q6 The actual IO workload of `shouldConfirmExecute` for `CONCURRENCY_SAFE_KINDS` tools | §3.4 D4 benefit estimate                       |

### 6.2 Finding 1: The `hasUnresolvedError` Heuristic Has a 32% Tool Blind Spot (Affects D2)

**Fact**: among the 22 tools with error paths, **15 (68%) properly fill the `ToolResult.error` field** (the core I/O tools—shell, read-file, write-file, edit, grep, glob, ls, web-fetch, mcp-tool, cron-\*, etc.—are all in place), and **7 (32%) only stuff the error into the `llmContent` string**: `askUserQuestion`, `monitor`, `skill`, `lsp`, `exitPlanMode`, `todoWrite`, etc.

There is **no** unified `createErrorResult` helper; each tool implements error construction independently.

**Impact on the design**:

- If §3.2's `hasUnresolvedError` veto only checks the `ToolResult.error` field, **failures of these 7 tools will never trigger a "switch back to primary"**—the next round will still be routed to the fast model
- Among them, the **`skill` tool's failure being wrongly summarized by the fast model** is a high-priority risk scenario (the many skill-driven workflows in this repo would be affected)
- §3.2's listed "shell etc. must correctly fill ToolResult.error (an upstream data-quality dependency)" has **too narrow a scope**; shell is actually already proper, and the real under-reporters are skill / lsp / todoWrite etc.

**Recommended revision**: list "**convert the 7 tools that pass errors only via `llmContent` to properly fill the `error` field**" as a hard upstream dependency of D2 (§3.2 prerequisites), estimated at ~2d; do not accept the dirty path of "fall back to `llmContent.match(/^Error:/i)`" (high misjudgment risk).

### 6.3 Finding 2: The Implementation Cost of the `fast_tokens_consumed` Metric Was Underestimated (Affects D2 / §5.3)

**Fact**:

- `turn.ts`'s abort path (L289-291) `return`s directly, **with no finally block and no `stream.return()` call**—the "before aborting, `stream.return()` to let the generator take the finally path" implied by doc §5.4 has no such entry point in the current code
- `geminiChat.ts:processStreamResponse`'s `for await` loop records the turn only on a complete traversal (L1286); an abort interruption means the final usage-only chunk (usually carrying complete metadata) is **discarded directly**
- The main chat path has **no chunk-level token-accumulation fallback whatsoever**; only the subagent layer (`agent.ts:731-744`) has accumulation, which cannot be reused
- Conclusion: on abort, `usageMetadata` is **obtained zero times**; one can only estimate via `chars/4` (±20% error)

**Impact on the design**:

- In §5.4's "preferred / fallback / tagging" three-tier approach, **the "preferred" path is unreachable in the current code**—it first requires changing the `sendMessageStream` generator structure to add a finally, an effort of about 1d that the design doc does not reflect
- §5.3 lists "token cost per thousand sessions <70%" as a Phase 3 target, but if the metric itself has ±20% error, **"70%" and "82%" fall within measurement noise**

**Recommended revision**:

- Rewrite §5.3 as a **trend metric**, not a release gate; switch to a joint judgment of the decision log's "`fallback_triggered` rate + `fast_tokens_consumed` co-trend" two metrics
- Add to §5.4: implementing `fast_tokens_consumed` first requires modifying the turn.ts abort path to add finally + `stream.return()`, as a supplement to the §3.2 effort (+1d)

### 6.4 Finding 3: The `user_prompt_classification` and "User Follow-up" Instrumentation Need to Be Newly Built (Affects D2 / §5.2)

**Fact**:

- `packages/core/src/followup/` already has `speculation.ts` / `suggestionGenerator.ts` / `followupState.ts`, but its telemetry (`PromptSuggestionEvent`) records **"a system suggestion being accepted/ignored"**, not "a user actively following up"
- `ChatRecordingService` stores user messages but **does not attach classification labels**
- A whole-repo grep finds no `user_prompt_classification`, no Chinese/English follow-up pattern matching, and no `clarif*` / `intentDetect`-type mechanism

**Impact on the design**:

- The `user_prompt_classification: 'query' | 'action' | 'analysis'` field in the §5.4 decision-log schema **has no data source**—it can neither be derived from the existing PromptSuggestionEvent nor read from the ChatRecord
- The §5.2 "frequency of users asking 'more detail'" monitoring signal is the same; **the closest existing anchor, `followupState.onOutcome`, is not reusable**

**Recommended revision**:

- Add "a minimal user-input classifier implementation" (Chinese/English pattern matching, ~3d) to the §3.2 prerequisites, otherwise both `user_prompt_classification` and `requestImpliesFurtherAction` in the §5.4 decision log lack data
- Or **accept** not having these two signals during the Phase 3a dogfood stage, relying only on the `fallback_triggered` rate to monitor quality regression—low cost but high risk

### 6.5 Finding 4: An Inherent Contradiction in the D4 Design—the allowlist and Benefit Attribution Are Misaligned (Affects D4 / §3.4)

**Fact**:

- For the three tool classes `Kind.Read` (read_file), `Kind.Search` (glob / grep), and `Kind.Fetch` (web_fetch), `shouldConfirmExecute` / `getConfirmationDetails` **mostly inherit the `BaseToolInvocation` default implementation and do zero IO** (read_file / glob / grep have no override at all; web_fetch only does a 5-10 line string parse of the URL hostname)
- The ones that actually do IO are `Edit` / `WriteFile` (`calculateEdit` + `readTextFile` + `Diff.createPatch`, typically ~20ms), but §3.4 approach A excludes them from the allowlist to avoid TOCTOU
- **Result**: for the three tool classes left in the allowlist, prevalidate and not-prevalidate are essentially the same amount of work—the allowlist actually filters out "the only Edit that has IO to save" and keeps "tools that were zero-cost to begin with"

**Impact on the design**:

- §3.4's "upfront IO validation" narrative **does not hold**: the real source of the 50-100ms benefit is **the elimination of the scheduling wait of "stream fully ends → only then batch-schedule"**, which has almost nothing to do with tool-side IO
- Wrong benefit attribution brings two problems:
  1. **the allowlist can be wider**—any tool with an idempotent prevalidate works; it need not be bound to `CONCURRENCY_SAFE_KINDS`
  2. **the 5-7d investment is hard to justify**—if the real benefit is only the ~50ms from changing the scheduling model, and Edit is not in the allowlist, the ROI of this investment is lower than the design doc implies

**Recommended revision**: rewrite §3.4's benefit attribution—

- Split into two parts: (a) the stream wait saved by changing the scheduling model ~50ms, (b) the work that tool-side IO prefetch can save ~0ms (within the allowlist) / ~20ms (if Edit enters the allowlist)
- In the §4.1 overall-assessment table, change D4's RT benefit from "50-200ms" to "30-80ms (approach A, mainly from the scheduling model) / 100-200ms (approach B, including Edit)"
- In the §4.2 roadmap, further demote D4—the pure scheduling-model change can be done independently and need not be forcibly bound to the prevalidate concept

### 6.6 Combined Impact on the Roadmap

| Section                               | Original Estimate | Post-Validation Estimate | Increment Source                                                                                                                          |
| ------------------------------------- | ----------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D2 §3.2 effort (§4.1 breakdown table) | 9d                | **14-16d**               | +2d (Finding 1 upstream tool conversion) +1d (Finding 2 turn.ts finally change) +3d (Finding 3 input classifier, if taking the hard path) |
| D4 §3.4 overall assessment            | 5-7d              | 5-7d (unchanged)         | Effort unchanged, but the **RT benefit attribution changes from "tool-side IO" to "scheduling model"**, lowering the investment ROI       |
| Phase 3 total duration (§4.2)         | ~3 weeks          | **~4-5 weeks**           | D2 effort increased + the upstream tool-conversion PR goes through its own review cycle                                                   |

**Recommended revisions to the original roadmap**:

1. **Keep D1 (P0) and D3 right after it**—this validation did not touch their core assumptions, the ROI judgment is unchanged
2. **Tighten D2's start condition**—make the upstream work of Findings 1/2/3 (about ~6d total) a "D2 start gate"; do not enter the §3.2 upstream experiment until it is complete
3. **Re-evaluate D4's priority**—since the real benefit is the scheduling-model change rather than tool-side IO, either (a) accept 30-80ms and demote D4 to P3 deferred, or (b) consider approach B (Edit + mtime/hash) to reclaim 100-200ms at an extra 5-7d
4. **Do not modify the §1.2 single-sample baseline**—but do not write a concrete number in the §5.1 P95 column until D1 lands and the ≥3 scenario-class baselines are completed

### 6.7 Follow-up Points Not Covered by Validation

The following follow-up points are subjective judgments or author-intent questions, not handled by subagents in this validation, and are left for later design review:

- Whether D2's implementation order should follow D3 (subjective ordering)
- Whether D1/D3 should be merged into Phase 1 and done together (implementation strategy)
- Whether the §3.2 `needsCrossResultReasoning` threshold of ≥3 is reverse-fitted to the §1.2 baseline scenario (author intent)
- Whether the line-number anchors in the §5.7 key-code-location table should be changed to symbol anchors (doc stability)

---

## 7. Skimmable-Wins Assessment and Next Steps (2026-05-26 second review)

### 7.1 The Facts That Triggered This Reprioritization

After the §6 validation, two more **facts that change the ROI judgment** were found:

1. **DashScope `cache_control` is already implemented** (`packages/core/src/core/openaiContentGenerator/provider/dashscope.ts:172-181`)
   - Streaming requests tag `system + the last message + the last tool definition`
   - The hit data `cached_tokens` is already collected into `usageMetadata.cachedContentTokenCount` (`converter.ts:1124-1149`)
   - This is a prefix-cache mechanism: Round N+1 automatically hits the prefix written by Round N
   - **The summary round happens to be the round with the longest hit prefix**

2. **The system prompt is already steady-state** (`prompts.ts` audit result)
   - There are no "changes every turn" liabilities like cwd / timestamp / git status / file list / LSP state
   - `process.cwd()` is only used as an `isGitRepository()` switch and is not written into the prompt content
   - The only dynamic points: `save_memory` tool triggers / `/model` switch / MCP dynamic loading (all event-driven, low-frequency)

### 7.2 These Two Facts Change D2's ROI Judgment

The §3.2 doc assumes "the fast model is ~2s faster than primary", with the baseline being **primary uncached vs fast uncached**.

But in real-world operation primary is **cached** (the summary round hits the strongest), so the correct comparison is:

> primary cached vs fast uncached

| Routing                                | Estimated Latency | Notes                                          |
| -------------------------------------- | ----------------- | ---------------------------------------------- |
| primary hits 80% prefix cache          | ~1.8-2.2s         | the summary round's current actual performance |
| fast no cache (not shared cross-model) | ~1.5-2s           | the actual performance after D2 switches       |

**Net gap: a few hundred milliseconds, or fast might even be slower**. Stacked on top of 14-16d of engineering cost + quality risk + fallback waste, **D2's net benefit approaches 0 or is negative**.

The §3.2 prerequisites **must add**: the baseline measurement must compare primary **cached** vs fast **uncached**, and D2 should not be enabled when `T_primary_cached < T_fast_uncached × 1.5`.

### 7.3 Candidate List (Reordered by Skimmability)

**True skimmable wins (act immediately, < 1d investment, very low risk, certain benefit)**:

| Item                            | Investment | Benefit                                         | Operation Location                                                                                                      |
| ------------------------------- | ---------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Concise-reply instruction       | 30min      | ~2s/summary round (output tokens halved)        | Add a sentence to the `prompts.ts` Final Reminder section                                                               |
| Expose cache hit rate telemetry | 0.5d       | 0s directly, an **enabler** for later decisions | `cachedContentTokenCount` is already collected, just unexposed; and should tag the round after `save_memory` separately |

**Near-skimmable (decide based on data, 0.5-1d investment)**:

| Item                               | Investment                          | Benefit                                  | Decision Prerequisite                                                                               |
| ---------------------------------- | ----------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| summary round `tool_choice='none'` | 0.5-1d                              | 0.3-1s (sampling skips tool_call tokens) | Needs "is this a summary round" judgment logic; low misjudgment risk                                |
| summary round thinking off         | 1d                                  | 0.5-2s                                   | Only meaningful for thinking-enabled models (qwen3.5-plus, glm-4.7, kimi-k2.5, etc.)                |
| UI rendering-layer chunk batching  | 0.5d research + 0.5d implementation | pending validation                       | Hypothesis: the `useGeminiStream` token-render accumulation overhead of long summaries is not small |

**To be investigated (might be a big fish)**:

| Item                                    | Research Investment      | Potential Benefit     | Key Unknown                                                                                                                                                          |
| --------------------------------------- | ------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~DashScope `scope: 'global'` support~~ | ~~0.5d docs + 0.5d A/B~~ | ~~cross-session hit~~ | **Investigated, conclusion (c) not feasible** (see the §7.4 Finding B investigation result). This row is kept as a decision record; do not restart the investigation |

**Medium-scale changes (not skimmable wins, evaluated separately)**:

| Item                                           | Investment          | Risk   | Benefit                  |
| ---------------------------------------------- | ------------------- | ------ | ------------------------ |
| D1 `skipLlmRound` (terminal-query scenario)    | 2-3d                | Medium | 3-4s/terminal round      |
| summary-round tool-result trimming (D5 subset) | 2d                  | Medium | 1-2s                     |
| D3 `Summarizing` state                         | 3-5d                | Medium | perceived improvement 3s |
| system prompt slimming                         | 2-3d incl. A/B test | Medium | 0.5-1s                   |

**Abandoned directions (do not do again)**:

| Item                                                         | Reason for Abandonment                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| D2 fast model routing                                        | Offset by the DashScope cache; net benefit approaches 0 or negative                                  |
| D4 prevalidate                                               | Benefit misattributed (the real ~50ms comes from the scheduling model), 5-7d investment not worth it |
| system prompt stabilization                                  | Already steady-state, nothing to do                                                                  |
| stream-ahead terminal (abort the wrap-up pleasantries early) | High misjudgment risk; the user perceives the answer being cut off                                   |

### 7.4 Three New Findings Worth Expanding On

#### Finding A: The Real Mechanism of `tool_choice='none'`

In the OpenAI / DashScope API, `tool_choice='none'` is not just "forbid calling tools"—the model's sampling stage will **completely skip the probability allocation for the `<tool_call>` special tokens**, and the decoder goes straight down the natural-language generation path. The benefit is not in "saving one or two retries" but in the sampling itself being faster.

#### Finding B: `scope: 'global'` Already Has an Anthropic Precedent in the Repo

`packages/core/src/core/anthropicContentGenerator/converter.test.ts:85, 1543` already uses `cache_control: { type: 'ephemeral', scope: 'global' }`. But when `provider/dashscope.ts:288` tags cache_control, it **does not pass scope**:

```typescript
cache_control: { type: 'ephemeral' },   // no scope
```

If the DashScope server recognized `scope: 'global'`:

- system + tools would be upgraded to a global cache (TTL far larger than ephemeral's 5min)
- **cross-session hits**, and startup latency drops too
- This one thing alone might yield more benefit than all of D2's original assumed benefit

##### Investigation Result (2026-05-26, conclusion: (c) not feasible, closing this thread)

The fact list obtained by consulting the Alibaba Cloud Bailian official docs `help.aliyun.com/zh/model-studio/context-cache`:

| Question                       | Conclusion                                                                                                                                                                                                                                                                     | Evidence                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `scope` field support          | **Not supported**. Only `type: 'ephemeral'` is recognized; any `scope`/`persistent`/`global` is silently dropped                                                                                                                                                               | Official doc verbatim: "only supports setting `type` to `ephemeral`" |
| ephemeral actual TTL           | **5-minute sliding window** (reset on hit)                                                                                                                                                                                                                                     | Stated explicitly in the Bailian docs                                |
| long-TTL / global mechanism    | **No public-cloud API-side mechanism at all**. No `persistent` type value, no separate pre-upload API, no `prompt_cache_key`; the only "global persistent" product is PAI Global Context Cache (self-deployed + vLLM + Lingjun + shared Redis), unrelated to the DashScope API | PAI docs                                                             |
| cross-session sharing          | Same account + same model + content match → already hits (this is what `ephemeral` already does); different accounts never share                                                                                                                                               | Bailian docs                                                         |
| Pricing                        | cache write 125%, explicit cache read 10%, **implicit cache read 20%** (you get the implicit 20% discount even without a `cache_control` tag)                                                                                                                                  | Bailian pricing docs                                                 |
| Minimum cacheable prompt       | **1024 tokens**                                                                                                                                                                                                                                                                | Bailian docs                                                         |
| Model support (explicit cache) | qwen3.7-max / qwen3.6-plus / qwen3.5-plus / qwen3-coder-plus / qwen3-vl-plus / deepseek-v3.2 / kimi-k2.5 / glm-5.1 are all explicitly listed. **qwen3.6-plus and qwen3.7-max also enjoy the 90% explicit-cache discount**                                                      | Bailian model list (re-verified 2026-05-26)                          |

**The knock-on significance of several side findings**:

1. **The sliding-window TTL** is good news for the agent loop—consecutive calls within a loop are usually <30s apart, so the **cache is always fresh and will not expire after 5min**
2. **The implicit cache 20% discount** is a free bonus—you get it even without a `cache_control` tag; but fine-grained control requires being explicit
3. ~~`qwen3.6-plus` not in the explicit list~~ —— **correction (2026-05-26)**: on re-verification, qwen3.6-plus **is indeed in the explicit-cache list** and enjoys the 90% discount. The previous round's report was wrong here and has been corrected in this section's first table
4. **The current approach in `dashscope.ts:288` is already the capability ceiling of the DashScope public-cloud API**—there is no room to squeeze further

**The knock-on reinforcement of the §7.2 D2 judgment**:

The sliding-window TTL means that within the agent loop the summary round **hits primary's cache almost 100%** (the previous rounds just hit it, within 5min). D2 switching to the fast model not only shatters the accumulated cache-write chain, but **also degrades the summary round from "nearly 100% hit" to "complete miss"**—the net-benefit judgment is even more clearly negative than the §7.2 original assumption.

#### Finding C: The UI Rendering Layer Is an Overlooked Blind Spot

The §1.2 baseline labels "framework overhead" as 0.3s (3%), but this is a rough estimate. Ink 7 + React 19.2 triggers setState → re-render on every chunk; for a long summary the accumulation may be 200-500ms. We need to check how `useGeminiStream` handles the token stream and whether it merges chunks with `requestAnimationFrame` / `useDeferredValue`.

### 7.5 Pending-Data Checkpoints — When Data Arrives, Which Decision to Look At

This section is **the active entry point of this document**: whenever any measurement data later arrives, consult the table below to decide which decision to revisit.

#### Checkpoint 1: After the cache hit rate data is out

**Trigger condition**: the "expose cache hit rate telemetry" skimmable win has been live ≥3 days and the decision log contains the `cached_tokens` / `prompt_tokens` distribution.

**Data to look at**:

- The P50, P90 distribution of the overall hit rate (cached / prompt)
- By round: the hit rate of Round 1 / Round 2 / Round 3 (summary) each
- The hit rate of the round following a `save_memory` trigger (should be near 0)
- The hit rate of the round following a `/model` switch (should be near 0)

**Decision paths**:

| Overall Hit Rate | Meaning                                                | Action                                                                                                      |
| ---------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| > 70%            | the status quo is already near the theoretical ceiling | Only do #1 concise instruction + Finding B investigation; the rest as needed                                |
| 40-70%           | there is still room but the source is unclear          | Analyze the per-round hit rate to find which segment is missing                                             |
| < 40%            | something dynamic is busting the cache                 | Re-audit the system prompt / userMemory trigger frequency; `save_memory` may be more frequent than expected |

#### Checkpoint 2: DashScope `scope: 'global'` doc investigation result ✅ Completed (2026-05-26)

**Result**: **completely unrecognized**. See the "Investigation Result" paragraph of §7.4 Finding B.

**Action taken**: accept the status quo, skip this item. `dashscope.ts:288` keeps the existing `ephemeral` tag, no change needed.

**Do not restart this investigation later**—unless DashScope officially announces a new persistence mechanism.

#### Checkpoint 3: UI Rendering-Layer Investigation Result

**Trigger condition**: Finding C's investigation is complete (look at `useGeminiStream` token-stream handling + Ink/React DevTools measurements).

**Decision paths**:

| Result                                          | Action                                                       |
| ----------------------------------------------- | ------------------------------------------------------------ |
| Long-summary stream render accumulation > 200ms | Switch to batching (`useDeferredValue` or custom throttling) |
| Render overhead < 100ms                         | Close this thread                                            |

#### Checkpoint 4: Second Baseline Measurement After Completing the "True Skimmable Wins"

**Trigger condition**: #1 concise instruction + Checkpoint 1/2/3 decisions complete ≥1 week.

**Data to look at**:

- End-to-end RT P50 compared with the §1.2 single-sample baseline (13.4s)
- The summary round's standalone P50 / P95
- User follow-up rate (if skimmable win A incidentally did user-input classification)

**Decision paths**:

| Cumulative Savings               | Action                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| > 4s (reach 9.6s end-to-end P50) | Evaluate D1 `skipLlmRound` (saves another 3-4s/terminal round)                                                                      |
| 2-4s                             | Accept the status quo, evaluate whether D3's perceived improvement is worth doing                                                   |
| < 2s                             | Re-examine: was the skimmable win itself overestimated, or is there an unidentified bottleneck (network RTT, provider-side latency) |

### 7.6 Final Verdict on Each Direction in §3

Based on the §6 validation + this section's ROI reprioritization:

| Direction                        | §3 Original Priority | This Section's Verdict                                         | Rationale                                                                                          |
| -------------------------------- | -------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| D1 Tool post-execution directive | P0                   | **Keep P0**, but re-evaluate after the skimmable wins are done | ROI is still good, but no longer "do it immediately"—first take out the cheaper skimmable wins     |
| D2 summary fast routing          | P1                   | **Defer / Won't Fix**                                          | Offset by the DashScope cache; 14-16d investment for near-0 benefit                                |
| D3 Presentation decoupling       | P1                   | **Keep as optional**, see Checkpoint 4 data                    | The perceived improvement is certain, but absolute RT is unchanged and it depends on user behavior |
| D4 Stream-ahead scheduling       | P2                   | **Defer**                                                      | Benefit misattributed; the real ~50ms is not worth 5-7d                                            |

### 7.7 Recommended Execution Order

**Day 1** (doable by one person in one day):

- ✅ Add the concise-reply instruction to `prompts.ts` (30min)
- ✅ Expose `cachedContentTokenCount` to telemetry + tag `save_memory` / `/model` switch (0.5d)
- ✅ Start the Finding B investigation: query the DashScope `scope: 'global'` docs + compare against the existing Anthropic usage (0.5d)

**Day 2-3**:

- Collect the first batch of cache hit rate data
- Start the Finding C investigation: the React render path of `useGeminiStream`
- Decide whether to do the `scope: 'global'` change based on Checkpoint 2

**End of Week 1**:

- Checkpoint 1 data decision (look at the distribution)
- Decide whether to do `tool_choice='none'` / thinking off (based on the hit rate data)

**Week 2-3**:

- Checkpoint 4 second baseline measurement
- Decide whether to start D1 (the largest non-skimmable item, 3-4s/terminal round)

**Never do**: D2 / D4 / system prompt stabilization.

### 7.8 `prompts.ts` Dynamic-Content Audit (2026-05-27)

When §7.1 gave the conclusion "the system prompt is already steady-state", it only did a rough grep. This section is a systematic audit of `packages/core/src/core/prompts.ts` (1169 lines), listing the inventory as the basis for later cache-hit-rate analysis and skimmable-win decisions.

**Audit method**: enumerate all `${...}` interpolation expressions, IIFEs, `process.*` / `new Date` / `Date.now` / `Math.random` / `fs.*` calls, and for each, judge "whether it changes within the same session".

#### Completely Absent (the Frequently Suspected Liabilities)

| Candidate                                       | Code Fact                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Date.now()` / `new Date()`                     | **Zero occurrences** in the whole text (`rg` finds no match)                                                                 |
| `Math.random()`                                 | **Zero occurrences**                                                                                                         |
| `process.cwd()` value written into prompt       | Only L366 `if (isGitRepository(process.cwd())) { ... }`; **the value is not written into the string**, only used as a switch |
| git status / git branch subprocess calls        | **Zero times**; the git section is static guidance text                                                                      |
| Current file list / project structure injection | **Zero times**                                                                                                               |
| LSP state / error count                         | **Zero times**                                                                                                               |
| User input history                              | **Zero times** (history goes through messages, not in system)                                                                |

#### Once at Startup, Unchanged Within the Session

| Location | Content                                                                                                 | When It Might Change                   |
| -------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| L190     | `process.env['QWEN_SYSTEM_MD']` decides the basePrompt source (default vs user system.md)               | unchanged within the process           |
| L342-343 | `process.env['SANDBOX']` decides which sandbox-section version to pick (Seatbelt / Sandbox / Outside)   | unchanged within the process           |
| L366     | `isGitRepository(process.cwd())` decides whether the git section is inserted                            | cwd usually unchanged within a session |
| L871     | `process.env['QWEN_CODE_TOOL_CALL_STYLE']` decides the tool-call style (qwen-coder / qwen-vl / general) | unchanged within the process           |

#### Event-Triggered (Low-Frequency)

| Parameter                                                       | Trigger Condition                                       | Frequency Estimate            |
| --------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------- |
| `userMemory` (1st param of `getCoreSystemPrompt`)               | `save_memory` tool / `/memory refresh` / extension load | 0-3 times/session             |
| `model` name (affects which branch `getToolCallExamples` picks) | `/model` switch                                         | rare                          |
| `appendInstruction`                                             | a config item, essentially unchanged within a session   | almost never                  |
| `deferredTools` (`buildDeferredToolsSection`)                   | MCP dynamic tool loading                                | mostly during session startup |

#### A Subtle Little Pitfall

L207-209: if `QWEN_SYSTEM_MD` env is set, **every** `getCoreSystemPrompt` will `fs.readFileSync(systemMdPath)`:

```typescript
const basePrompt = systemMdEnabled
  ? fs.readFileSync(systemMdPath, 'utf8')
  : `...`;
```

- When the file is unchanged the content is stable → cache hits are unaffected
- But every LLM-call round has a synchronous IO (default `.qwen/system.md`; a network-mounted file would be slower)
- Does not affect this section's "cache-friendliness" conclusion; recorded only as a known minor performance pitfall

#### Knock-on Conclusions

1. **Within a steady-state session the system prompt produces byte-for-byte identical output every time** → the DashScope ephemeral cache key (based on content hash) is stable for the whole segment → **the system segment's cache hit rate is nearly 100%**
2. The only event that busts the cache is `save_memory`—a core feature that cannot give way to cache
3. **Cost analysis of skimmable win #1 (concise-reply instruction)**: adding the instruction to the Final Reminder section (L389-390) → the system prompt content changes once → **the first request is a cache miss (a one-time warmup cost), after which all requests continue to hit**
4. **§7's abandoned judgment of "system prompt stabilization" gets formal evidentiary support**—not only is it unnecessary to do, but even "in theory, doing it could further reduce the cache-miss rate" does not hold, because it was already ≈ 0
5. This audit can serve as a reference baseline for later related discussions, avoiding repeated grep; if prompts.ts changes significantly, this section needs to be updated in sync
