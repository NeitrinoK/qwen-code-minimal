# Phase 1 Technical Design: Infrastructure Rebuild

## 1. Design Goals and Constraints

### 1.1 Goals

- Establish a unified command metadata model covering four dimensions: source, execution type (commandType), mode capability (supportedModes), and visibility (userInvocable / modelInvocable)
- Replace the hardcoded allowlists in non-interactive/acp with capability-based filtering
- Provide a stable low-level interface for the capability extensions in Phase 2/3

### 1.2 Hard Constraints

- **Zero behavior change**: the set of commands currently available in non-interactive and acp modes stays unchanged (exception: fixing MCP_PROMPT being incorrectly blocked, which is a bug fix)
- **Backward compatibility**: all new fields on the `SlashCommand` interface are optional or have sensible defaults, so existing command code does not need to change immediately
- **No new executors**: do not create new execution architectures such as ModeAdapter / CommandExecutor; only extend the existing CommandService and filtering logic
- **No change to existing command capabilities**: do not add a local subcommand to any command, and do not modify any command's action implementation

---

## 2. New Type Definitions

### 2.1 File Location

All new types are defined in `packages/cli/src/ui/commands/types.ts`, in the same file as the existing `SlashCommand` interface.

### 2.2 `ExecutionMode`

```typescript
/**
 * Runtime mode enum.
 * - interactive: React/Ink UI mode (terminal interaction)
 * - non_interactive: non-interactive CLI mode (text/JSON output)
 * - acp: ACP/Zed integration mode
 */
export type ExecutionMode = 'interactive' | 'non_interactive' | 'acp';
```

### 2.3 `CommandSource`

```typescript
/**
 * Command source enum, used for Help grouping, completion badges, and ACP available commands.
 *
 * Difference from CommandKind:
 * - CommandKind is the internal loader classification (4 kinds), which affects loading logic
 * - CommandSource is the user-facing source classification (9 kinds), which affects presentation and the user's mental model
 *
 * The two may overlap, but have different responsibilities and are not merged.
 */
export type CommandSource =
  | 'builtin-command' // built-in command (BuiltinCommandLoader)
  | 'bundled-skill' // skill distributed with the package (BundledSkillLoader)
  | 'skill-dir-command' // file command under the user/project .qwen/commands/ directory (FileCommandLoader, not a plugin)
  | 'plugin-command' // command provided by a plugin (FileCommandLoader, extensionName is non-empty)
  | 'mcp-prompt'; // prompt provided by an MCP server (McpPromptLoader)
// The following sources are reserved; Phase 1 does not implement their Loaders, but the schema is defined up front:
// | 'workflow-command'
// | 'plugin-skill'
// | 'dynamic-skill'
// | 'builtin-plugin-skill'
// | 'mcp-skill'
```

### 2.4 `CommandType`

```typescript
/**
 * Command execution type, describing "how" a command executes.
 *
 * - prompt: produces submit_prompt, submitting the content to the model. Applies to skills, file commands, and MCP prompts.
 *   Default supportedModes is all modes; default modelInvocable is true.
 *
 * - local: executes logic locally, without depending on the React/Ink UI. Can return message, stream_messages,
 *   submit_prompt, tool, and similar types. Applies to query, configuration, and status built-in commands.
 *   Default supportedModes is ['interactive']; supportedModes must be declared explicitly to open it up to other modes.
 *   This matches the semantics of Claude Code's supportsNonInteractive: true — non-interactive support must be declared explicitly, not inferred automatically.
 *
 * - local-jsx: commands that depend on the React/Ink UI (opening dialogs, rendering JSX components, etc.).
 *   Default supportedModes is only ['interactive'].
 */
export type CommandType = 'prompt' | 'local' | 'local-jsx';
```

### 2.5 Extending the `SlashCommand` Interface

New fields are appended to the existing interface, **all optional** to ensure backward compatibility:

