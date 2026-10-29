# Reducing Agent Loop Rounds: Starting from Skill Design

> Same directory as `rt-optimization-design.md`, and complementary to it: that document discusses round reduction at the **framework mechanism** level (D1 skipping the final summary round, D2 fast routing, D4 prevalidate), whereas this document argues that **the real lever for round reduction lies at the skill/tool design layer**, and proposes an actionable path that does not depend on framework changes and does not depend on cache hit rate data.

---

## 0. Acceptance Spec (pre-development gate)

> This section is the **pre-development gate** — it lists which specs must be confirmed before starting work, and which specs must wait to be data-driven. Putting specs up front rather than "measuring metrics after the work is done" is meant to avoid: (a) discovering after writing the code that a metric is unmeasurable, (b) thresholds drifting with results and distorting conclusions, (c) leaving no stop-loss line so the project gets stuck in "looks like it's making progress, but actually produces no gain".
>
> **Applicability boundary of this spec framework**: this framework assumes that the correctness of the direction can be judged after the P1.5 baseline measurement. This assumption holds for the "round reduction" scenario, because it has clear measurable signals (round count, followup_rate, batch_size). **Scenarios outside this assumption** (for example, future use of the same framework for a hard-to-quantify direction like "quality optimization") may have spec-front-loading actually hinder fast learning; when you hit such a case, fall back to the §0.5 governance process to re-evaluate, and do not mechanically apply this framework.

**Specs fall into four layers — with different timing**:

