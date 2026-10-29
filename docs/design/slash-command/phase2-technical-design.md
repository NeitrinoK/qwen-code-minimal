# Phase 2 Technical Design Document: Capability Expansion

## 1. Design Goals and Constraints

### 1.1 Goals

- Expand the `supportedModes` of the 13 built-in commands to include `non_interactive` and/or `acp`
- Ensure each expanded command returns text content suitable for IDE consumption on the ACP/non-interactive path
- Wire up the model invocation pathway for prompt commands (`SkillTool` consumes `getModelInvocableCommands()`)
- Implement basic mid-input slash command detection

### 1.2 Hard Constraints

- **Zero regression on the interactive path**: the existing interactive behavior of all expanded commands stays strictly unchanged; only add mode branches inside the action, without touching interactive path code
- **Implementation strategy: mode branching, not dual registration**: all 13 commands add an `executionMode` check inside the `action`, rather than using the dual-registration pattern described in §10.2 of the Phase 1 design document (dual registration is only necessary when the interactive and non-interactive logic differ drastically, and the command complexity in this phase does not reach that threshold)
- **ACP message format**: the text content returned on the ACP path must not contain ANSI styling; Markdown or plain text is preferred, targeting consumption by IDE plugins
- **Skip environment-dependent side effects**: operations that depend on a graphical environment, such as opening the browser (`open()`) or operating the clipboard (`copyToClipboard()`), must be skipped on the non-interactive/ACP path

---

## 2. Baseline State After Phase 1 Completion

Key architectural points after Phase 1 (Phase 2 builds directly on top of these):

- The `commandType` field has been removed from the `SlashCommand` interface; all commands now use an explicit `supportedModes`
- `getEffectiveSupportedModes()` performs two-level inference: explicit `supportedModes` → `CommandKind` fallback
- `CommandService.getCommandsForMode(mode)` replaces the original `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE` allowlist
- `btw`, `bug`, `compress`, `context`, `init`, `summary` were already expanded to all modes in Phase 1 and are **not in this phase's list**
- Every method in `createNonInteractiveUI()` is a no-op: `addItem`, `clear`, `setDebugMessage`, `setPendingItem`, `reloadCommands` all silently ignore the call

---

## 3. Scope Overview

This phase involves 13 commands in total, divided into four categories by implementation complexity:

| Category             | Commands                                     | Key Changes                                                                                                                                    |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Category A**       | `export`                                     | Only change `supportedModes`; all action paths already return a valid type                                                                     |
| **Interactive only** | `plan`, `statusline`                         | Design decision: these two commands are semantically tightly coupled to the interactive UI; keep `supportedModes: ['interactive']`             |
| **Category A+**      | `language`                                   | Change `supportedModes` + a small amount of non-interactive branch handling                                                                    |
| **Interactive only** | `copy`, `restore`                            | Design decision: clipboard and snapshot restore are inherently interactive operations; keep `supportedModes: ['interactive']`                  |
| **Category A'**      | `model`, `approval-mode`                     | The path with arguments already returns `message`; the path without arguments needs a new non-interactive branch (currently triggers a dialog) |
| **Category B**       | `about`, `stats`, `insight`, `docs`, `clear` | All action paths return no value or call `addItem`/`clear`; need a complete new non-interactive branch                                         |

---

## 4. Category A: Only Change `supportedModes`

All `action` paths of these three commands already return `message` or `submit_prompt`, have no UI dependency whatsoever, and can be handled directly by `handleCommandResult`.

### 4.1 `/export` (and subcommands)

**Current state**: `supportedModes: ['interactive']`; the action of all subcommands returns `MessageActionReturn`.

**Change**: change the `supportedModes` of the parent command and all four subcommands (`md`, `html`, `json`, `jsonl`) to `['interactive', 'non_interactive', 'acp']`.

**ACP message content**: the action's existing return content already includes the full file path (e.g., `Session exported to markdown: qwen-export-2024-01-01T12-00-00.md`), which is friendly for IDE consumption; no text changes needed.

> **Note**: the `/export` parent command itself has no `action`, only subcommands. After changing the parent command's `supportedModes` to all modes, `parseSlashCommand` can match subcommand routing, but if the user enters only `/export` without a subcommand, `commandToExecute.action` is undefined, `handleSlashCommand` returns `no_command`, and the caller displays an available-subcommands hint. This is expected behavior.

### 4.2 `/plan`

**Current state**: `supportedModes: ['interactive']`; all action paths return `MessageActionReturn` or `SubmitPromptActionReturn`.