```typescript
export interface SlashCommand {
  // ── Existing fields (unchanged) ──────────────────────────────────────
  name: string;
  altNames?: string[];
  description: string;
  hidden?: boolean;
  completionPriority?: number;
  kind: CommandKind;
  extensionName?: string;
  action?: (...) => ...;
  completion?: (...) => ...;
  subCommands?: SlashCommand[];

  // ── Phase 1 new: source and execution type ──────────────────────────
  /**
   * Command source, used for Help grouping, completion badges, and ACP available commands display.
   * Populated by each Loader, not declared by the command itself.
   * When CommandKind is deprecated in the future, source will become the sole source identifier.
   */
  source?: CommandSource;

  /**
   * User-facing source label for display.
   * - builtin-command → "Built-in"
   * - bundled-skill → "Skill"
   * - skill-dir-command → "Custom"
   * - plugin-command → "Plugin: <extensionName>"
   * - mcp-prompt → "MCP: <serverName>"
   * Populated by each Loader, can be overridden by the command itself.
   */
  sourceLabel?: string;

  /**
   * Command execution type.
   * - Default value populated by each Loader (prompt/local-jsx)
   * - For built-in commands, declared by each command file itself (local or local-jsx)
   * See getEffectiveCommandType() for the default strategy when undeclared.
   */
  commandType?: CommandType;

  // ── Phase 1 new: mode capability ────────────────────────────────────
  /**
   * Which runtime modes this command is available in.
   * When undeclared, the default is inferred from commandType (see getEffectiveSupportedModes()).
   * An explicit declaration takes precedence over the inferred value.
   */
  supportedModes?: ExecutionMode[];

  // ── Phase 1 new: visibility ──────────────────────────────────────────
  /**
   * Whether the user can invoke this command via a slash command.
   * Defaults to true (almost all commands are userInvocable).
   */
  userInvocable?: boolean;

  /**
   * Whether the model can invoke this command via a tool call.
   * Defaults to false. prompt-type commands (skills, file commands, MCP prompts) should set this to true.
   * built-in commands are not allowed to be invoked by the model (always false).
   */
  modelInvocable?: boolean;

  // ── Phase 3 reserved: experience metadata (Phase 1 only defines, does not use) ──
  /**
   * Argument hint, shown after the command name in the completion menu.
   * Examples: "<model-id>" / "show|list|set <id>" / "[--fast] [<model-id>]"
   */
  argumentHint?: string;

  /**
   * Explanation to help the model understand when to invoke this command.
   * Will be injected into the description of modelInvocable commands.
   */
  whenToUse?: string;

  /**
   * Usage examples, shown in the Help catalog and completion.
   */
  examples?: string[];
}
```

---

## 3. Field Population Spec for Each Loader

### 3.1 Population Principles

- `source` and `sourceLabel` are populated by the Loader when building the `SlashCommand`; the command itself does not declare them
- `commandType`: the Loader populates the default value; built-in commands declare it in the command file itself
- `supportedModes`: inferred via `getEffectiveSupportedModes()`, no explicit population needed (unless the default needs to be overridden)
- `modelInvocable`: populated by the Loader; built-in commands are always `false`, prompt-type commands are `true`

### 3.2 `BuiltinCommandLoader`

```typescript
// Does not populate source/sourceLabel/commandType — declared by each command file itself
// because the commandType of built-in commands is local or local-jsx and must be annotated one by one

// Inject source and sourceLabel:
for (const cmd of rawCommands) {
  enrichedCommands.push({
    ...cmd,
    source: 'builtin-command',
    sourceLabel: 'Built-in',
    userInvocable: cmd.userInvocable ?? true,
    modelInvocable: false, // built-in commands are not allowed to be invoked by the model
  });
}
```

### 3.3 `BundledSkillLoader`

```typescript
return skills.map((skill) => ({
  name: skill.name,
  description: skill.description,
  kind: CommandKind.SKILL,
  source: 'bundled-skill' as CommandSource,
  sourceLabel: 'Skill',
  commandType: 'prompt' as CommandType,
  userInvocable: true,
  modelInvocable: true,
  action: async (...) => { ... },
}));
```

### 3.4 `FileCommandLoader`