| Layer | Type                                                            | Locking timing                                                 |
| ----- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| §0.1  | Engineering-layer spec (data pipeline, code-change correctness) | **Pre-development**, can be locked immediately                 |
| §0.2  | Statistical-layer spec (the project's "success" metrics)        | **Pre-development**, thresholds locked after the P1.5 baseline |
| §0.3  | Stop-loss line ("if this happens, abandon" hard conditions)     | **Pre-development**, immovable                                 |
| §0.4  | Per-skill spec (which one to change, target value)              | **Deferred**, Layer 1 data-driven                              |

### 0.1 Engineering-layer spec (must be pre-development · can be locked immediately)

Correctness spec for the data pipeline and code changes — does not depend on any business judgment or baseline data, and should be locked before development starts:

- **qwen-logger path is unobstructed** (§4.1.1b): the skill_launch event can land on both the OTLP and qwen-logger pipelines simultaneously
- **`prompt_id` linkage**: the `skill_launch` + subsequent `tool_call` triggered by a single user prompt can be grepped out as a complete trail using the same `prompt_id`
- **`batch_size` not undefined** (§4.3.2 direction A): a single-tool batch explicitly sets `batch_size = 1` / `batch_position = 0`
- **SQL runs end to end** (§4.1.2): the offline SQL produces non-empty output on the real telemetry backend and can distinguish high/low followup_rate skills
- **Baseline variance < P50 × 20%** (P1.5): the baseline measurement is stable (otherwise subsequent A/B comparisons are not trustworthy) — note: although this item is listed under §0.1 engineering layer, **locking it depends on the P1.5 baseline data**, making it the only deferred verification item in §0.1; if P1.5 does not pass, the §0.2 thresholds cannot be locked credibly
- **Skill size budget** (Layer 2 changes): after inlining followups, the skill description token count must not exceed 2× the pre-change value, and the absolute value must be ≤ 500 tokens (take the smaller value). If exceeded, split the skill per §4.2 rather than merging. This item aligns with §7 item 2 and the existing constraints in §4.2, and is front-loaded into the spec layer
- **`npm run preflight` fully passes**: the hard gate for every PR

### 0.2 Statistical-layer spec (must be pre-development · thresholds locked after P1.5)

The project's "statistically successful" metrics — the **direction** is fixed up front, and the **threshold** is locked after the baseline is measured (to avoid filling in numbers out of thin air):

| Metric                                                    | Direction | Locking timing             | Current placeholder threshold (to be calibrated) |
| --------------------------------------------------------- | --------- | -------------------------- | ------------------------------------------------ |
| Weighted `followup_rate` of top-3 skills                  | ↓         | End of P1.5                | ≥ 30%                                            |
| End-to-end RT P50 for sessions containing a skill         | ↓         | End of P1.5                | ≥ 2s                                             |
| Share of tool_call with `batch_size > 1`                  | ↑         | Before P3                  | ≥ 30%                                            |
| A/B significance of the changed skill's trigger scenarios | p < 0.05  | Before P2 changes complete | n TBD                                            |

> **Key constraint**: placeholder thresholds are not commitments. If the P1.5 baseline shows "weighted followup_rate of top-5 skills < 30%" (triggering §0.3 stop-loss line #1), the project is terminated; **you must not lower the spec just to make the threshold "achievable"**.
>
> **How to measure**: the measurement method, SQL template, and A/B design for each metric are in §5.1-§5.2; the sample-size calculation for statistical significance (p < 0.05) is in §5.1.

### 0.3 Stop-loss line (must be pre-development · restrictedly adjustable after P-1 locking)

Already listed in §5.3. These are the "if this happens, abandon" hard conditions — **under no circumstances may the stop-loss line be relaxed in order to meet the §0.2 statistical-layer spec**.

- **Outcome metrics** (3 items): top-5 weighted `followup_rate < 30%` / RT P50 ↓ < 1s after changing 2 skills / `batch_size P50` still = 1 after Layer 3
- **Process metrics** (3 items): skill hit rate ↓ ≥ 5pp / inlined-followup failure rate ≥ 5% / user cancellation rate ↑ ≥ 2pp

See §5.3 for details.

**Adjustability rules** (to avoid rigid discipline without data support):

| Stage                                     | Adjustable?                                                   | Direction of adjustment                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| At P-1 locking                            | ✅ Adjust freely (based on historical telemetry or consensus) | Any                                                                                                                                               |
| After P-1 locking → end of P1.5           | ❌ Not adjustable                                             | —                                                                                                                                                 |
| End of P1.5 (when the baseline comes out) | ✅ Only **relaxation** allowed once                           | Relaxation (e.g., 30% → 25%) requires data evidence + 2-person review; **tightening is not allowed** (to avoid adding a stop-loss after the fact) |
| After P1.5                                | ❌ Not adjustable                                             | —                                                                                                                                                 |

> The placeholder threshold values (30% / 1s / 5pp, etc.) currently have **no historical data support** and are engineers' intuition before the P-1 review. If recent 4-week historical telemetry can be obtained at the P-1 review, the stop-loss line should be calibrated based on the historical data; if it cannot be obtained, the placeholder values are retained, and the "relax once" rule above is executed at the end of P1.5.

### 0.4 Per-skill spec (must be deferred · data-driven)

Which specific skill to change, and what target `followup_rate` to change it to — **not locked until Layer 1 data is available**.

Reason for not locking: a priori design vs. a posteriori data can differ greatly. Forcing it up front would repeat the mistake of the `rt-optimization-design.md` §7 D2 route — the a priori assumption "the fast model is 2-3s faster" was overturned by the a posteriori fact that cache was already implemented, causing the net gain of that plan to approach 0 or even be negative.

**Output location**: the per-skill spec is produced data-driven at the end of P1.5, and is declared independently in the description of each Layer 2 PR (it does not go into the design document, to avoid changing the document every time a skill is changed).

**Per-skill spec structure template** (aligned with the mandatory items of the PR description in §4.2 — these two lists are the same one; §4.2 is the process view, this section is the spec view):

| Field                     | Content                                                                                                                                            | Data source                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1. Current data           | invocation_count, followup_rate, top followup tools                                                                                                | Layer 1 telemetry                                                         |
| 2. Target                 | followup_rate reduced from X% to Y%                                                                                                                | Based on the §0.2 improvement direction; absolute value set within the PR |
| 3. Change scope           | which followups to inline (read/grep/shell read-only), explicitly stating what **not** to inline (write operations / cross-skill / deep reasoning) | §4.2 change-pattern table                                                 |
| 4. Output contract update | the pre-declaration added to the skill description ("Returns: ...")                                                                                | §3.2 change example                                                       |
| 5. A/B plan               | observe followup_rate / RT P50 / process metrics for 2 weeks after the change, against the §5.1 acceptance line                                    | §5.1                                                                      |
| 6. Size proof             | skill description token count before and after the change (estimated with tiktoken), must not exceed the §0.1 "Skill size budget"                  | §0.1 item 6                                                               |

### 0.5 Spec governance

- **Modifying the §0.1 / §0.3 spec** requires a design document update + PR review; §0.3 may only be relaxed within the end-of-P1.5 window following the §0.3 "adjustability rules"
- **Modifying the §0.2 thresholds (after the P1.5 lock)** requires at least one of the following data evidence items attached:
  - (a) deviation analysis between the P1.5 baseline measurement result and the locked threshold (including a link to the raw measurement records)
  - (b) public benchmark data from similar projects (including a source link)
  - (c) a deviation explanation signed off by ≥ 2 internal reviewers

  At PR review, if none of the above evidence exists, the reviewer is **obligated** to block the PR — "adjusting based on engineer's intuition" is not accepted

- **The §0.4 per-skill spec** is written into the PR description after it is produced data-driven (following the §0.4 6-item template), and does not go into the design document

---

## 1. Background and positioning

### 1.1 The problem

The baseline given in `rt-optimization-design.md` §1.2: 3-round agent loop, 13.4s end to end, of which LLM calls account for 78%. Each round is ~3-4s.

```
Round 1 (3.8s, 28%): LLM decides to call a skill
Round 2 (3.0s, 22%): LLM decides to call shell
Round 3 (3.8s, 28%): LLM summarizes
```

After two rounds of review, `rt-optimization-design.md` §6/§7 rejected D2/D4, and downgraded D1/D3 to "re-evaluate after the groundwork is done". But **the entire original document focuses on the final Round 3 (the summary round) or on micro-optimizations within a single round (D4), and does not directly discuss why the "middle round" Round 1 → Round 2 occurs or whether it can be eliminated**.

The fact is: Round 2 exists **mostly because the skill called in Round 1 did not return a complete answer**, so the model appends a shell query to fill in the gaps. If a skill is designed to "get the complete result in one go", 3 rounds → 2 rounds, and what is saved is the ~3s of Round 2 — this is a gain surface that does not overlap with D1 at all.

### 1.2 Relationship with rt-optimization-design

| Round-reduction direction | Round hit                                                               | Lever location                        | Positioning in this document                        |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| D1 `skipLlmRound`         | Final summary round                                                     | Framework mechanism + per-tool opt-in | Fallback, **placed after Layer 2**                  |
| D2 fast routing           | Single-round latency                                                    | Framework mechanism                   | Already deferred, **out of scope of this document** |
| D3 Summarizing state      | Final summary round (perception layer)                                  | UI state machine                      | Optional, orthogonal to this plan                   |
| D4 prevalidate            | Single-round latency                                                    | Framework mechanism                   | Already deferred, **out of scope of this document** |
| **This plan's Layer 1-3** | **Middle decision rounds + rounds where concurrency was not triggered** | **skill design + prompt engineering** | **New direction**                                   |

### 1.3 Core argument

The real lever for round reduction lies at the skill/tool design layer, not in the agent framework. Three reasons:

1. **The §1.2 baseline itself exposes that the problem is in the skill** — the jump from Round 1 → Round 2 happens because the skill returns incomplete results; the framework did it right, the skill did it wrong
2. **Framework-level round reduction ultimately also requires per-tool opt-in** — D1's `skipLlmRound` must be explicitly marked on each tool, looping back around to skill engineering, plus an extra set of invariant-fixing + decision-gating cost
3. **ROI is locally measurable and easy to gray-release** — changing one skill saves one round × the number of times that skill is triggered; it does not depend on cache hit rate data, nor on cross-system changes

> **Before implementation you must first go through the §0 Acceptance Spec pre-development review (the P-1 stage, 0.5d)** — the §0.1 engineering-layer spec and the §0.3 stop-loss line must be locked before starting work; the direction of the §0.2 statistical-layer thresholds must also be confirmed up front (the specific values are locked after the P1.5 baseline). Skipping §0 to enter P0 implementation = defaulting to the "measure metrics only after the work is done" anti-pattern, which this document does not endorse.

---

## 2. Design principles

1. **Do not change the agent framework** — do not touch the `useGeminiStream` / `coreToolScheduler` / `geminiChat` core paths
2. **Data-driven prioritization** — build telemetry first, let the data tell you which skill to change, do not guess
3. **per-skill measurable and gray-releasable** — each skill change is an independent A/B, and a failure rolls back locally
4. **Compounding first** — gain = single round-reduction gain × trigger frequency, prioritize high-frequency skills
5. **Not bound to D1** — the success of this plan does not depend on whether D1 lands

---

## 3. Three-layer plan

### 3.1 Layer 1: Round-reduction telemetry (finding the gold mine)

**Goal**: let the data tell you which skills are most worth changing — i.e., "after using this skill, how likely is the model to append a tool call".

**Core fields** (per-turn, per-skill-invocation):

```typescript
interface SkillFollowupRecord {
  skill_name: string;
  prompt_id: string; // associates all events within the same user prompt
  turn_index: number; // which round this skill is in the loop
  followup_tool_names: string[]; // which other tools were called after the skill under the same prompt_id
  followup_count: number; // followup_tool_names.length
  followup_kinds: Kind[]; // Read/Edit/Execute/...
  next_turn_is_terminal: boolean; // the next round after the skill is text (no more tool calls)
  user_followup_within_30s: boolean; // user appends a new prompt within 30s after the result is shown (quality regression signal)
}
```

**Key metrics**:

- `skill_followup_rate = sum(followup_count > 0) / total_invocations`
- `terminal_after_skill_rate = sum(next_turn_is_terminal) / total_invocations`
- Aggregate by `(skill_name, top followup tool)` — see which tool is most often appended after which skill

**Gold mine criterion**:

```
(invocation_count_weekly × skill_followup_rate) ≥ threshold
↓
this skill is a round-reduction gold mine, prioritize for Layer 2 change
```

Threshold suggestion: of the top-3 skills sorted by the formula above, change the first 2 first.

### 3.2 Layer 2: Completing skill output

**Goal**: make the skills identified as gold mines return a complete answer in one go, eliminating the Round 1 → Round 2 jump.

**Change patterns (categorized by followup type)**:

| Followup pattern            | Typical scenario                                   | Change direction                                                    |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| skill → `read_file`         | skill gives a path, model reads it again           | skill reads directly internally, returns the content                |
| skill → `grep/glob`         | skill gives a directory, model searches again      | skill searches internally, returns the matches                      |
| skill → `shell` (read-only) | skill gives a command, model executes again        | skill runs the command internally, returns the output               |
| skill → `shell` (write)     | skill gives a plan, model executes the write again | **Keep** (write operations need confirmation, should not be merged) |
| skill → another skill       | chained call                                       | **Do not merge** (preserve composability)                           |

**Change checklist (per-skill PR template)**:

1. **Pre-declare the output contract** in the skill description: explicitly write "Returns: full file content / matched lines / command output", so the model knows it does not need to append a query
2. **Complete all read-only followups** inside the skill: inline into the skill any read/search operations whose telemetry shows a >50% append rate
3. **Do not inline write operations**: write operations require user confirmation and must be a separate round
4. **Do not inline deep-reasoning followups**: if the followup is "analyze further based on this", that is the model's job, not the skill's job
5. **Attach A/B telemetry**: compare whether `followup_rate` drops to <20% within 2 weeks after the change

**Typical change example (illustrative)**:

Before:

```
skill "list-workspaces" returns: ["ws_a", "ws_b"]
→ Round 2: model calls shell to get details for each workspace
```

After:

```
skill "list-workspaces" returns:
  - ws_a (owner: foo, last_active: 2026-05-20, status: active)
  - ws_b (owner: bar, last_active: 2026-05-01, status: archived)
description updated: "Returns workspaces with owner, last_active, status"
→ Round 2 disappears for ~80% of queries
```

### 3.3 Layer 3: Prompt to teach the model concurrency

**Goal**: for independent tools (reading multiple files, searching multiple directories), let the model issue tool_calls concurrently within the same round, compressing N rounds into 1.

**Prerequisite**: the infrastructure is already in place — `CONCURRENCY_SAFE_KINDS` at `tools/tools.ts:818` + the `partitionToolCalls` of `coreToolScheduler` can already execute read/search/fetch tools within the same batch concurrently. **What is missing is only the model's willingness to proactively issue concurrent tool_calls**; qwen-coder defaults to being serial.

**Change location**: `packages/core/src/core/prompts.ts` (already audited; adding near the `# Final Reminder` section at L396 will not break anything other than cache hits — it is only a one-time warm-up cost).

**Guidance text (illustrative, needs A/B tuning)**:

```
When you need to call multiple independent read-only tools (read_file,
grep, glob, web_fetch), emit them in a SINGLE tool_calls batch — do NOT
call them sequentially across rounds. They will execute concurrently.

Examples:
- Reading 3 files for comparison: emit 3 read_file calls in one batch
- Searching for 2 patterns: emit 2 grep calls in one batch

Do NOT batch when the second call depends on the first call's result.
```

**Measuring effectiveness**: add a new telemetry field `batch_size` (the number of tool_calls within the same turn) — compare the distribution before and after the prompt change.

#### 3.3.1 Extending `CONCURRENCY_SAFE_KINDS` (a Layer 3 sub-item)

The prompt teaching the model concurrency is only the supply side (the model is willing to issue multiple tool_calls at once), but `CONCURRENCY_SAFE_KINDS = { Read, Search, Fetch }` at `tools/tools.ts:818` determines **the range of tools that can actually execute concurrently**: `partitionToolCalls` (`coreToolScheduler.ts:775`) packs "consecutive safe tools" into a concurrent batch, and the rest run serially individually.

If the model issues 3 tool_calls at once per the guidance but one of them belongs to `Kind.Execute` and is not in the safe set, the entire batch will be split apart and executed serially — the gain of the Layer 3 prompt change will be offset by the runtime scheduling.

**Extension candidates** (by increasing risk):

- `Kind.Think` (includes save_memory / todo_write) — **do not add**, has implicit writes
- Read-only shell (Execute for which `isShellCommandReadOnly()` returns true) — `partitionToolCalls` already has a special case (the `partitionToolCalls` comment in `coreToolScheduler.ts` mentions "Execute (shell) is safe only when isShellCommandReadOnly() returns true"); the current state already covers it, no need to change `CONCURRENCY_SAFE_KINDS`
- MCP tools classified by `Kind` — the behavior of each MCP server varies greatly, and it is only safe with explicit opt-in at tool registration time

**Conclusion**: the current set is already reasonable, and **Layer 3 does not depend on extending `CONCURRENCY_SAFE_KINDS`**. The reason this section exists is: after collecting the `batch_size` telemetry data, **if you find "concurrent batch P50 < expected value", first check whether it is being cut off by `partitionToolCalls` rather than the model not being concurrent**. This is a diagnostic path for when the Layer 3 A/B fails, not a required item.

> Credit: codex review raised that "extending `CONCURRENCY_SAFE_KINDS` is an overlooked lever". After verification, the judgment is: the current state already covers the biggest chunk with the `isShellCommandReadOnly` special case; extending the set itself has small gain and large risk; keep it as a diagnostic path.

---

## 4. Detailed implementation

### 4.1 Layer 1: Telemetry extension (1-2d)

#### 4.1.1 Add `prompt_id` to `SkillLaunchEvent`

**Location**: `packages/core/src/telemetry/types.ts:896`

The current `SkillLaunchEvent` only contains `skill_name` + `success`, with **no `prompt_id`** — making it impossible to associate with other `ToolCallEvent`s within the same turn.

```typescript
// types.ts:896
export class SkillLaunchEvent implements BaseTelemetryEvent {
  'event.name': 'skill_launch';
  'event.timestamp': string;
  skill_name: string;
  success: boolean;
  prompt_id: string;                    // new
  turn_index?: number;                  // new

  constructor(
    skill_name: string,
    success: boolean,
    prompt_id: string,                  // new
    turn_index?: number,                // new
  ) { ... }
}
```

**Caller updates**: the 4 `logSkillLaunch` call sites in `packages/core/src/tools/skill.ts` (L386, L399, L426, L482), where passing `this.params` cannot get `prompt_id` — `BaseToolInvocation` only holds `params` and has no `request.prompt_id` field. **The actual implementation** injects via duck typing: `SkillToolInvocation` exposes a `setPromptId(id)` setter + a private `promptId` field, and `CoreToolScheduler.buildInvocation` (`coreToolScheduler.ts:1253`) duck-type calls `setPromptId(request.prompt_id)` after building, aligning with the existing `setCallId` hook pattern; the 4 `logSkillLaunch` calls within `execute()` all pass `this.promptId`. **The earlier version of this section's description ("BaseToolInvocation already has request.prompt_id") was wrong** and was corrected after the PR #4565 review.

#### 4.1.1b qwen-logger path fix (prerequisite)

Before adding `prompt_id`, you must first resolve an **existing path break**: `packages/core/src/telemetry/qwen-logger/qwen-logger.ts:908` defines the `logSkillLaunchEvent(event)` method, but **there is no caller anywhere in the repository** — `logSkillLaunch` at `loggers.ts:958` goes directly through the OTLP path `logs.getLogger(SERVICE_NAME).emit()`, bypassing qwen-logger.

Consequences:

- skill_launch events on the OTLP path can reach the OTLP collector (already working), but that dedicated qwen-logger reporting path is currently dead
- if the telemetry backend consumes from qwen-logger (rather than OTLP), skill_launch events are **not reported at all**
- the §4.1.2 offline SQL that derives `SkillFollowupRecord` depends on skill_launch events being persisted — **you must first verify whether skill_launch is currently visible in the backend**

Choose one of two fix directions:

- **A** (recommended): add one line `QwenLogger.getInstance(config)?.logSkillLaunchEvent(event)` to `logSkillLaunch` at `loggers.ts:958`, aligning with how `logToolCall` is written at `loggers.ts:230`
- **B**: confirm the backend only consumes from OTLP, and mark `logSkillLaunchEvent` in qwen-logger as `@deprecated` or delete it

**Why add only the QwenLogger path, not align with all 4 paths of `logToolCall`**:

`logToolCall` (`loggers.ts:220-247`) actually has 4 exits:

1. `uiTelemetryService.addEvent(...)` — UI display
2. `config.getChatRecordingService()?.recordUiTelemetryEvent(...)` — chat history
3. `QwenLogger.getInstance(config)?.logToolCallEvent(...)` — qwen-logger backend telemetry
4. OTLP `logger.emit(...)` — OpenTelemetry

skill_launch is a **pure backend telemetry event**, which does not need to be displayed in the UI (the user already sees the SkillTool's returnDisplay), nor does it need to enter the ChatRecording turn history (the tool calls inside the skill are each already recorded by recordUiTelemetryEvent). Therefore only the 3rd exit (QwenLogger) is added, the 4th exit (OTLP) is kept, and skipping 1/2 is intentional, not an omission.

**Field pass-through details**: `loggers.ts:961-966` uses `{ ...event }` spread to automatically pass through new fields (once `prompt_id` is added to `SkillLaunchEvent`, this path takes effect automatically), but if `logSkillLaunchEvent` at `qwen-logger.ts:908` explicitly destructures `event.skill_name` / `event.success` internally, new fields will not be automatically included and must be manually synced.

Effort: path A is about 0.5d (including backend-side confirmation); path B is about 0.2d (delete code + document the explanation).

#### 4.1.2 Deriving `SkillFollowupRecord` (offline aggregation)

No new event type is needed — both `ToolCallEvent` and `SkillLaunchEvent` already carry `prompt_id`, so offline SQL can derive it:

```sql
-- pseudo-SQL, adjust to the actual telemetry backend
WITH skill_events AS (
  SELECT prompt_id, skill_name, timestamp FROM events
  WHERE event_name = 'skill_launch' AND success = true
),
tool_events AS (
  SELECT prompt_id, function_name, timestamp FROM events
  WHERE event_name = 'tool_call'
),
followups AS (
  SELECT s.skill_name, s.prompt_id,
         COUNT(t.function_name) AS followup_count,
         ARRAY_AGG(t.function_name) AS followup_tool_names
  FROM skill_events s
  LEFT JOIN tool_events t
    ON s.prompt_id = t.prompt_id AND t.timestamp > s.timestamp
  GROUP BY s.skill_name, s.prompt_id
)
SELECT skill_name,
       COUNT(*) AS invocations,
       AVG(followup_count) AS avg_followup,
       SUM(CASE WHEN followup_count > 0 THEN 1 ELSE 0 END)::FLOAT / COUNT(*) AS followup_rate
FROM followups
GROUP BY skill_name
ORDER BY invocations * followup_rate DESC;
```

#### 4.1.3 Run telemetry for 1 week to collect data

- No change to user-facing behavior
- No configuration switch needed — telemetry already has an opt-in framework (the `telemetry.target` setting)
- Produce a skill ranking report after 1 week

### 4.2 Layer 2: Skill changes (per-skill 0.5-1d)

Change top-down based on the Layer 1 data. Each skill is an independent PR, and the PR description must contain:

1. **Data**: current invocation_count, followup_rate, top followup tools
2. **Change scope**: which followups were inlined (explicitly state what is not inlined)
3. **Output contract update**: what pre-declaration was added to the skill description
4. **A/B plan**: observe followup_rate again for 2 weeks after the change

**Notes**:

- When a skill inlines a read operation, do not duplicate all of read_file's edge-case handling (encoding, binary detection, etc.) — call the `read_file` tool itself, do not rewrite it
- Same for a skill inlining grep/glob
- A skill inlining a shell command must go through the `executeToolCall` standard path (to preserve telemetry)
- **Do not let the skill size explode**: when the skill description > 500 tokens after inlining followups, split the skill rather than merging

### 4.3 Layer 3: Prompt education (0.5d change + real-world tuning)

#### 4.3.1 Add concurrency guidance

**Location**: the `# Final Reminder` section (L396) in `packages/core/src/core/prompts.ts`

Add the guidance text from section 3.3. The specific wording needs A/B — start with the most plain version, then refine based on the degree of concurrency-rate improvement.

#### 4.3.2 Add `batch_size` telemetry

**Location**: the `ToolCallEvent` in `packages/core/src/telemetry/types.ts`, or a new lightweight `ToolBatchEvent`

```typescript
// Option A: add fields to ToolCallEvent (less intrusive)
export class ToolCallEvent {
  ...
  batch_size?: number;        // number of tool_calls within the same batch
  batch_position?: number;    // position within the batch (0-indexed)
}

// Option B: new ToolBatchEvent (clearer semantics, requires the full new-event-type process)
```

**Recommend option A** — small change, convenient to aggregate at query time.

**State-passing path** (key — this step's cost was underestimated by the earlier version):

`partitionToolCalls(callsToExecute)` at `coreToolScheduler.ts:2456` returns `batches`, **but the batch information is immediately lost on the scheduling path**:

```
executeToolCalls
  └─ batches = partitionToolCalls(...)           // knows batch.calls.length
     └─ for batch of batches:
        └─ this.runConcurrently(batch.calls, ...) // knows batch.calls.length
           └─ executeSingleToolCall(call, ...)   // ❌ no longer knows batch
              └─ ...
                 └─ finalizeToolCalls
                    └─ logToolCall(config, new ToolCallEvent(call)) // ❌ no batch context
```

The `ToolCallEvent` constructor (`types.ts:189`) only receives a single `CompletedToolCall`, with no batch field.

Fix directions:

- **Direction A** (recommended): add `batchSize?: number` + `batchPosition?: number` to `ScheduledToolCall`. The two branches fill them separately:
  - Concurrent branch (`coreToolScheduler.ts:2459-2460`, `batch.calls.length > 1`): before entering the loop, `runConcurrently(batch.calls, ...)` writes `batchSize = batch.calls.length`, `batchPosition = i` for each `call`
  - Serial branch (the `for (const call of batch.calls)` at `L2462-2464`): a single-tool batch explicitly sets `batchSize = 1`, `batchPosition = 0` (**do not default to undefined**, otherwise downstream telemetry aggregation will misjudge rounds where concurrency did not take effect as missing data)

  `new ToolCallEvent(call)` reads these two fields from `call` in the constructor

- **Direction B**: change the `ToolCallEvent` constructor signature to `new ToolCallEvent(call, batchInfo?)`, and change all callers in sync (4 logToolCall call sites + tests). This has a larger change surface than A

Effort: direction A is about 0.5d including unit tests; direction B is about 1d (more callers).

**Measuring "the model's willingness to be concurrent" in sync** — before and after the Layer 3 change to prompts.ts, compare the distribution of `the share of tool_call with batch_size > 1`. This is the key metric for whether Layer 3 takes effect; without this data the Layer 3 A/B cannot be wrapped up.

#### 4.3.3 Cache impact assessment

The `prompts.ts` change will invalidate the DashScope ephemeral cache once (the first request is a cache miss, then it recovers). This is a known one-time cost; see the prompt steady-state audit in `rt-optimization-design.md` §7.8.

---

## 5. Acceptance and measurement

> **This section is the "methodology" companion to the §0 Acceptance Spec** — §0 declares "the success metrics + the pre/deferred timing of thresholds", and §5 explains "how to measure, how to write the SQL, how to design the A/B". The thresholds in this section are the current placeholders of §0.2; the final values are locked after the P1.5 baseline measurement.

### 5.1 Per-skill A/B metrics (2 weeks after the change)

| Metric                                             | Acceptance line                   | Note                                             |
| -------------------------------------------------- | --------------------------------- | ------------------------------------------------ |
| The skill's `followup_rate`                        | < 20% (if 70%+ before the change) | Primary metric                                   |
| End-to-end RT P50 of the skill's trigger scenarios | drop ≥ 2s                         | From one fewer LLM call                          |
| The skill's `user_followup_within_30s` rate        | does not rise                     | User did not follow up = answer is complete      |
| The skill's `success` rate                         | does not drop                     | Inlined followups did not introduce new failures |

### 5.2 Overall RT metrics

| Metric                                          | Baseline                                                   | Target after Layer 2 changes the top-3 skills    |
| ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| End-to-end RT P50 (sessions containing a skill) | 13.4s (single sample) / baseline for ≥3 scenario types TBD | drop 2-3s                                        |
| Tool batch P50 size (Layer 3)                   | TBD                                                        | ≥ 1.3 (>30% of calls involve a concurrent batch) |
| Total skill followup_rate (weighted average)    | TBD                                                        | drop ≥ 30%                                       |

### 5.3 Failure signals — when to abandon this direction

**Outcome-metric stop-loss lines**:

- After the Layer 1 data is out, **the weighted followup_rate of the top-5 skills < 30%** → the round-reduction room is small, not worth continuing to Layer 2
- After Layer 2 changes 2 skills, **end-to-end RT P50 drops < 1s** → the change direction is wrong (the followup may be a write operation that should not be merged), stop and review
- 2 weeks after the Layer 3 prompt change, **batch_size P50 is still = 1** → the model does not accept the concurrency guidance, abandon Layer 3, keep only Layer 1+2

**Process-metric stop-loss lines (early warning up front, to avoid the plan "looking like it's making progress but actually producing no gain")**:

- **Skill hit rate (intended skill vs selected skill) drops ≥ 5pp** → the skill description was changed badly and makes the model select the wrong skill. Typical scenario: before the change, the user asking X always hit skill_a; after the change, it is occasionally routed to skill_b without producing an error (the model uses the wrong skill but barely cobbles together an answer), so the outcome metrics look normal but followup_rate rises instead. **Measurement method**: add `skill_invocation_pattern` to telemetry — cluster by the first N keywords of the user prompt, see which skill each cluster mainly triggers; compare the top-1 shift before and after the change
- **Skill inlined-followup failure rate ≥ 5%** → the skill change introduced a failure mode that did not previously exist (e.g., the inlined `read_file` blows up memory handling a large file). Measurement: compare `SkillLaunchEvent.success` before and after the change
- **Per-skill user cancellation rate (Ctrl+C) rises ≥ 2pp** → the skill output became slower or longer, causing users to lose patience. Measurement: the share of `ToolCallEvent.status === 'cancelled'`

---

## 6. Integration with D1/D3

### 6.1 Relationship with D1

After Layer 2 changes the top skills, **the remaining followup-heavy skills are the real applicable scenario for D1's `skipLlmRound`** — those skills already have complete output (no Round 2 needed) and are indeed terminal queries (the Round 3 summary is also wasteful).

Execution order:

1. Layer 1 telemetry goes live → 1 week of data
2. Layer 2 changes the top 2-3 skills → A/B for 2 weeks
3. Layer 3 prompt concurrency → 1 week of real-world testing
4. **At this point** re-evaluate D1: how many of the remaining high-frequency skills are in the "complete output + terminal query" form → whether a 2-3d framework change is worth it

### 6.2 Relationship with D3

D3 (`StreamingState.Summarizing`) is a perception-layer optimization, completely orthogonal to this plan. What Layer 1-3 reduces is the **real round count**, while what D3 reduces is the **user's perceived wait**. If Layer 2 has already brought RT down to a range users find acceptable, D3's value drops; conversely, D3 can be stacked on top.

---

## 7. Limitations and known risks

1. **Coverage is limited by the change scope** — changing 10 skills only covers the scenarios of those 10. But the gain is deterministic, measurable, and compounding
2. **Inlining followups into a skill may make a single skill heavier** — description bloat, slow loading, lower reusability. The Layer 2 checklist item 5 defends against this
3. **The Layer 3 model may not follow the concurrency guidance** — qwen-coder's training data is biased toward serial; the A/B data may show the prompt change is ineffective, treated as a known failure mode
4. **Telemetry privacy boundary** — `SkillFollowupRecord` should not record tool arguments (it already gets them from `ToolCallEvent.function_args` by default, but audit whether skill_name leaks user intent)
5. **Not applicable to sub-agent / cron / notification** — these paths do not go through the skill system, and this plan does not cover them
6. **Thin baseline data** — reusing the single sample from `rt-optimization-design.md` §1.2; before Layer 2 lands, a baseline for ≥3 scenario types needs to be added
7. **The `logSkillLaunch` field extension will break the existing telemetry consumer** — the 4 call sites + the downstream logger must all be changed in sync
8. **`logSkillLaunchEvent` at `qwen-logger.ts:908` is currently dead code** — there is no caller in the repository; §4.1.1b already lists the prerequisite fix

### 7.1 Boundary with existing framework mechanisms (out of scope of this plan)

The repository already has several framework mechanisms indirectly related to round reduction, which **this plan does not reinvent, nor replace**:

| Existing mechanism                                               | Location                             | Relationship with this plan                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `partitionToolCalls` + `runConcurrently` (concurrent execution)  | `coreToolScheduler.ts:775, 2473`     | Layer 3 reuses it directly; this plan does not touch it                                                                                                                             |
| `CONCURRENCY_SAFE_KINDS` (decides which tools can be concurrent) | `tools/tools.ts:818`                 | §3.3.1 already argued the current state is reasonable, not extended                                                                                                                 |
| `FileReadCache` (avoids re-reading the same file)                | `services/fileReadCache.ts`          | Indirectly affects the "model re-reads a file" round, already in effect; this plan neither depends on nor enhances it                                                               |
| `chatCompressionService` (history compression)                   | `services/chatCompressionService.ts` | Orthogonal to rounds (affects single-round cost rather than round count); the same component as the `wouldTriggerCompression` gate of `rt-optimization-design.md` §3.2 fast routing |

These are listed to avoid "this plan being understood as ignoring existing mechanisms".

---

## 8. Implementation timeline

> **Prerequisite: this timeline starts from P-1 and cannot be skipped**. P-1 is the pre-development review of the §0 Acceptance Spec, 0.5d of work but **mandatory** — if it does not pass, P0 is not entered. This constraint is meant to avoid the "write code first, fill in the spec later" anti-pattern: deferring the spec equals deferring the "success" judgment until after the results are out, which easily produces the bias of "adjusting the spec to make the metrics look good" (see the mistake of the `rt-optimization-design.md` §7 D2 route).

| Phase    | Content                                                                                       | Effort                                | Output                                  | Spec-locking action                                                |
| -------- | --------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| **P-1**  | spec pre-development review                                                                   | 0.5d                                  | §0.1 / §0.3 locked                      | **Lock the §0.1 engineering-layer spec + the §0.3 stop-loss line** |
| **P0**   | qwen-logger path fix (§4.1.1b prerequisite)                                                   | 0.5d                                  | skill_launch event visibility confirmed | Verify §0.1 item 1                                                 |
| **P1**   | Layer 1 telemetry: add the `prompt_id` field + offline SQL                                    | 1-2d                                  | skill ranking report                    | Verify §0.1 items 2/3/4                                            |
| **P1.5** | 1 week of data collection + baseline measurement (≥3 scenario types × ≥10 times)              | 1w                                    | decide which 2-3 skills to change       | **Lock the §0.2 thresholds + verify §0.1 item 5**                  |
| **P2**   | Layer 2 changes the top-1 skill (PR + A/B)                                                    | 0.5-1d change + 2w observation        | followup_rate ↓, RT P50 ↓ verified      | **Declare the §0.4 per-skill spec in the PR**                      |
| **P3**   | Layer 3 prompt concurrency guidance + `batch_size` telemetry (including §4.3.2 state passing) | 1-1.5d change + 1w real-world testing | batch_size distribution                 | Verify §0.2 item 3                                                 |
| **P4**   | Layer 2 continues changing the top-2 / top-3 skills (parallel with P3)                        | 0.5-1d × N                            | cumulative RT P50 ↓                     | Declare §0.4 in each PR                                            |
| **P5**   | Evaluate whether D1 still has value                                                           | decision meeting                      | roadmap update                          | —                                                                  |

**Key decision points (against the §0.3 stop-loss line)**:

- **End of P-1**: if any item of §0.1 / §0.3 cannot reach consensus → do not enter P0
- **End of P1.5**: triggers §0.3 outcome metric #1 (top-5 weighted followup_rate < 30%) → terminate the direction; otherwise lock the §0.2 thresholds
- **End of P2**: triggers §0.3 outcome metric #2 (RT P50 ↓ < 1s after the top-1 change) or any process metric → stop and review
- **End of P3**: triggers §0.3 outcome metric #3 (batch_size P50 still = 1) → abandon Layer 3
- **P5**: decide D1 ROI based on the form of the remaining skills

---

## 9. Key code locations

| File                                                     | Key symbol                                                                           | Location                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- |
| `packages/core/src/telemetry/types.ts`                   | `ToolCallEvent` (contains `prompt_id` / `duration_ms`)                               | L170                               |
| `packages/core/src/telemetry/types.ts`                   | `SkillLaunchEvent` (needs `prompt_id` added)                                         | L896                               |
| `packages/core/src/telemetry/loggers.ts`                 | `logToolCall`                                                                        | L220                               |
| `packages/core/src/telemetry/loggers.ts`                 | `logSkillLaunch` (goes through OTLP; missing qwen-logger forwarding)                 | L958                               |
| `packages/core/src/telemetry/loggers.ts`                 | `logToolCall` (dual path: OTLP + qwen-logger, as a fix template)                     | L220, L230                         |
| `packages/core/src/telemetry/qwen-logger/qwen-logger.ts` | `logSkillLaunchEvent` (**currently dead code**, the §4.1.1b prerequisite fix target) | L908                               |
| `packages/core/src/core/coreToolScheduler.ts`            | `partitionToolCalls`                                                                 | L775                               |
| `packages/core/src/core/coreToolScheduler.ts`            | `runConcurrently` / batch scheduling                                                 | L2456, L2473                       |
| `packages/core/src/core/coreToolScheduler.ts`            | `logToolCall` call site (the endpoint of the batch_size state passing)               | L3163                              |
| `packages/core/src/services/fileReadCache.ts`            | `FileReadCache` (existing, affects re-read rounds)                                   | L135                               |
| `packages/core/src/tools/skill.ts`                       | `SkillTool` + 4 `logSkillLaunch` call sites                                          | L386, L399, L426, L482             |
| `packages/core/src/skills/skill-manager.ts`              | `SkillManager` (skill registration/loading)                                          | whole file                         |
| `packages/core/src/skills/skill-load.ts`                 | skill description loading (the entry point for output contract changes)              | whole file                         |
| `packages/core/src/tools/tools.ts`                       | `Kind` + `CONCURRENCY_SAFE_KINDS`                                                    | L793, L818                         |
| `packages/core/src/core/coreToolScheduler.ts`            | `partitionToolCalls` + `runConcurrently` (existing concurrency infrastructure)       | see rt-optimization-design.md §5.7 |
| `packages/core/src/core/prompts.ts`                      | the `# Final Reminder` section (where Layer 3 adds concurrency guidance)             | L396                               |
| `.qwen/skills/`                                          | the directory of each skill definition (the Layer 2 change target)                   | directory                          |
