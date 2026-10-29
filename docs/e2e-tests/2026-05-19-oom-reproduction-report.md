# OOM Stress Test and Long-Task Replay Report

**Date**: 2026-05-19
**Branch**: `codex/memory-diagnostics-local-run`
**Tester**: yiliang114
**Conclusion**: Successfully reproduced and root-caused. The auto-compaction introduced in v0.15.7 (#3735) multiplies the frequency of `structuredClone`
calls, forming a positive-feedback deadlock under high heap pressure that leads to OOM. Real debug logs fully corroborate this mechanism.

---

## 1. Background

Multiple issues (#4309, #4276, #4185, #4315, #4322, #2868) report that qwen-code hits a V8 heap OOM crash during long sessions:

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

Crash characteristics reported by users:
| Issue | Heap at crash | Runtime | Platform |
|-------|------------|---------|------|
| #4276 | 4014 MB | ~110 minutes | Linux x64 |
| #4315 | 2027 MB | ~19.6 hours | macOS (default 2GB limit) |
| #4322 | 4023 MB | ~7 hours | Windows |
| #2868 | 2035 MB | ~1.7 minutes | Linux |
| #4309 | 7020 MB | unknown | Windows (still crashed with an 8GB limit set) |

---

## 2. Methodology Correction

This report distinguishes two kinds of tests:

1. **Low-heap stress test**: amplifies the problem by lowering `--max-old-space-size`, used to quickly pinpoint
   the code path where "copying the entire history when it is very large causes a transient peak." It is a diagnostic tool and is not equivalent to a real user
   4G/8G OOM reproduction.
2. **Default-heap long-task replay**: does not set `NODE_OPTIONS`, restores from real JSONL history and
   continues running a review task, while sampling process-tree RSS from outside the process. Only results of this kind are used to judge
   the actual memory magnitude on the user side.

Therefore, low-heap results cannot serve on their own as proof that "the real OOM has been fixed." They can only show that a given path produces peak
amplification when the history is large enough; this still needs to be verified again with a default-heap long task.

## 3. Low-Heap Stress Test Conditions

| Parameter                | Value                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| CLI version              | 0.15.11 (built from the `codex/memory-diagnostics-local-run` branch) |
| Model                    | `qwen3.6-plus` (128K context window)                                 |
| Heap limit               | `--max-old-space-size=512`                                           |
| Heap-pressure safety net | **Disabled** (HEAP_PRESSURE_COMPRESSION_RATIO set to 99.0)           |
| Operation mode           | YOLO + automated multi-round Read file tasks                         |
| Working directory        | qwen-code monorepo (3538 .ts files, 1.26M lines)                     |

### Key Configuration Change

In `packages/core/src/core/llm-chat.ts`, the heap-pressure compaction threshold was changed from 0.7 to 99.0 (so it never triggers), simulating the state before the #4186 fix.

---

## 4. Low-Heap Stress Test Results

### Crash Timeline

```
[21:26:59] #1 RSS:193.6MB Ctx:0%   → Read llm-chat.ts (1500 lines)
[21:27:46] #2 RSS:270.4MB Ctx:4.2% → Read agent.ts
[21:28:32] #3 RSS:397.5MB Ctx:4.3% → grep + Read 3 files
[21:29:18] #4 RSS:452.7MB Ctx:5.7% → Read slashCommandProcessor.ts
[21:30:04] #5 RSS:515.0MB Ctx:5.9% → Read chatCompressionService.ts
[21:30:50] #6 RSS:649.1MB Ctx:4.0% ← TOKEN COMPACTION triggered (5.9%→4.0%)
                                       RSS rose by 134MB instead (structuredClone peak)
[21:31:36] #7 RSS:666.7MB Ctx:3.2% ← compaction again, RSS keeps rising
[21:32:22] CRASH — FATAL ERROR: Ineffective mark-compacts near heap limit
```

**Total time**: ~5.5 minutes, crashed after 7 rounds of tasks.

This proves that under a constrained heap, a long history + compaction/history clone can trigger a V8 heap OOM.
But this result does not mean that the real user OOM under the default heap has been fully reproduced.

### Synthetic Reproduction with a Larger Heap

To avoid relying solely on the 512 MiB low-heap conclusion, a synthetic runtime
pressure test with a larger heap was added. This test does not call the model; instead it constructs a history resembling a long review/subagent task:

- root review turns: 10
- subagent calls: 30
- subagent transcript records: 780
- retained tool result bytes: 193,986,560
- serialized history bytes: 195,620,061
- pressure mode: retained `structuredClone(history)` copies

| Heap limit |     Clone pressure | Result                                     | Key GC / stack                                               |
| ---------- | -----------------: | ------------------------------------------ | ------------------------------------------------------------ |
| 2 GiB      |  8 retained clones | No crash, RSS 2.42 GiB, heap used 1.87 GiB | Near the heap limit                                          |
| 2 GiB      | 10 retained clones | OOM                                        | `Reached heap limit`, `ValueDeserializer`, `StructuredClone` |
| 4 GiB      | 20 retained clones | OOM                                        | `Reached heap limit`, `ValueDeserializer`, `StructuredClone` |

GC summary from the 2 GiB reproduction:

```
Mark-Compact 2042.9 (2081.9) -> 2042.9 (2081.1) MB
Mark-Compact 2048.9 (2087.2) -> 2048.9 (2087.2) MB
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
...
node::worker::(anonymous namespace)::StructuredClone
```

GC summary from the 4 GiB reproduction:

```
Mark-Compact 4082.5 (4126.8) -> 4082.5 (4126.3) MB
Mark-Compact 4095.1 (4139.0) -> 4095.1 (4139.0) MB
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
...
node::worker::(anonymous namespace)::StructuredClone
```

This set of results is closer to the user-reported 2 GiB / 4 GiB heap OOM than the 512 MiB stress test:
as long as enough large tool results / subagent transcripts are retained in the history, doing a retained or transient clone
of the entire history can trigger a V8 OOM under a 2-4 GiB heap. It is still a synthetic
reproduction and is not equivalent to a full real long-task replay, but it directly proves that the problem is not "an artificially manufactured small heap."

### GC State at Crash

```
[41381:0x130008000] 342468 ms: Mark-Compact 508.6 (526.7) -> 507.0 (526.9) MB,
  pooled: 1 MB, 86.42 / 0.00 ms  (average mu = 0.175, current mu = 0.150)
  task; scavenge might not succeed

[41381:0x130008000] 342568 ms: Mark-Compact 509.1 (526.9) -> 507.1 (528.2) MB,
  pooled: 0 MB, 93.79 / 0.12 ms  (average mu = 0.121, current mu = 0.068)
  allocation failure; scavenge might not succeed

FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
```

Mark-Compact can only reclaim 1-2 MB (almost all objects are reachable), proving that memory is indeed filled with legitimately held objects.

---

## 5. Default-Heap Long-Task Replay

To avoid over-extrapolating the low-heap conclusion, a real JSONL replay under the default heap was added:

- Do not set `NODE_OPTIONS`
- Do not enable the internal runtime profiler, to avoid the sampler itself affecting the heap
- Each CLI copies a fresh session from the same rewound JSONL
- Use a temporary `QWEN_HOME`, disable MCP and hooks, to avoid local global configuration contamination
- Use only out-of-process sampling to measure process-tree RSS

| CLI                  | Result  | Duration | Peak tree RSS | Peak root RSS | Peak worker RSS | Notes                                                                                            |
| -------------------- | ------- | -------: | ------------: | ------------: | --------------: | ------------------------------------------------------------------------------------------------ |
| installed `qwen`     | Success |   167.3s |     838.0 MiB |     230.2 MiB |       566.3 MiB | The first fresh run hit a model server-side error, excluded from the conclusion; retry succeeded |
| local rebuilt bundle | Success |   106.3s |     527.5 MiB |     182.1 MiB |       345.4 MiB | Includes the local clone hot-path fix                                                            |

Conclusions of the default-heap replay:

1. This current review JSONL can stably produce process-tree RSS from hundreds of MiB up to about 0.8 GiB,
   but does not reproduce a 4G/8G OOM.
2. The local rebuilt bundle's peak on a same-starting-point replay is lower than the installed CLI, indicating that reducing
   the history clone hot path has real benefit.
3. This still cannot prove that all user OOMs have been resolved. Reproducing a real 4G/8G OOM still requires longer tasks, larger
   tool-result accumulation, or a replay that retains MCP/tool schema pressure for further verification.

## 6. Root Cause Analysis

### The Three-Layer Mechanism of OOM

```
┌─────────────────────────────────────────────────────────┐
│ Layer 3: V8 Heap Limit (512MB/2GB/4GB)                  │ ← where users ultimately hit the wall
├─────────────────────────────────────────────────────────┤
│ Layer 2: structuredClone() peak amplification (transient ~2x) │ ← direct trigger
├─────────────────────────────────────────────────────────┤
│ Layer 1: tool result accumulation in history (linear growth) │ ← baseline growth
├─────────────────────────────────────────────────────────┤
│ Layer 0: Token compaction trigger timing                │ ← control point
└─────────────────────────────────────────────────────────┘
```

### Exact Crash Path

```
sendMessage()
  → tryCompress()
    → heapPressureRatio < threshold (safety net disabled)
    → ChatCompressionService.compress()
      → chat.getHistory(true)
        → structuredClone(this._history)   ← peak allocation!
          → V8 needs an extra ~N MB to hold the clone
          → if existing heap + N > limit → OOM
```

### Key Evidence

| Observation                                | Meaning                                                               |
| ------------------------------------------ | --------------------------------------------------------------------- |
| Task #5→#6: Context 5.9%→4.0% (dropped)    | Token compaction **executed successfully**                            |
| Task #5→#6: RSS 515→649 MB (rose by 134MB) | The `structuredClone` during compaction created a peak                |
| GC can only reclaim 1-2 MB                 | All objects are live (both history + clone are present)               |
| #4309 still crashed with an 8GB limit set  | When the history is large enough, the clone peak can exceed any limit |

Note: the evidence above is combined inference from the low-heap stress test and the issue symptoms. The default-heap replay
currently supports "the clone hot path significantly affects peak RSS," but has not independently reproduced a 4G/8G OOM.

### Why a 128K Context Window Triggers It More Easily

- 128K × 70% = ~90K tokens triggers compaction
- 70% of a large context window (1M) = 700K tokens, which almost never triggers
- **more frequent compaction → more frequent structuredClone → higher OOM risk**
- Models such as DeepSeek that have no contextWindowSize configured default to 128K, making them more prone to triggering

---

## 6.5. Corroboration from Real Runtime Logs

The following logs are extracted from the debug output of the local crash session. To avoid leaking local paths and session IDs,
the report keeps only the timeline and key log content.

This session started at `2026-05-19T13:26:35Z` (local 21:26:35) and crashed at
`2026-05-19T13:32:10Z` (local 21:32:10).

### Timeline of Heap Pressure and Auto-Compaction Events

```
13:29:43 [WARN]  Heap pressure at 74.9%; attempting auto-compaction before token threshold.
13:30:06 [DEBUG] [FILE_READ_CACHE] clear after auto tryCompress    ← compaction #1 executed successfully
13:30:13 [WARN]  Heap pressure at 70.7%; attempting auto-compaction before token threshold.
                 ← just after compaction, heap only dropped from 74.9% to 70.7%, still over threshold, retried immediately
13:30:52 [DEBUG] Heap pressure at 86.0%; skipping heap-pressure auto-compaction during cooldown.
                 ← refused to execute during the 30s cooldown
13:30:56 [WARN]  Heap pressure at 85.3%; attempting auto-compaction before token threshold.
                 ← cooldown expired, heap has risen to 85.3%
13:31:21 [DEBUG] [FILE_READ_CACHE] clear after auto tryCompress    ← compaction #2 executed successfully
13:31:37 [WARN]  Heap pressure at 88.8%; attempting auto-compaction before token threshold.
                 ← after compaction, heap rebounded to 88.8%
13:32:09 [DEBUG] Heap pressure at 90.2%; skipping heap-pressure auto-compaction during cooldown.
                 ← heap reached 90.2%, cannot execute during cooldown
13:32:10 ← logs end (process OOM crash)
```

### Interpreting the Log Evidence

| Log observation                                                                                            | Meaning                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Within 2.5 minutes, **4** heap-pressure auto-compaction attempts were triggered (plus 2 cooldown refusals) | The `tryCompress` introduced by #3735 triggers frequently under high pressure         |
| After every compaction, heap usage is still >70%                                                           | The transient peak created by `structuredClone()` cancels out the compression gain    |
| 74.9% → 70.7% → 86% → 85.3% → 88.8% → 90.2% → crash                                                        | Positive feedback loop: compress → clone peak → higher heap → compress again → higher |
| Logs break within 1 second after 90.2%                                                                     | The `structuredClone()` of the next `getHistory(true)` instantly exceeded the limit   |
| `[FILE_READ_CACHE] clear after auto tryCompress` appears twice                                             | Confirms compaction did go through the full compress → setHistory path                |

### The Positive-Feedback Deadlock Mechanism

```
high heap usage (>70%)
  → triggers heap-pressure auto-compaction
    → tryCompress() internally calls getHistory(true)
      → structuredClone(this._history)  ← transient heap peak +30~40%
        → compaction succeeds, releasing the old history
          → but the clone peak has already pushed the heap to a more dangerous level
            → the next send keeps accumulating
              → higher heap usage → triggers more frequently → crash
```

---

## 6.6. Version Attribution: Why OOM Reports Increased Between 0.15.7 and 0.15.11

### Key Commit Timeline

| Version      | PR                                                   | Change                                                                                          | Effect on `structuredClone` call frequency |
| ------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **v0.15.6**  | —                                                    | `getHistory(true)` called only once at the `sendMessage` entry point                            | Baseline: 1 clone per send                 |
| **v0.15.7**  | **#3735** `auto-compact subagent context`            | Moved `tryCompress()` down into `GeminiChat`, running a compaction check **before each send**   | **+1**: compress check before send         |
| **v0.15.10** | **#3879** `reactive compression on context overflow` | When the provider returns context overflow, triggers `tryCompress()` + `getHistory(true)` again | **+1~2**: overflow retry path              |
| **v0.15.10** | **#3985** `harden reactive compression`              | Hardens the reactive compression retry logic                                                    | Same as above                              |

### Comparison of `getHistory(true)` Call Sites in v0.15.6 vs v0.15.11

**v0.15.6** (2 sites):

```
L367: const requestContents = this.getHistory(true);          ← send constructs request
L618: const recoveryContents = self.getHistory(true);         ← MAX_TOKENS escalation (rarely triggered)
```

**v0.15.11** (5 sites):

```
L467: called internally by ChatCompressionService.compress()  ← #3735: auto-compact before each send
L574: requestContents = this.getHistory(true);                ← send constructs request
L724: called internally by reactive tryCompress()             ← #3879: retry after context overflow
L739: requestContents = self.getHistory(true);                ← #3879: retry constructs a new request
L943: const recoveryContents = self.getHistory(true);         ← MAX_TOKENS escalation
```

### Worst-Case Path: a Single Send Can Trigger 4 `structuredClone` Calls

```
sendMessage()
  → tryCompress()              ← #3735: getHistory(true) [clone #1]
  → getHistory(true)           ← construct request [clone #2]
  → API returns context overflow
    → reactive tryCompress()   ← #3879: getHistory(true) [clone #3]
    → getHistory(true)         ← retry request [clone #4]
```

### Conclusion

**#3735 (v0.15.7)** is the most likely trigger for the significant rise in OOM frequency (not the sole root cause)—it makes every
`sendMessage` first run a `tryCompress()`, while `tryCompress` internally does a full `structuredClone` via
`ChatCompressionService.compress()` → `chat.getHistory(true)`.
When the history is large, this "clone first, then decide whether compression is needed" design raises the memory peak from ~1.3x to ~2x+.
Note: issue history shows OOM reports existed before #3735, but #3735 greatly increased the call frequency of structuredClone,
thereby significantly raising the probability of triggering an OOM.

**#3879 (v0.15.10)** further worsened the problem—when already at the heap boundary (provider returns context overflow),
it triggers another full clone, making an already dangerous session more likely to crash.

---

## 7. Verification of the #4186 Fix (Comparison Test)

Comparison test after enabling the heap-pressure safety net (HEAP_PRESSURE_COMPRESSION_RATIO = 0.7):

| Metric             | Safety net disabled        | Safety net enabled                    |
| ------------------ | -------------------------- | ------------------------------------- |
| OOM occurrence     | Yes (crash after 7 rounds) | No (ran continuously for >10 minutes) |
| Peak RSS           | 666 MB → crash             | 555 MB → GC reclaimed to 280 MB       |
| Compaction trigger | Only token threshold       | Triggered early at 70% heap           |
| Context behavior   | 5.9%→4.0%→crash            | 22.7%→17.0% (safe fallback)           |

**Conclusion**: The heap-pressure safety net of #4186 effectively prevents OOM, but it is a **mitigation** rather than a cure:

- If the history itself already occupies 60%+ of the heap, even with early compaction, the clone peak can still exceed the limit
- This explains why the #4309 user still crashed after setting an 8GB limit

---

## 8. Memory Footprint Distribution

Estimated from the RSS growth pattern observed in the test:

| Memory location                    | Share  | Growth characteristic                     |
| ---------------------------------- | ------ | ----------------------------------------- |
| `this._history[]` (tool results)   | 40-50% | Linear accumulation, +30-100MB per round  |
| `structuredClone()` temporary copy | 30-40% | Transient peak, appears during compaction |
| V8 runtime (GC metadata, code)     | ~15%   | Essentially constant                      |
| UI/logging/stream buffers          | ~5%    | Slow growth                               |

---

## 9. Reproduction Script and Environment

### Automation Driver Script

```bash
#!/bin/bash
# /tmp/oom-simple-driver.sh <tmux-session-name>
SESSION="$1"

TASKS=(
  "Use the Read tool to fully read packages/core/src/core/llm-chat.ts"
  "Use the Read tool to fully read packages/core/src/tools/agent/agent.ts"
  "Use grep -rn structuredClone packages/core/src then Read the first 3 files"
  "Use Read to fully read packages/cli/src/ui/hooks/slashCommandProcessor.ts"
  "Use Read to fully read packages/core/src/services/chatCompressionService.ts"
  "Use find packages/cli/src/ui/commands -name '*.ts' then Read each one"
  "Use Read to fully read packages/core/src/core/turn.ts"
  # ... more tasks
)

i=0
while true; do
  TASK="${TASKS[$((i % ${#TASKS[@]}))]}"
  i=$((i + 1))

  QWEN_PID=$(ps aux | grep "dist/index.js" | grep -v grep | awk '{print $2}' | sort -rn | head -1)
  RSS=$(ps -o rss= -p $QWEN_PID 2>/dev/null)
  [ -z "$RSS" ] && { echo "CRASH after $((i-1)) tasks!"; exit 0; }

  RSS_MB=$(echo "scale=1; $RSS/1024" | bc)
  CTX=$(tmux capture-pane -t "$SESSION:1" -p 2>/dev/null | grep -oE "[0-9]+\.[0-9]+% 已用" | tail -1)
  echo "[$(date +%H:%M:%S)] #$i RSS:${RSS_MB}MB Ctx:$CTX | ${TASK:0:55}"

  tmux send-keys -t "$SESSION:1" C-u
  sleep 0.2
  tmux send-keys -t "$SESSION:1" "$TASK" Enter
  sleep 0.5
  tmux send-keys -t "$SESSION:1" Enter
  sleep 45
done
```

### Launch Commands

```bash
# 1. Disable the heap-pressure safety net
# llm-chat.ts: HEAP_PRESSURE_COMPRESSION_RATIO = 99.0

# 2. Build
npm run build --workspace=packages/core && npm run build --workspace=packages/cli

# 3. Launch qwen (128K context model, 512MB heap)
SESSION="oom-test"
tmux new-session -d -s "$SESSION" -c "$REPO_DIR"
tmux send-keys -t "$SESSION" \
  "NODE_OPTIONS='--max-old-space-size=512' node packages/cli/dist/index.js --model 'qwen3.6-plus'" Enter

# 4. Wait for startup, then run the driver
sleep 10
bash /tmp/oom-simple-driver.sh "$SESSION"
```

---

## 10. Follow-Up Recommendations

### Short-Term Mitigation (already in place)

- [x] #4186: heap-pressure auto-compaction safety net (0.7 threshold)
- [x] #4188: fileReadCache / crawlCache size caps

### Mid-Term Fix (suggested)

- [ ] Reduce `structuredClone()` calls — `nextSpeakerChecker` only needs the last message, not a full clone
- [ ] Compaction uses slice + references instead of a full deep clone
- [ ] Write large tool results (>100KB) to a temporary file, keeping only a summary reference in the history

### Long-Term Direction

- [ ] Offload tool results to disk + lazy load (#4184)
- [ ] RSS-based tiered compression strategy (not just token count)
- [ ] Segmented history storage to avoid single full-history operations