```typescript
// In createSlashCommandFromDefinition:
return {
  name: baseCommandName,
  description,
  kind: CommandKind.FILE,
  extensionName,
  // source is determined by extensionName:
  source: extensionName ? 'plugin-command' : 'skill-dir-command',
  sourceLabel: extensionName ? `Plugin: ${extensionName}` : 'Custom',
  commandType: 'prompt',
  userInvocable: true,
  modelInvocable: !extensionName, // plugin commands are not yet allowed to be invoked by the model; user/project commands are
  action: async (...) => { ... },
};
```

> **Note**: plugin commands (plugin-command) are not yet marked `modelInvocable`, to avoid security risks. A later Phase can open this up as needed, controlled by the user via configuration.

### 3.5 `McpPromptLoader`

```typescript
const newPromptCommand: SlashCommand = {
  name: commandName,
  description: prompt.description || `Invoke prompt ${prompt.name}`,
  kind: CommandKind.MCP_PROMPT,
  source: 'mcp-prompt',
  sourceLabel: `MCP: ${serverName}`,
  commandType: 'prompt',
  userInvocable: true,
  modelInvocable: true,
  // ... remaining existing fields
};
```

---

## 4. `commandType` Declaration Spec for Built-in Commands

### 4.1 Classification Criteria

| commandType | Criteria                                                                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`     | The action only uses `ui.addItem` (text types), returns `message` / `stream_messages` / `submit_prompt` / `tool`, and does not depend on React component rendering                                         |
| `local-jsx` | The action returns `dialog`, or the action calls `ui.addItem` with a complex JSX-containing type (such as `HistoryItemHelp`, `HistoryItemStats`), or depends on `confirm_action` / `load_history` / `quit` |

> **Note**: `ui.addItem(message/error/info types)` is `local`; `ui.addItem(complex UI types such as help/stats/tools/about)` is `local-jsx`.

### 4.2 Built-in Command Classification Table

**`local` class** (declare `commandType: 'local'`, `supportedModes` inferred as all modes):

| Command file         | Command name | Notes                                                                     |
| -------------------- | ------------ | ------------------------------------------------------------------------- |
| `btwCommand.ts`      | `btw`        | Returns `submit_prompt` or `stream_messages`                              |
| `bugCommand.ts`      | `bug`        | Returns `submit_prompt` or `stream_messages`                              |
| `compressCommand.ts` | `compress`   | Already has executionMode handling; returns `message`/`submit_prompt`     |
| `contextCommand.ts`  | `context`    | Returns `message` (involves UI rendering but text is a viable substitute) |
| `exportCommand.ts`   | `export`     | File I/O; returns `message`                                               |
| `initCommand.ts`     | `init`       | Returns `submit_prompt`/`message`/`confirm_action`                        |
| `memoryCommand.ts`   | `memory`     | Subcommands return `message` (file I/O)                                   |
| `planCommand.ts`     | `plan`       | Returns `submit_prompt`                                                   |
| `summaryCommand.ts`  | `summary`    | Already has executionMode handling; returns `submit_prompt`/`message`     |
| `insightCommand.ts`  | `insight`    | Returns `stream_messages`                                                 |

> **Note**: although `contextCommand` and `insightCommand` currently make `addItem` calls, their content is essentially text, so they are `local`.

**`local-jsx` class** (declare `commandType: 'local-jsx'`, `supportedModes` inferred as `['interactive']`):

| Command file              | Command name     | Reason it cannot run headless                      |
| ------------------------- | ---------------- | -------------------------------------------------- |
| `aboutCommand.ts`         | `about`          | `addItem(HistoryItemAbout)` — complex UI component |
| `agentsCommand.ts`        | `agents`         | `dialog: subagent_create/subagent_list`            |
| `approvalModeCommand.ts`  | `approval-mode`  | `dialog: approval-mode`                            |
| `arenaCommand.ts`         | `arena`          | `dialog: arena_*`                                  |
| `authCommand.ts`          | `auth`           | `dialog: auth`                                     |
| `clearCommand.ts`         | `clear`          | `ui.clear()` directly manipulates the terminal     |
| `copyCommand.ts`          | `copy`           | Clipboard operation; no headless path              |
| `directoryCommand.tsx`    | `directory`      | JSX component                                      |
| `docsCommand.ts`          | `docs`           | Opens a browser                                    |
| `editorCommand.ts`        | `editor`         | `dialog: editor`                                   |
| `extensionsCommand.ts`    | `extensions`     | `dialog: extensions_manage`                        |
| `helpCommand.ts`          | `help`           | `addItem(HistoryItemHelp)` — complex Help UI       |
| `hooksCommand.ts`         | `hooks`          | `dialog: hooks`                                    |
| `ideCommand.ts`           | `ide`            | IDE process detection and interaction              |
| `languageCommand.ts`      | `language`       | `dialog` + `reloadCommands`                        |
| `mcpCommand.ts`           | `mcp`            | `dialog: mcp`                                      |
| `modelCommand.ts`         | `model`          | `dialog: model/fast-model`                         |
| `permissionsCommand.ts`   | `permissions`    | `dialog: permissions`                              |
| `quitCommand.ts`          | `quit`           | `quit` result type                                 |
| `restoreCommand.ts`       | `restore`        | `load_history` result type                         |
| `resumeCommand.ts`        | `resume`         | `dialog: resume`                                   |
| `settingsCommand.ts`      | `settings`       | `dialog: settings`                                 |
| `setupGithubCommand.ts`   | `setup-github`   | `confirm_shell_commands` + interactive operations  |
| `skillsCommand.ts`        | `skills`         | `addItem(HistoryItemSkillsList)` — complex UI      |
| `statsCommand.ts`         | `stats`          | `addItem(HistoryItemStats)` — complex UI           |
| `statuslineCommand.ts`    | `statusline`     | UI state configuration                             |
| `terminalSetupCommand.ts` | `terminal-setup` | Terminal configuration wizard                      |
| `themeCommand.ts`         | `theme`          | `dialog: theme`                                    |
| `toolsCommand.ts`         | `tools`          | `addItem(HistoryItemTools)` — complex UI           |
| `trustCommand.ts`         | `trust`          | `dialog: trust`                                    |
| `vimCommand.ts`           | `vim`            | `toggleVimEnabled()` — UI state                    |

---

## 5. `getEffectiveSupportedModes` Inference Rules

This function is the core logic of Phase 1. It replaces the original allowlist and will be called by `filterCommandsForMode`.

```typescript
/**
 * Get the actual list of supported modes for a command.
 *
 * Inference priority (highest to lowest):
 * 1. The command's explicitly declared supportedModes (highest priority)
 * 2. Inference based on commandType
 * 3. Fallback based on CommandKind (backward compatibility)
 */