**Design decision**: `/plan` is a command that guides the user through multi-turn interactive planning, and is semantically tightly coupled to the interactive UI. After discussion, the decision is to keep `supportedModes: ['interactive']` and not expand it to non-interactive/acp modes.

### 4.3 `/statusline`

**Current state**: `supportedModes: ['interactive']`; the action always returns `SubmitPromptActionReturn` (submits the subagent invocation prompt to the model).

**Design decision**: `/statusline` is a command that triggers a subagent to summarize the current state, and is semantically tightly coupled to the interactive UI. After discussion, the decision is to keep `supportedModes: ['interactive']` and not expand it to non-interactive/acp modes.

---

## 5. Category A+: A Small Amount of Non-interactive Branch Handling

### 5.1 `/language`

**Current state**: all action paths return `MessageActionReturn` (read/set the language setting).

**Side effect to handle**: `setUiLanguage()` internally calls `context.ui.reloadCommands()`, which is already a no-op in the non-interactive UI; no additional handling needed.

**Change**:

- Change the `supportedModes` of the parent command and subcommands (`ui`, `output`, plus the subcommands dynamically generated from `SUPPORTED_LANGUAGES`) to `['interactive', 'non_interactive', 'acp']`.
- The action needs no mode branch; the existing return text is already suitable for machine consumption.

**ACP semantics note**: executing `/language ui zh-CN` in non-interactive (single invocation) modifies the persisted setting (writes to the settings file); that change takes effect for subsequent sessions, and i18n also takes effect immediately within this session. This matches user expectations.

### 5.2 `/copy`

**Current state**: the action calls `copyToClipboard()`, which may throw an exception or fail silently (clipboard unavailable) in an ACP/headless environment.

**Change**:

1. Change `supportedModes` to `['interactive', 'non_interactive', 'acp']`.
2. Add a mode branch inside the action:

```typescript
// Get the last AI message (existing logic, reusable)
if (context.executionMode !== 'interactive') {
  // Non-interactive/ACP: skip the clipboard, return the content itself
  if (!lastAiOutput) {
    return {
      type: 'message',
      messageType: 'info',
      content: 'No output in history.',
    };
  }
  return {
    type: 'message',
    messageType: 'info',
    content: lastAiOutput,
  };
}
// Interactive path: original clipboard logic unchanged
await copyToClipboard(lastAiOutput);
return {
  type: 'message',
  messageType: 'info',
  content: 'Last output copied to the clipboard',
};
```

**ACP semantics**: the IDE receives the raw text of the last model output and can decide on its own whether to write it to the clipboard or display it to the user.

### 5.3 `/restore`

**Current state**: `supportedModes: ['interactive']`.

**Design decision**: snapshot restore further re-executes tool calls and is semantically tightly coupled to the interactive UI. After discussion, the decision is to keep `supportedModes: ['interactive']` and not expand it to non-interactive/acp modes.

**ACP semantics**: the checkpoint's git state restore and gemini client history setup are both executed as side effects; after receiving the confirmation message, the IDE can prompt the user that "the state has been restored", and the tool re-execution is left to the IDE to decide whether to trigger.

---

## 6. Category A': Non-interactive Handling for No-argument Dialog Paths

### 6.1 `/model`

**Current state**:

| Input                           | Current behavior                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `/model` (no arguments)         | → `{ type: 'dialog', dialog: 'model' }` (becomes unsupported under non-interactive)      |
| `/model <model-id>`             | Not implemented (only the `--fast` branch exists)                                        |
| `/model --fast` (no model name) | → `{ type: 'dialog', dialog: 'fast-model' }` (becomes unsupported under non-interactive) |
| `/model --fast <model-id>`      | → `MessageActionReturn` ✅                                                               |

**Change**:

1. Change `supportedModes` to `['interactive', 'non_interactive', 'acp']`.
2. Insert a non-interactive branch before each dialog path inside the action:

```typescript
// No-argument path (originally returned dialog: 'model')
if (!args.trim()) {
  if (context.executionMode !== 'interactive') {
    const currentModel = config.getModel() ?? 'unknown';
    return {
      type: 'message',
      messageType: 'info',
      content: `Current model: ${currentModel}\nUse "/model <model-id>" to switch models.`,
    };
  }
  return { type: 'dialog', dialog: 'model' };
}

// --fast no-argument path (originally returned dialog: 'fast-model')
if (args.startsWith('--fast') && !modelName) {
  if (context.executionMode !== 'interactive') {
    const fastModel = context.services.settings?.merged?.fastModel ?? 'not set';
    return {
      type: 'message',
      messageType: 'info',
      content: `Current fast model: ${fastModel}\nUse "/model --fast <model-id>" to set fast model.`,
    };
  }
  return { type: 'dialog', dialog: 'fast-model' };
}
```

**ACP semantics**: the IDE displays the current model name for the user's reference; switching models is done via an invocation with arguments (`/model <model-id>`).

> **Note**: `/model <model-id>` (without `--fast`) currently has no logic implemented to set the current session model; only `--fast <model-id>` does. If Phase 2 is to support switching the main model under ACP, the set logic for `/model <model-id>` needs to be implemented as well. This design reserves the path but marks it as a Phase 2 optional item, prioritizing the read-only "view the current model" path.

### 6.2 `/approval-mode`

**Current state**:

| Input                           | Current behavior                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `/approval-mode` (no arguments) | → `{ type: 'dialog', dialog: 'approval-mode' }` (becomes unsupported under non-interactive) |
| `/approval-mode <mode>`         | → `MessageActionReturn` ✅                                                                  |
| `/approval-mode <invalid>`      | → `MessageActionReturn` (error) ✅                                                          |

**Change**:

1. Change `supportedModes` to `['interactive', 'non_interactive', 'acp']`.
2. Insert a non-interactive branch on the no-argument path (`!args.trim()`):

```typescript
if (!args.trim()) {
  if (context.executionMode !== 'interactive') {
    const currentMode = config?.getApprovalMode() ?? 'unknown';
    return {
      type: 'message',
      messageType: 'info',
      content: `Current approval mode: ${currentMode}\nAvailable modes: ${APPROVAL_MODES.join(', ')}\nUse "/approval-mode <mode>" to change.`,
    };
  }
  return { type: 'dialog', dialog: 'approval-mode' };
}
```

---

## 7. Category B: A Complete Non-interactive Branch Is Required

In interactive mode, the action of these five commands renders React components via `context.ui.addItem()` or calls `context.ui.clear()`, with a return value of `void`. In non-interactive mode, these calls are all no-ops, causing `handleSlashCommand` to treat the no-return-value case as `"Command executed successfully."` with no actual content output.

**Implementation principle**: check `executionMode` at the **top** of the action, and when not interactive, **return early** with a `message` containing the actual content, without touching the interactive path code at all.

### 7.1 `/about` (altName: `status`)

**Data source**: `getExtendedSystemInfo(context)` returns `ExtendedSystemInfo`, which includes: `cliVersion`, `osPlatform`, `osArch`, `osRelease`, `nodeVersion`, `modelVersion`, `selectedAuthType`, `ideClient`, `sessionId`, `memoryUsage`, `baseUrl`, `apiKeyEnvKey`, `gitCommit`, `fastModel`. All fields are available in non-interactive mode (context.services.config and settings are both already injected).

**Change**:

1. Change `supportedModes` to `['interactive', 'non_interactive', 'acp']`.
2. Insert a mode branch after the `getExtendedSystemInfo` call and before the interactive path:

```typescript
action: async (context) => {
  const systemInfo = await getExtendedSystemInfo(context);

  if (context.executionMode !== 'interactive') {
    const lines = [
      `Qwen Code v${systemInfo.cliVersion}`,
      `Model: ${systemInfo.modelVersion}`,
      `Fast Model: ${systemInfo.fastModel ?? 'not set'}`,
      `Auth: ${systemInfo.selectedAuthType}`,
      `Platform: ${systemInfo.osPlatform} ${systemInfo.osArch} (${systemInfo.osRelease})`,
      `Node.js: ${systemInfo.nodeVersion}`,
      `Session: ${systemInfo.sessionId}`,
      ...(systemInfo.gitCommit ? [`Git commit: ${systemInfo.gitCommit}`] : []),
      ...(systemInfo.ideClient ? [`IDE: ${systemInfo.ideClient}`] : []),
    ];
    return {
      type: 'message',
      messageType: 'info',
      content: lines.join('\n'),
    };
  }

  // Interactive path: original addItem logic unchanged
  const aboutItem: Omit<HistoryItemAbout, 'id'> = { type: MessageType.ABOUT, systemInfo };
  context.ui.addItem(aboutItem, Date.now());
},
```

### 7.2 `/stats` (and subcommands `model`, `tools`)

**Data source**: `context.session.stats` (`SessionStatsState`) includes `sessionStartTime`, `metrics` (`SessionMetrics`: `models`, `tools`, `files`), and `promptCount`. In non-interactive mode, `sessionStartTime` is the current invocation moment, `metrics` comes from `uiTelemetryService.getMetrics()` (the cumulative value for this invocation, usually zero), and `promptCount` is 1.

**Change**:

1. Change the `supportedModes` of the parent command `stats` and the subcommands `model`, `tools` to `['interactive', 'non_interactive', 'acp']`.
2. Insert a mode branch into the action of the parent command and each subcommand, returning text-formatted statistics early:

```typescript
// /stats main command
action: (context) => {
  if (context.executionMode !== 'interactive') {
    const now = new Date();
    const { sessionStartTime, promptCount, metrics } = context.session.stats;
    if (!sessionStartTime) {
      return { type: 'message', messageType: 'error', content: 'Session start time unavailable.' };
    }
    const wallDuration = now.getTime() - sessionStartTime.getTime();

    // Aggregate the token counts across all models
    let totalPromptTokens = 0, totalCandidateTokens = 0, totalRequests = 0;
    for (const modelMetrics of Object.values(metrics.models)) {
      totalPromptTokens += modelMetrics.tokens.prompt;
      totalCandidateTokens += modelMetrics.tokens.candidates;
      totalRequests += modelMetrics.api.totalRequests;
    }

    const lines = [
      `Session duration: ${formatDuration(wallDuration)}`,
      `Prompts: ${promptCount}`,
      `API requests: ${totalRequests}`,
      `Tokens — prompt: ${totalPromptTokens}, output: ${totalCandidateTokens}`,
      `Tool calls: ${metrics.tools.totalCalls} (${metrics.tools.totalSuccess} ok, ${metrics.tools.totalFail} fail)`,
      `Files: +${metrics.files.totalLinesAdded} / -${metrics.files.totalLinesRemoved} lines`,
    ];
    return { type: 'message', messageType: 'info', content: lines.join('\n') };
  }

  // Interactive path: original addItem logic unchanged
  const statsItem: HistoryItemStats = { type: MessageType.STATS, duration: formatDuration(wallDuration) };
  context.ui.addItem(statsItem, Date.now());
},
```

The subcommands `model` and `tools` each insert a mode branch as well, returning the text statistics for their respective dimension (the model dimension lists token usage by model name; the tools dimension lists the call count of each tool).

**Note**: in a single non-interactive invocation, metrics are usually zero (new session), but the structure is complete and does not affect the format. In an ACP session there may be cumulative values, which are meaningful.

### 7.3 `/insight`

**Current state**: the action returns `void`, displays progress and results via `addItem`, and finally calls `open(outputPath)` to open the browser. The core logic is `insightGenerator.generateStaticInsight()` generating an HTML file.

**Change**:

1. Change `supportedModes` to `['interactive', 'non_interactive', 'acp']`.
2. Branch three ways by `executionMode`:
   - `non_interactive`: generate synchronously, ignore the progress callback, do not open the browser, and directly return a `message` (the file path)
   - `acp`: start generation asynchronously, and push progress (`encodeInsightProgressMessage`) and completion (`encodeInsightReadyMessage`) to the IDE via `stream_messages`
   - `interactive`: original `addItem` + `setPendingItem` + `open()` logic unchanged

```typescript
// non_interactive path
if (context.executionMode === 'non_interactive') {
  const outputPath = await insightGenerator.generateStaticInsight(
    projectsDir,
    () => {}, // no-op progress
  );
  return {
    type: 'message',
    messageType: 'info',
    content: t('Insight report generated at: {{path}}', { path: outputPath }),
  };
}

// acp path: stream_messages
if (context.executionMode === 'acp') {
  // ... construct the streamMessages async generator, yield encodeInsightProgressMessage / encodeInsightReadyMessage ...
  return { type: 'stream_messages', messages: streamMessages() };
}

// interactive path: original implementation unchanged
```

**Design rationale**: `non_interactive` mode (CLI pipe) does not support `stream_messages` and can only return a single `message`; ACP mode (IDE plugin) can consume `stream_messages` and display progress in real time, so the streaming path is retained for it.

**ACP message format**: `encodeInsightProgressMessage(stage, progress, detail?)` produces a progress-bar message that the IDE can parse; `encodeInsightReadyMessage(outputPath)` notifies the IDE that the file is ready, and the IDE decides how to display the link.

### 7.4 `/docs`

**Current state**: the action returns `void`, displays a message via `addItem`, and calls `open(docsUrl)` to open the browser. There is a `SANDBOX` environment variable branch (under the sandbox, only addItem, no browser opening).

**Change**:

1. Change `supportedModes` to `['interactive', 'non_interactive', 'acp']`.
2. Change the action return type to `Promise<void | MessageActionReturn>`.
3. Insert a non-interactive branch at the start of the action:

```typescript
action: async (context) => {
  const langPath = getCurrentLanguage()?.startsWith('zh') ? 'zh' : 'en';
  const docsUrl = `https://qwenlm.github.io/qwen-code-docs/${langPath}`;

  if (context.executionMode !== 'interactive') {
    // Non-interactive/ACP: directly return the URL, do not open the browser, do not call addItem
    return {
      type: 'message',
      messageType: 'info',
      content: `Qwen Code documentation: ${docsUrl}`,
    };
  }

  // Interactive path: original SANDBOX check + addItem + open() unchanged
  if (process.env['SANDBOX'] && ...) {
    context.ui.addItem(...);
  } else {
    context.ui.addItem(...);
    await open(docsUrl);
  }
},
```

### 7.5 `/clear` (altNames: `reset`, `new`)

**Current state**: the action performs the following operations and returns `void`:

1. `config.getHookSystem()?.fireSessionEndEvent()` — fire the hook (has side effects)
2. `config.startNewSession()` — start a new session ID (has side effects)
3. `uiTelemetryService.reset()` — reset the telemetry counters (has side effects)
4. `skillTool.clearLoadedSkills()` — clear the skill cache (has side effects)
5. `context.ui.clear()` — clear the terminal UI (**UI side effect, a no-op under non-interactive**)
6. `geminiClient.resetChat()` — reset the chat history (has side effects)
7. `config.getHookSystem()?.fireSessionStartEvent()` — fire the hook (has side effects)

**Non-interactive/ACP semantics analysis**:

- `ui.clear()` is already a no-op in non-interactive mode and needs no handling
- `geminiClient.resetChat()`: in an ACP session this is a meaningful side effect (clearing the chat history) and should be retained; in a single non-interactive invocation, each invocation is a brand-new session, so `resetChat` is semantically redundant but harmless
- `config.startNewSession()`: meaningful in ACP (starting a new session ID); in a single non-interactive invocation it is likewise semantically redundant but harmless
- `fireSessionEndEvent` / `fireSessionStartEvent`: meaningful in ACP (firing hooks)

**Decision**: the non-interactive/ACP path retains all meaningful side effects (resetChat, startNewSession, hook events), only skips `ui.clear()` (already a no-op), and returns a context-boundary marker message.

**Change**:

1. Change `supportedModes` to `['interactive', 'non_interactive', 'acp']`.
2. Change the action return type to `Promise<void | MessageActionReturn>`.
3. Inside the action, after the `context.ui.clear()` call (or in place of it), branch by mode:

```typescript
action: async (context, _args) => {
  const { config } = context.services;

  if (config) {
    config.getHookSystem()?.fireSessionEndEvent(SessionEndReason.Clear).catch(...);

    const newSessionId = config.startNewSession();
    uiTelemetryService.reset();

    const skillTool = config.getToolRegistry()?.getAllTools().find(...);
    if (skillTool instanceof SkillTool) skillTool.clearLoadedSkills();

    if (newSessionId && context.session.startNewSession) {
      context.session.startNewSession(newSessionId);
    }

    // ui.clear() is already a no-op under non-interactive, but still called (no conditional branch needed)
    context.ui.clear();

    const geminiClient = config.getGeminiClient();
    if (geminiClient) {
      await geminiClient.resetChat();
    }

    config.getHookSystem()?.fireSessionStartEvent(...).catch(...);
  } else {
    context.ui.clear();
  }

  // Decide the return value based on mode
  if (context.executionMode !== 'interactive') {
    return {
      type: 'message',
      messageType: 'info',
      content: 'Context cleared. Previous messages are no longer in context.',
    };
  }
  // Interactive path: void (no return; the React UI is driven to update by ui.clear())
},
```

**ACP semantics**: after receiving the context-boundary marker, the IDE can display it as a session separator (e.g., a "new session started" hint) and clear its local chat history cache.

---

## 8. `handleCommandResult` Changes

**Conclusion: no changes needed.**

After all the Phase 2 command changes, the return type on the non-interactive/ACP path is either `message` or `submit_prompt`, both of which are already handled correctly in the `handleCommandResult` switch.

---

## 9. `createNonInteractiveUI()` Changes

**Conclusion: no changes needed.**

The current no-op implementation is sufficient. No-ops such as `addItem`, `clear`, `setPendingItem` are not called on the non-interactive path of Category B commands (because of the early return); the interactive path is unaffected.

---

## 10. Phase 2.2: Wiring Up Prompt Command Model Invocation

In Phase 1, `CommandService.getModelInvocableCommands()` was already implemented, and `BundledSkillLoader`, `FileCommandLoader` (user/project commands), and `McpPromptLoader` were already set to `modelInvocable: true`.

The work in Phase 2.2 is to change `SkillTool` from consuming only `SkillManager.listSkills()` to also consuming `CommandService.getModelInvocableCommands()`, unifying the entry point for model-invocable commands.

**Files changed**: `packages/core/src/tools/SkillTool.ts` (or the corresponding path)

**Specific changes**:

1. `SkillTool` receives `CommandService` (or the result of its `getModelInvocableCommands()`) as a dependency injection during initialization
2. When building the tool description, merge the results of `listSkills()` and `getModelInvocableCommands()`
3. Ensure built-in commands (`modelInvocable: false`) do not appear in the tool description

> **Note**: the specific implementation of `SkillTool` depends on the internal architecture of `packages/core`; the detailed design in this document only describes the interface changes, and the implementation details need to be determined based on the existing structure of the core package.

---

## 11. Phase 2.3: Mid-input Slash Command Detection (Basic Version)

In the `InputPrompt` component, detect the slash token near the cursor (not limited to the start of the line) to trigger the completion menu.

**Detection rules**:

- When there is a token before the cursor that starts with `/` and contains no spaces, trigger command completion
- The completion candidates come from the list of visible commands from `getCommandsForMode('interactive')`
- The completion menu displays the command name + description (without `argumentHint` etc.; to be added in Phase 3)

> This feature is a UI-layer change and belongs to the independent subtask Phase 2.3; it does not affect the implementation of the other Phase 2.1/2.2 items.

---

## 12. File Changes Overview

### 12.1 Command File Changes (Phase 2.1)

| File                     | Change Type      | Specifics                                                                                                                                                                |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exportCommand.ts`       | Category A       | Parent command + 4 subcommands: `supportedModes` → all modes                                                                                                             |
| `planCommand.ts`         | Interactive only | Design decision: keep `supportedModes: ['interactive']`, unchanged                                                                                                       |
| `statuslineCommand.ts`   | Interactive only | Design decision: keep `supportedModes: ['interactive']`, unchanged                                                                                                       |
| `languageCommand.ts`     | Category A+      | Parent command + `ui`/`output` subcommands + dynamic language subcommands: `supportedModes` → all modes                                                                  |
| `copyCommand.ts`         | Interactive only | Design decision: keep `supportedModes: ['interactive']`, unchanged                                                                                                       |
| `restoreCommand.ts`      | Interactive only | Design decision: keep `supportedModes: ['interactive']`, unchanged                                                                                                       |
| `modelCommand.ts`        | Category A'      | `supportedModes` → all modes + new non-interactive branch on the no-argument / no-fast-model path                                                                        |
| `approvalModeCommand.ts` | Category A'      | `supportedModes` → all modes + new non-interactive branch on the no-argument path                                                                                        |
| `aboutCommand.ts`        | Category B       | `supportedModes` → all modes + non-interactive path returns `message` (version/model/environment summary)                                                                |
| `statsCommand.ts`        | Category B       | `supportedModes` → all modes + non-interactive path returns `message` (stats text); subcommands handled accordingly                                                      |
| `insightCommand.ts`      | Category B       | `supportedModes` → all modes + `non_interactive` path generates synchronously and returns `message` (file path); `acp` path returns `stream_messages` with progress push |
| `docsCommand.ts`         | Category B       | `supportedModes` → all modes + non-interactive path returns `message` (docs URL), does not open the browser                                                              |
| `clearCommand.ts`        | Category B       | `supportedModes` → all modes + at the end of the action, return `message` or `void` based on mode                                                                        |