export function getEffectiveSupportedModes(cmd: SlashCommand): ExecutionMode[] {
  // Priority 1: explicit declaration
  if (cmd.supportedModes !== undefined) {
    return cmd.supportedModes;
  }

  // Priority 2: inference based on commandType
  if (cmd.commandType !== undefined) {
    switch (cmd.commandType) {
      case 'prompt':
        // prompt type has no UI dependency, so it is naturally available in all modes
        return ['interactive', 'non_interactive', 'acp'];
      case 'local':
        // local type uses a conservative default: interactive only.
        // Commands needing non-interactive support must declare supportedModes explicitly (corresponds to Claude Code's supportsNonInteractive: true).
        // Phase 2 verifies and unlocks them one by one, to prevent unadapted commands from being accidentally exposed to headless callers.
        return ['interactive'];
      case 'local-jsx':
        return ['interactive'];
    }
  }

  // Priority 3: fallback (based on CommandKind, backward compatible with old code)
  switch (cmd.kind) {
    case CommandKind.BUILT_IN:
      // when a built-in command has no declared commandType, use a conservative default (interactive only)
      // this branch should no longer be hit after Phase 1 completes (all built-ins have commandType)
      return ['interactive'];
    case CommandKind.FILE:
    case CommandKind.SKILL:
    case CommandKind.MCP_PROMPT:
      // the actions of these three command kinds have no UI dependency by nature, and their historical behavior was all-mode availability
      return ['interactive', 'non_interactive', 'acp'];
    default:
      return ['interactive'];
  }
}
```

```typescript
/**
 * Filter commands suitable for the current mode based on supportedModes.
 * Replaces the original filterCommandsForNonInteractive function.
 */
export function filterCommandsForMode(
  commands: readonly SlashCommand[],
  mode: ExecutionMode,
): SlashCommand[] {
  return commands.filter((cmd) =>
    getEffectiveSupportedModes(cmd).includes(mode),
  );
}
```

---

## 6. `CommandService` Interface Extension

Add two new methods in `packages/cli/src/services/CommandService.ts`:

```typescript
export class CommandService {
  // ── Existing methods (unchanged) ──────────────────────────────────────
  getCommands(): readonly SlashCommand[] {
    return this.commands;
  }

  // ── Phase 1 new methods ──────────────────────────────────────────────

  /**
   * Returns the list of commands available in the given execution mode.
   * Replaces the original combination of allowlist + filterCommandsForNonInteractive.
   *
   * @param mode the target runtime mode
   * @returns the list of commands suitable for that mode (excluding hidden commands)
   */
  getCommandsForMode(mode: ExecutionMode): readonly SlashCommand[] {
    return this.commands.filter((cmd) => {
      if (cmd.hidden) return false;
      return getEffectiveSupportedModes(cmd).includes(mode);
    });
  }

  /**
   * Returns all commands whose modelInvocable is true.
   * In Phase 2, SkillTool will consume this method; Phase 1 only provides the interface.
   *
   * @returns the list of model-invocable commands
   */
  getModelInvocableCommands(): readonly SlashCommand[] {
    return this.commands.filter(
      (cmd) => !cmd.hidden && cmd.modelInvocable === true,
    );
  }
}
```

> **Note**: `getEffectiveSupportedModes` and `filterCommandsForMode` should be used as utility functions internal to `CommandService`, or extracted into a separate `packages/cli/src/services/commandUtils.ts` file and exported, to make them testable and reusable.

---

## 7. `nonInteractiveCliCommands.ts` Refactor

### 7.1 What to Delete

```typescript
// ❌ delete
export const ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE = [
  'init', 'summary', 'compress', 'btw', 'bug', 'context',
] as const;

// ❌ delete
function filterCommandsForNonInteractive(
  commands: readonly SlashCommand[],
  allowedBuiltinCommandNames: Set<string>,
): SlashCommand[] { ... }
```

### 7.2 What to Add

```typescript
// ✅ add (or import from commandUtils)
import { filterCommandsForMode } from '../services/commandUtils.js';
```

### 7.3 `handleSlashCommand` Function Signature Change

```typescript
// ❌ old signature
export const handleSlashCommand = async (
  rawQuery: string,
  abortController: AbortController,
  config: Config,
  settings: LoadedSettings,
  allowedBuiltinCommandNames: string[] = [...ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE],
): Promise<NonInteractiveSlashCommandResult>

// ✅ new signature (remove allowedBuiltinCommandNames)
export const handleSlashCommand = async (
  rawQuery: string,
  abortController: AbortController,
  config: Config,
  settings: LoadedSettings,
): Promise<NonInteractiveSlashCommandResult>
```

### 7.4 Internal Implementation Change

```typescript
// old:
const filteredCommands = filterCommandsForNonInteractive(
  allCommands,
  allowedBuiltinSet,
);

// new:
const executionMode = isAcpMode ? 'acp' : 'non_interactive';
const filteredCommands = filterCommandsForMode(allCommands, executionMode);
```

### 7.5 `getAvailableCommands` Function Signature Change

```typescript
// ❌ old signature
export const getAvailableCommands = async (
  config: Config,
  abortSignal: AbortSignal,
  allowedBuiltinCommandNames: string[] = [...ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE],
): Promise<SlashCommand[]>

// ✅ new signature
export const getAvailableCommands = async (
  config: Config,
  abortSignal: AbortSignal,
  mode: ExecutionMode = 'acp',
): Promise<SlashCommand[]>
```

> The new `mode` parameter replaces the original allowlist parameter. ACP Session calls can explicitly specify `'acp'`, and non-interactive calls specify `'non_interactive'`.

---

## 8. `Session.ts` (ACP) Call Changes

```typescript
// ❌ old call
const slashCommandResult = await handleSlashCommand(
  inputText,
  abortController,
  this.config,
  this.settings,
  // not passed, uses the default allowlist
);