### 12.2 Other File Changes

| File                                                            | Change                                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/core/src/tools/SkillTool.ts`                          | Phase 2.2: wire in `getModelInvocableCommands()` (detailed design to be determined separately) |
| `packages/cli/src/ui/InputPrompt.tsx` (or equivalent component) | Phase 2.3: mid-input slash detection logic                                                     |

### 12.3 Unchanged Files

- `packages/cli/src/nonInteractiveCliCommands.ts` (`handleCommandResult`, `handleSlashCommand` need no changes)
- `packages/cli/src/ui/noninteractive/nonInteractiveUi.ts` (stub UI needs no changes)
- `packages/cli/src/services/commandUtils.ts` (`filterCommandsForMode`, `getEffectiveSupportedModes` need no changes)
- `packages/cli/src/services/CommandService.ts` (`getCommandsForMode`, `getModelInvocableCommands` already implemented in Phase 1)

---

## 13. Testing Strategy

### 13.1 Command Unit Tests

For each changed command, add or update a test file (`*.test.ts`) in the same directory, covering the following cases:

**Category A/A+ commands** (`export`, `language`):

- `supportedModes` correctly includes `non_interactive` and `acp`
- Under `executionMode: 'non_interactive'`, the action returns `MessageActionReturn` or `SubmitPromptActionReturn` and does not call `ui.addItem` or `ui.clear`
- The interactive path behavior is exactly the same as before the refactor (snapshot test)

**Interactive-only commands** (`plan`, `statusline`, `copy`, `restore`):

- `supportedModes` is `['interactive']`, which is a design decision
- Verify that executing under non-interactive correctly returns `unsupported`

**Category A' commands** (`model`, `approval-mode`):

- No arguments + `executionMode: 'non_interactive'` → returns a current-state `message`, not a `dialog`
- With arguments + `executionMode: 'non_interactive'` → the original `message` logic executes normally
- Interactive path: no arguments → `dialog`, with arguments → `message` (unchanged)

**Category B commands** (`about`, `stats`, `insight`, `docs`, `clear`):

- Under `executionMode: 'non_interactive'`, the action returns `MessageActionReturn` and does not call any `ui.*` methods
- The returned `content` string contains the expected key fields (version number, model name, URL, etc.)
- Interactive path: `ui.addItem` is called, and `action` returns `void` (unchanged)

**The special case for `clear`**:

- Under `executionMode: 'non_interactive'`, `geminiClient.resetChat()` is still called (side effect retained)
- Returns a context-boundary `message` with the content `'Context cleared. Previous messages are no longer in context.'`

### 13.2 Integration Tests (`handleSlashCommand`)

In `nonInteractiveCli.test.ts` or a newly created integration test file:

- `handleSlashCommand('/about', ...)` in non-interactive mode returns `{ type: 'message', content: contains version number }`
- `handleSlashCommand('/stats', ...)` in non-interactive mode returns `{ type: 'message', content: contains 'Session duration' }`
- `handleSlashCommand('/docs', ...)` in non-interactive mode returns `{ type: 'message', content: contains 'qwenlm.github.io' }`
- `handleSlashCommand('/clear', ...)` in non-interactive mode returns `{ type: 'message', content: 'Context cleared.' }`
- `handleSlashCommand('/plan', ...)` in non-interactive mode returns `unsupported` (interactive-only command)
- Existing non-interactive commands (`btw`, `bug`, etc.) have no behavioral regression

### 13.3 `commandUtils` Tests

Add to `commandUtils.test.ts` (or have existing tests continue to cover):

- The expanded commands (`export`, `language`, etc.) all pass the filtering of `filterCommandsForMode(commands, 'non_interactive')` and `filterCommandsForMode(commands, 'acp')`
- The interactive-only commands (`plan`, `statusline`, `copy`, `restore`) are correctly filtered out under `filterCommandsForMode(commands, 'non_interactive')`

---

## 14. Behavioral Impact Analysis

| Scenario                                                | Behavior before Phase 2                                               | Behavior after Phase 2                               | Nature                          |
| ------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------- |
| Execute `/export md` under non-interactive              | ❌ unsupported (filtered out)                                         | ✅ returns a file-path message                       | Capability expansion            |
| Execute `/plan <task>` under non-interactive            | ❌ unsupported                                                        | ❌ unsupported (design decision: interactive only)   | Unchanged                       |
| Execute `/statusline` under non-interactive             | ❌ unsupported                                                        | ❌ unsupported (design decision: interactive only)   | Unchanged                       |
| Execute `/language ui zh-CN` under non-interactive      | ❌ unsupported                                                        | ✅ sets the language, returns a confirmation message | Capability expansion            |
| Execute `/copy` under non-interactive                   | ❌ unsupported                                                        | ❌ unsupported (design decision: interactive only)   | Unchanged                       |
| Execute `/restore` (no arguments) under non-interactive | ❌ unsupported                                                        | ❌ unsupported (design decision: interactive only)   | Unchanged                       |
| Execute `/restore <id>` under non-interactive           | ❌ unsupported                                                        | ❌ unsupported (design decision: interactive only)   | Unchanged                       |
| Execute `/model` under non-interactive                  | ❌ unsupported (dialog)                                               | ✅ returns the current model name                    | Capability expansion            |
| Execute `/model <id>` under non-interactive             | ❌ unsupported                                                        | 🔄 Phase 2 optional: implement switch logic          | Capability expansion (optional) |
| Execute `/approval-mode` under non-interactive          | ❌ unsupported (dialog)                                               | ✅ returns the current approval mode                 | Capability expansion            |
| Execute `/approval-mode yolo` under non-interactive     | ❌ unsupported                                                        | ✅ sets the mode, returns a confirmation             | Capability expansion            |
| Execute `/about` under non-interactive                  | ❌ returns "Command executed successfully." (addItem no-op)           | ✅ returns a version/model/environment summary       | Bug fix + capability expansion  |
| Execute `/stats` under non-interactive                  | ❌ returns "Command executed successfully."                           | ✅ returns session statistics text                   | Bug fix + capability expansion  |
| Execute `/insight` under non-interactive                | ❌ returns "Command executed successfully." (generates but no output) | ✅ generates and returns the file path               | Bug fix + capability expansion  |
| Execute `/docs` under non-interactive                   | ❌ returns "Command executed successfully."                           | ✅ returns the docs URL                              | Bug fix + capability expansion  |
| Execute `/clear` under non-interactive                  | ❌ returns "Command executed successfully."                           | ✅ returns a context-boundary message                | Bug fix + capability expansion  |
| Execute any of the above commands under interactive     | ✅ original behavior                                                  | ✅ original behavior (zero regression)               | Unchanged                       |

---

## 15. Implementation Order

The recommended implementation order is as follows; each group can be committed and reviewed independently:

**Batch 1** (~30min): Category A — only change `supportedModes`

Modify `exportCommand.ts` (and its subcommands), verify that tests pass.

**Batch 2** (~45min): Category A+ — a small amount of branching

Modify `languageCommand.ts`, add a non-interactive branch for the paths with side effects, and update the corresponding tests. (`copyCommand.ts` and `restoreCommand.ts` were kept interactive-only after discussion.)

**Batch 3** (~45min): Category A' — dialog paths

Modify `modelCommand.ts`, `approvalModeCommand.ts`, add a non-interactive branch for the no-argument paths, and update the corresponding tests.

**Batch 4** (~1.5h): Category B — complete branches

Modify `aboutCommand.ts`, `statsCommand.ts` (including subcommands), `docsCommand.ts`.

**Batch 5** (~1h): Category B special cases — `insightCommand.ts`, `clearCommand.ts`

These two commands have more side effects; put them in a separate commit, and update the corresponding tests and integration tests.

**Batch 6** (~2h): Phase 2.2 — wire up prompt command model invocation

Modify `SkillTool`, wire in `getModelInvocableCommands()`, and update the SkillTool tests.

**Batch 7** (~2h): Phase 2.3 — mid-input slash detection

Modify the `InputPrompt` component, add the completion trigger logic and UI tests.

**Batch 8** (~30min): full test run + type check

Run `npm run typecheck`, `cd packages/cli && npx vitest run`, and fix any remaining issues.

---

## 16. Acceptance Checklist

**Phase 2.1 Command Expansion**

- [ ] Category A: `/export` (and subcommands), `/plan`, `/statusline` execute normally and return meaningful output under non-interactive and acp modes
- [ ] Category A+: `/language` (and subcommands) executes normally under non-interactive, with the setting persisted
- [ ] Category A+: `/copy` returns the last AI output text under non-interactive/acp (without operating the clipboard)
- [ ] Category A+: `/restore` with no arguments returns the checkpoint list under non-interactive; with arguments, restores the state and returns a confirmation message (does not return `type: 'tool'`)
- [ ] Category A': `/model` with no arguments returns the current model name under non-interactive/acp (without triggering a dialog); `/model --fast <id>` sets it normally
- [ ] Category A': `/approval-mode` with no arguments returns the current mode under non-interactive/acp (without triggering a dialog); with arguments, sets it normally
- [ ] Category B: `/about` returns a plain-text summary containing the version number and model name under non-interactive/acp
- [ ] Category B: `/stats` (including subcommands) returns plain-text statistics under non-interactive/acp
- [ ] Category B: `/insight` generates the insight file and returns the file path under non-interactive/acp (without opening the browser)
- [ ] Category B: `/docs` returns the docs URL under non-interactive/acp (without opening the browser)
- [ ] Category B: `/clear` returns a context-boundary marker message under non-interactive/acp, and `geminiClient.resetChat()` executes normally
- [ ] All 13 commands behave exactly as before the refactor under interactive mode (no regression)
- [ ] No TypeScript compilation errors (`npm run typecheck`)
- [ ] No new errors from `npm run lint`
- [ ] All existing tests pass (`cd packages/cli && npx vitest run`)

**Phase 2.2 Model Invocation**

- [ ] The model can invoke bundled skills, file commands (user/project), and MCP prompts via `SkillTool` during a conversation
- [ ] The model cannot invoke built-in commands
- [ ] The `SkillTool` tool description contains the name and description of all `modelInvocable: true` commands

**Phase 2.3 Mid-input Slash**

- [ ] Typing `/` in the body of the input box triggers the command completion menu (not limited to the start of the line)
- [ ] The completion menu displays the command name + description
- [ ] After a completion is selected, it is correctly filled into the input box