// ✅ new call (unchanged; removed the default parameter that no longer exists)
const slashCommandResult = await handleSlashCommand(
  inputText,
  abortController,
  this.config,
  this.settings,
);

// ─────────────────────────────────────────

// ❌ old call
const slashCommands = await getAvailableCommands(
  this.config,
  abortController.signal,
);

// ✅ new call (explicitly specify mode)
const slashCommands = await getAvailableCommands(
  this.config,
  abortController.signal,
  'acp',
);
```

---

## 9. File Change Overview

### 9.1 Modified Files

| File                                                                    | Changes                                                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/ui/commands/types.ts`                                 | Add `ExecutionMode`, `CommandSource`, `CommandType` types; extend the `SlashCommand` interface                                            |
| `packages/cli/src/services/CommandService.ts`                           | Add `getCommandsForMode()` and `getModelInvocableCommands()` methods                                                                      |
| `packages/cli/src/nonInteractiveCliCommands.ts`                         | Delete the allowlist constant and old filter function; update the signatures of two exported functions; introduce `filterCommandsForMode` |
| `packages/cli/src/acp-integration/session/Session.ts`                   | Update the `handleSlashCommand` and `getAvailableCommands` calls                                                                          |
| `packages/cli/src/services/BuiltinCommandLoader.ts`                     | Inject `source: 'builtin-command'`, `sourceLabel: 'Built-in'`, `modelInvocable: false` when building commands                             |
| `packages/cli/src/services/BundledSkillLoader.ts`                       | Inject `source: 'bundled-skill'`, `commandType: 'prompt'`, `modelInvocable: true`                                                         |
| `packages/cli/src/services/FileCommandLoader.ts` / `command-factory.ts` | Inject `source`, `commandType: 'prompt'`, `modelInvocable` (based on extensionName)                                                       |
| `packages/cli/src/services/McpPromptLoader.ts`                          | Inject `source: 'mcp-prompt'`, `commandType: 'prompt'`, `modelInvocable: true`                                                            |
| **Each built-in command file (10 local + 27 local-jsx)**                | Declare `commandType: 'local'` or `commandType: 'local-jsx'`                                                                              |

### 9.2 New Files

| File                                        | Contents                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/cli/src/services/commandUtils.ts` | The `getEffectiveSupportedModes()` and `filterCommandsForMode()` utility functions and their exports |

### 9.3 Unchanged Files

- `packages/cli/src/ui/commands/commands.ts` (`parseSlashCommand` needs no changes)
- `packages/cli/src/ui/hooks/slashCommandProcessor.ts` (the interactive path needs no changes)
- `packages/cli/src/ui/noninteractive/nonInteractiveUi.ts` (the stub UI needs no changes)
- The `action` implementations of all commands (Phase 1 does not modify any command behavior)

---

## 10. Behavior Impact Analysis

### 10.1 Summary of Changes

| Scenario                               | Old behavior                   | New behavior                                                    | Nature      |
| -------------------------------------- | ------------------------------ | --------------------------------------------------------------- | ----------- |
| Run `/init` in non-interactive         | ✅ allowed (allowlist)         | ✅ allowed (`commandType: local`)                               | No change   |
| Run `/summary` in non-interactive      | ✅ allowed                     | ✅ allowed                                                      | No change   |
| Run `/compress` in non-interactive     | ✅ allowed                     | ✅ allowed                                                      | No change   |
| Run `/btw` in non-interactive          | ✅ allowed                     | ✅ allowed                                                      | No change   |
| Run `/bug` in non-interactive          | ✅ allowed                     | ✅ allowed                                                      | No change   |
| Run `/context` in non-interactive      | ✅ allowed                     | ✅ allowed                                                      | No change   |
| Run `/model` in non-interactive        | ❌ unsupported                 | ❌ unsupported (`commandType: local-jsx`)                       | No change   |
| Run a file command in non-interactive  | ✅ allowed (CommandKind.FILE)  | ✅ allowed (`commandType: prompt`)                              | No change   |
| Run a bundled skill in non-interactive | ✅ allowed (CommandKind.SKILL) | ✅ allowed (`commandType: prompt`)                              | No change   |
| Run an MCP prompt in non-interactive   | ❌ blocked by CommandKind      | ✅ allowed (`commandType: prompt`)                              | **Bug fix** |
| Run `/export` in non-interactive       | ❌ not in allowlist            | ❌ not allowed (`commandType: local`, default interactive only) | No change   |
| Run `/memory` in non-interactive       | ❌ not in allowlist            | ❌ not allowed (`commandType: local`, default interactive only) | No change   |
| Run `/plan` in non-interactive         | ❌ not in allowlist            | ❌ not allowed (`commandType: local`, default interactive only) | No change   |

> **About the conservative default strategy for `local` commands**: the default `supportedModes` for `commandType: 'local'` is `['interactive']`. This is consistent with Claude Code's design — `local` type commands need to explicitly declare `supportsNonInteractive: true` to run in non-interactive mode. In Phase 1, the 6 commands in the allowlist (`init`, `summary`, `compress`, `btw`, `bug`, `context`) equivalently replace the original allowlist effect by explicitly declaring `supportedModes: ['interactive', 'non_interactive', 'acp']`. Commands that need to be extended in Phase 2 (such as `/export`, `/memory`, `/plan`) are unlocked one by one after verifying their action implementations are headless-friendly.

---

## 10.2 Phase 2 Mode-Divergent Commands: Dual Registration Pattern

For commands in Phase 2 that need "a UI in interactive mode and text output in non-interactive mode" (such as `/model`), use the **dual registration pattern** rather than branching inside a single command's `action`.

This is Claude Code's standard pattern, with `/context` as an example (see `src/commands/context/index.ts`): two `Command` objects with the same name, one `local-jsx` for interactive only and the other `local` for non-interactive only, made mutually exclusive via `isEnabled()`.

In Phase 2, Qwen Code should adopt the equivalent approach, using `supportedModes` instead of `isEnabled()` for mutual exclusion:

```typescript
// ① Interactive version: local-jsx, interactive only
export const modelCommandInteractive: SlashCommand = {
  name: 'model',
  kind: CommandKind.BUILT_IN,
  commandType: 'local-jsx',
  supportedModes: ['interactive'], // explicitly scoped
  // action: open a dialog to select the model
};

// ② Non-interactive/acp version: local, explicitly opened up to headless callers
export const modelCommandHeadless: SlashCommand = {
  name: 'model',
  kind: CommandKind.BUILT_IN,
  commandType: 'local',
  supportedModes: ['non_interactive', 'acp'], // explicitly scoped
  // action: read/set the model, return message (plain text)
};
```

The two objects share the same name, their `supportedModes` are mutually exclusive, and `filterCommandsForMode` automatically selects the correct version. Compared with Claude Code's `isEnabled()` exclusion, `supportedModes` filtering is more explicit, easier to test, and does not require runtime environment detection.

**Phase 1 does not implement any dual-registration commands**; this pattern is reserved here only as an implementation spec for Phase 2.

---

## 11. Testing Strategy

### 11.1 New Utility Function Tests

In `packages/cli/src/services/commandUtils.test.ts` (new file):

```typescript
describe('getEffectiveSupportedModes', () => {
  it('explicit supportedModes takes precedence over commandType inference', () => {
    const cmd: SlashCommand = {
      name: 'test', description: '', kind: CommandKind.BUILT_IN,
      commandType: 'local',
      supportedModes: ['interactive'], // explicit restriction
    };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('commandType: local infers all modes', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.BUILT_IN, commandType: 'local' };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });

  it('commandType: local-jsx infers interactive only', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.BUILT_IN, commandType: 'local-jsx' };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('commandType: prompt infers all modes', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.SKILL, commandType: 'prompt' };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });

  it('no commandType declared and CommandKind.BUILT_IN, falls back to interactive', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.BUILT_IN };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('no commandType declared and CommandKind.FILE, falls back to all modes', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.FILE };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });

  it('no commandType declared and CommandKind.MCP_PROMPT, falls back to all modes (fixes the original restriction)', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.MCP_PROMPT };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });
});

describe('filterCommandsForMode', () => {
  it('correctly filters commands in non_interactive mode', () => { ... });
  it('correctly filters commands in acp mode', () => { ... });
  it('does not filter hidden commands (filterCommandsForMode does not handle hidden, CommandService does)', () => { ... });
});
```

### 11.2 Update `nonInteractiveCliCommands.test.ts`

- Delete all references to `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE`
- Delete test cases for the `allowedBuiltinCommandNames` parameter
- Add: verify that commandType: local commands pass the filter in non-interactive
- Add: verify that commandType: local-jsx commands are filtered out in non-interactive
- Keep: verify that file command / skill command pass the filter in non-interactive

### 11.3 Update `CommandService.test.ts`

- Add test cases for `getCommandsForMode`
- Add test cases for `getModelInvocableCommands`

### 11.4 Tests for Each Loader

- `BuiltinCommandLoader.test.ts`: verify all commands have `source: 'builtin-command'`
- `BundledSkillLoader.test.ts`: verify `source: 'bundled-skill'` and `modelInvocable: true`
- `FileCommandLoader.test.ts`: verify user commands have `source: 'skill-dir-command'` and plugin commands have `source: 'plugin-command'`
- `McpPromptLoader.test.ts`: verify `source: 'mcp-prompt'` and `modelInvocable: true`

---

## 12. Implementation Order

The recommended implementation order below allows each step to be committed and reviewed independently:

**Step 1** (~30min): Modify `types.ts`, adding `ExecutionMode`, `CommandSource`, `CommandType` and the new `SlashCommand` fields
→ Pure type changes, TypeScript compilation check

**Step 2** (~1h): Create `commandUtils.ts`, implementing `getEffectiveSupportedModes` and `filterCommandsForMode`, and create `commandUtils.test.ts` alongside it
→ Unit tests cover the core logic

**Step 3** (~1h): Refactor `nonInteractiveCliCommands.ts`, delete the allowlist, introduce `filterCommandsForMode`, update the function signatures
→ Behaviorally equivalent (Phase 1 conservative strategy: local-class commands explicitly write `supportedModes: ['interactive']`)

**Step 4** (~30min): Update `CommandService.ts`, adding the two methods

**Step 5** (~2h): Add `commandType` declarations to all built-in command files
→ Confirm the classification of each one

**Step 6** (~1.5h): Update all Loaders, injecting `source`, `sourceLabel`, `commandType`, `modelInvocable`

**Step 7** (~30min): Update the call signatures in `Session.ts`

**Step 8** (~1h): Run all tests, fix failing cases, update snapshots

**Step 9** (~30min): CR self-check: confirm the allowlist is fully removed, with no missed calls

---

## 13. Acceptance Checklist

- [ ] TypeScript compiles without errors (`npm run typecheck`)
- [ ] `npm run lint` has no new lint errors
- [ ] All existing tests pass (`cd packages/cli && npx vitest run`)
- [ ] All new tests in `commandUtils.test.ts` pass
- [ ] `getEffectiveSupportedModes` covers all 7 cases
- [ ] `filterCommandsForMode` covers all three modes: interactive / non_interactive / acp
- [ ] `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE` has no references anywhere in the codebase (verified by `grep`)
- [ ] The `filterCommandsForNonInteractive` function has no references anywhere in the codebase
- [ ] All built-in commands have a `commandType` field
- [ ] All commands output by the Loaders have `source` and `sourceLabel` fields
- [ ] Commands output by `BundledSkillLoader` / `FileCommandLoader` (user commands) / `McpPromptLoader` have `modelInvocable: true`
- [ ] Commands output by `BuiltinCommandLoader` have `modelInvocable: false`
- [ ] `CommandService.getCommandsForMode('non_interactive')` returns a command set equivalent to before the refactor
- [ ] MCP prompt commands are no longer incorrectly blocked in non-interactive mode
