# Phase 3 Technical Design Document: Experience Alignment

## 1. Design Goals and Constraints

### 1.1 Goals

Building on the command metadata, cross-mode filtering, and prompt command model invocation already delivered in Phase 1/2, Phase 3 fills in the user-perceivable slash command experience:

- Show source, argument hints, and alias hits in the completion menu, and introduce session-level recently-used ordering
- Refine the ghost text, argument hints, source display, and valid-token highlighting for mid-input slash commands
- Refactor `/help` from its current unusable command dump into a Claude Code-style tabbed, clear, and polished help panel
- Enrich the command metadata in the ACP `available_commands_update`
- Confirm that the already-implemented `/doctor` is not reimplemented; `/release-notes` is not included in this phase

### 1.2 Hard Constraints

- **Code is authoritative**: When the Phase 1/2 docs diverge from the implementation, the current main branch source code prevails.
- **No new execution architecture**: Continue to reuse the existing `SlashCommand`, `CommandService`, `handleSlashCommand`, `useSlashCompletion`, and `Help` components; do not introduce new `CommandDescriptor` / `CommandExecutor` / `ModeAdapter`.
- **Do not restore `commandType`**: The current implementation has removed the `commandType` field from the early Phase 1 design; Phase 3 does not reintroduce that field.
- **Session-level recently used**: Recently-used ordering applies only within the current CLI session and is not persisted to disk.
- **No regression in interactive behavior**: Existing interactive behaviors such as completion, help, and doctor remain usable; Phase 3 only enhances the display and fills in missing commands.
- **ACP backward compatibility**: The three existing fields `availableCommands[].name`, `description`, and `input` remain unchanged; new metadata goes into compatible fields or `_meta` to avoid breaking existing ACP clients.

---

## 2. Current Implementation Baseline (Source Audit Conclusions)

### 2.1 Existing Metadata and Loader Behavior

`packages/cli/src/ui/commands/types.ts` currently has `SlashCommand` including:

- `source?: CommandSource`
- `sourceLabel?: string`
- `supportedModes?: ExecutionMode[]`
- `userInvocable?: boolean`
- `modelInvocable?: boolean`
- `argumentHint?: string`
- `whenToUse?: string`
- `examples?: string[]`

`CommandSource` currently supports:

```typescript
export type CommandSource =
  | 'builtin-command'
  | 'bundled-skill'
  | 'skill-dir-command'
  | 'plugin-command'
  | 'mcp-prompt';
```

Display information each Loader currently populates:

| Loader                                  | source                                 | sourceLabel                              | argumentHint        | modelInvocable                                                |
| --------------------------------------- | -------------------------------------- | ---------------------------------------- | ------------------- | ------------------------------------------------------------- |
| `BuiltinCommandLoader`                  | `builtin-command`                      | `Built-in`                               | mostly not declared | `false`                                                       |
| `BundledSkillLoader`                    | `bundled-skill`                        | `Skill`                                  | from skill          | `!disableModelInvocation`                                     |
| `FileCommandLoader` / `command-factory` | `skill-dir-command` / `plugin-command` | `Custom` / `Plugin: <extensionName>`     | from frontmatter    | user/project default true; plugins need description/whenToUse |
| `SkillCommandLoader`                    | `skill-dir-command` / `plugin-command` | `User` / `Project` / `Extension: <name>` | from skill          | user/project default true; plugins need description/whenToUse |
| `McpPromptLoader`                       | `mcp-prompt`                           | `MCP: <serverName>`                      | not generated       | currently does not explicitly set `modelInvocable`            |

> Note: The Phase 1 roadmap once required MCP prompts to be `modelInvocable: true`, but the current implementation does not set this explicitly. Phase 3 does not change the model invocation path of MCP prompts; MCP prompts are still invoked through the native MCP mechanism, not relayed through `SkillTool`.

### 2.2 Phase 3-Related Capabilities Already Implemented

| Capability                                           | Current Status                                                                                                                                                                               | Key Files                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| mid-input slash basic ghost text                     | Partially implemented; only does prefix completion for `modelInvocable` commands                                                                                                             | `ui/utils/commandUtils.ts`, `ui/hooks/useCommandCompletion.tsx`  |
| line-start command argument ghost text               | Partially implemented; shows `argumentHint` when the command matches exactly and has no args                                                                                                 | `ui/hooks/useCommandCompletion.tsx`                              |
| alias participates in matching                       | Matching and ordering implemented, but the display always shows all aliases without distinguishing the hit alias                                                                             | `ui/hooks/useSlashCompletion.ts`                                 |
| source badge                                         | Only MCP shows `[MCP]`                                                                                                                                                                       | `ui/components/SuggestionsDisplay.tsx`, `ui/components/Help.tsx` |
| `/help`                                              | The current implementation is considered incomplete: although it attempts grouping, it is still a command dump and lacks the Claude Code-style tabbed, clear, readable help panel experience | `ui/components/Help.tsx`                                         |
| ACP `argumentHint`                                   | Already mapped to `availableCommands[].input.hint`                                                                                                                                           | `acp-integration/session/Session.ts`                             |
| ACP source/supportedModes/subcommands/modelInvocable | Not exposed                                                                                                                                                                                  | `acp-integration/session/Session.ts`                             |
| conflict handling                                    | extension command conflicts are already renamed to `extensionName.commandName`; for non-extension same names, the later-loaded overrides the earlier-loaded                                  | `services/CommandService.ts`                                     |
| `/doctor`                                            | Implemented, supports `interactive` / `non_interactive` / `acp`                                                                                                                              | `ui/commands/doctorCommand.ts`, `ui/commands/doctorChecks.ts`    |

### 2.3 Points to Borrow from Claude Code

Referencing the `/Users/mochi/code/claude-code` source:

- `src/types/command.ts`: The command model includes display/capability fields such as `argumentHint`, `whenToUse`, `aliases`, `loadedFrom`, `kind`, `immediate`, `isSensitive`, `userFacingName`, `supportsNonInteractive`.
- `src/utils/suggestions/commandSuggestions.ts`: Completion ordering simultaneously considers exact hit, alias hit, prefix, fuzzy, and skill usage; on an alias hit it shows only the alias the user actually hit.
- `src/utils/suggestions/commandSuggestions.ts`: mid-input slash uses `findMidInputSlashCommand()`, `getBestCommandMatch()`, and `findSlashCommandPositions()` to support ghost text and highlighting.
- `src/components/HelpV2/Commands.tsx`: Help V2 is a browsable command directory that attaches source information when showing descriptions.
- `src/commands.ts`: Claude Code has built-in commands like `/doctor` and `/release-notes`; Qwen Code currently already implements `/doctor`; this phase does not implement `/release-notes`.

Phase 3 borrows from the above points with an "align the experience, do not copy the architecture" approach.

---

## 3. Overall Plan

### 3.1 File Change Overview

| File                                                    | Change                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/cli/src/ui/components/SuggestionsDisplay.tsx` | Extend the `Suggestion` type; display source badge, argumentHint, aliasHit                            |
| `packages/cli/src/ui/hooks/useSlashCompletion.ts`       | Produce enriched completion items; wire ordering into recently used; preserve alias hit info          |
| `packages/cli/src/ui/hooks/useCommandCompletion.tsx`    | Reuse the enriched matching for mid-input ghost text; emit argument/source metadata for the UI        |
| `packages/cli/src/ui/utils/commandUtils.ts`             | Add a slash-token highlighting helper, or extend existing functions to return command validity        |
| `packages/cli/src/ui/components/InputPrompt.tsx`        | Render highlighting for valid slash command tokens; keep Tab to accept ghost text                     |
| `packages/cli/src/ui/components/Help.tsx`               | Refactor into a Claude Code-style tabbed help panel, avoiding the command dump                        |
| `packages/cli/src/ui/commands/helpCommand.ts`           | If non-interactive/acp help text is needed, extend the action; otherwise keep just the interactive UI |
| `packages/cli/src/acp-integration/session/Session.ts`   | Expose the enriched metadata in the ACP update                                                        |
| `packages/cli/src/ui/commands/*Command.ts`              | Add `argumentHint` to common built-in commands                                                        |

### 3.2 New Shared Display Utility

We suggest adding `packages/cli/src/services/commandMetadata.ts` to centralize the display logic shared by Help, Completion, and ACP:

```typescript
export function getCommandSourceBadge(cmd: SlashCommand): string | null;
export function getCommandSourceGroup(cmd: SlashCommand): CommandSourceGroup;
export function formatSupportedModes(cmd: SlashCommand): string;
export function getCommandDisplayName(cmd: SlashCommand): string;
export function getCommandSubcommandNames(cmd: SlashCommand): string[];
```

We do not recommend putting these display functions into the Loader, to avoid the Loader taking on UI logic.

---

## 4. Phase 3.1: Completion Experience Enhancements

### 4.1 Extend the `Suggestion` Data Structure

Current:

```typescript
export interface Suggestion {
  label: string;
  value: string;
  description?: string;
  matchedIndex?: number;
  commandKind?: CommandKind;
}
```

Suggested extension:

```typescript
export interface Suggestion {
  label: string;
  value: string;
  description?: string;
  matchedIndex?: number;
  commandKind?: CommandKind;

  // Phase 3
  source?: CommandSource;
  sourceLabel?: string;
  sourceBadge?: string;
  argumentHint?: string;
  matchedAlias?: string;
  supportedModes?: ExecutionMode[];
  modelInvocable?: boolean;
}
```

File completion and reverse search for `mode !== 'slash'` do not need these fields populated.

### 4.2 source badge Display

Currently `SuggestionsDisplay` only appends `[MCP]` for `CommandKind.MCP_PROMPT`. Phase 3 changes this to uniformly generate the badge from `source` / `sourceLabel`:

| source / sourceLabel              | badge                                                      |
| --------------------------------- | ---------------------------------------------------------- |
| `builtin-command`                 | `[Built-in]` (optional: hidden by default to reduce noise) |
| `bundled-skill` / `Skill`         | `[Skill]`                                                  |
| `skill-dir-command` / `User`      | `[User]`                                                   |
| `skill-dir-command` / `Project`   | `[Project]`                                                |
| `skill-dir-command` / `Custom`    | `[Custom]`                                                 |
| `plugin-command` / `Plugin: x`    | `[Plugin]` or `[Plugin: x]`                                |
| `plugin-command` / `Extension: x` | `[Extension]` or `[Extension: x]`                          |
| `mcp-prompt`                      | `[MCP]`                                                    |

Recommended implementation:

```typescript
function getCommandSourceBadge(cmd: SlashCommand): string | null {
  switch (cmd.source) {
    case 'bundled-skill':
      return '[Skill]';
    case 'skill-dir-command':
      return cmd.sourceLabel === 'User'
        ? '[User]'
        : cmd.sourceLabel === 'Project'
          ? '[Project]'
          : '[Custom]';
    case 'plugin-command':
      return '[Plugin]';
    case 'mcp-prompt':
      return '[MCP]';
    case 'builtin-command':
    default:
      return null;
  }
}
```

> Whether to show `[Built-in]` is determined by UI readability. Help must show the Built-in group; the completion menu may omit the built-in badge and only show badges for non-built-in sources.

### 4.3 argument hint Display

In the completion menu, append a gray `argumentHint` after the command name:

```text
/model <model-id>              Switch model
/export md|html|json|jsonl     Export current session
/review [pr-number] [--comment] [Skill] Review changed code
```

Implementation suggestions:

- `useSlashCompletion` populates `argumentHint: cmd.argumentHint` in `finalSuggestions`
- `SuggestionsDisplay` renders `argumentHint` after the label using `theme.text.secondary`
- `commandColumnWidth` calculation includes label + hint + badge to avoid misaligning the description column
- Subcommand completion also supports `argumentHint`

Common built-in commands need `argumentHint` added first. Suggested first batch:

| Command          | argumentHint                         |
| ---------------- | ------------------------------------ |
| `/model`         | `[--fast] [<model-id>]`              |
| `/approval-mode` | `<mode>`                             |
| `/language`      | `ui\|output <language>`              |
| `/export`        | `md\|html\|json\|jsonl [path]`       |
| `/memory`        | `show\|add\|refresh`                 |
| `/mcp`           | `desc\|nodesc\|schema\|auth\|noauth` |
| `/stats`         | `[model\|tools]`                     |
| `/docs`          | empty or unset                       |
| `/doctor`        | empty or unset                       |

### 4.4 recently used Ordering

#### 4.4.1 State Storage

Maintain session-level recently-used state in `useSlashCommandProcessor` or `AppContainer`:

```typescript
type RecentSlashCommand = {
  name: string;
  usedAt: number;
  count: number;
};
```

We suggest storing it as `Map<string, RecentSlashCommand>`, keyed by the final command name (i.e., the post-conflict-resolution `cmd.name`).

#### 4.4.2 When to Record

Record usage after `useSlashCommandProcessor.handleSlashCommand` successfully resolves `commandToExecute`:

- Do not record when no command is found
- hidden commands may be skipped
- alias invocations are recorded under the canonical `commandToExecute.name`
- For subcommand invocations, we suggest recording the full path of parent and leaf commands; recording only the leaf command in the first iteration is also acceptable

#### 4.4.3 Ordering Weights

The current ordering of `compareRankedCommandMatches()` is:

1. matchStrength
2. completionPriority
3. fzf score
4. match start
5. item length
6. original index

Phase 3 inserts `recentScore`:

```typescript
return (
  right.matchStrength - left.matchStrength ||
  right.completionPriority - left.completionPriority ||
  right.recentScore - left.recentScore ||
  right.score - left.score ||
  left.start - right.start ||
  left.itemLength - right.itemLength ||
  left.originalIndex - right.originalIndex
);
```

Suggested `recentScore`:

```typescript
const RECENT_DECAY_MS = 10 * 60 * 1000;
const recentScore = count * 10 + Math.max(0, 10 - ageMs / RECENT_DECAY_MS);
```

When the query is empty (the user typed only `/`), recently-used commands are pinned to the top; when the query is non-empty, weighting applies only at equal match strength, to avoid recent commands overriding clearly more precise commands.

### 4.5 alias Hit Display

Aliases already participate in `AsyncFzf` and the prefix fallback, but `formatSlashCommandLabel()` always shows all aliases:

```text
help (?)
compress (summarize)
```

Phase 3 changes this to:

- When the user input hits the main name: do not show extra aliases, or keep the existing concise format
- When the user input hits an alias: show `help (alias: ?)`
- `Suggestion.matchedAlias` is written during the matching stage

Key implementation:

```typescript
function findMatchedAlias(
  cmd: SlashCommand,
  query: string,
): string | undefined {
  return cmd.altNames?.find((alt) =>
    alt.toLowerCase().startsWith(query.toLowerCase()),
  );
}
```

In FZF results, if `result.item` comes from `altNames`, it can be used directly as `matchedAlias`; the same applies in the prefix fallback.

---

## 5. Phase 3.2: mid-input slash command Full Version

### 5.1 Current Behavior

Currently `findMidInputSlashCommand()` only recognizes "a `/xxx` token separated by whitespace" and requires the cursor to be at the end of the token; `getBestSlashCommandMatch()` only does alphabetical prefix matching among `modelInvocable` commands.

This meets the Phase 2 basic goal, but Phase 3 needs to fill in display and highlighting.

### 5.2 ghost text Enhancement

Keep the current strategy: mid-input slash only suggests `modelInvocable` commands, because built-in commands in the body are not executed as slash commands.

Enhancements:

- Change the matching algorithm from alphabetical prefix to reusing the ordering rules of `useSlashCompletion` (at least considering `completionPriority` and recently used)
- Extend the return structure to:

```typescript
export type BestSlashCommandMatch = {
  suffix: string;
  fullCommand: string;
  command: SlashCommand;
  sourceBadge?: string;
  argumentHint?: string;
};
```

### 5.3 mid-input source badge and argument hint

Because the ghost text position has limited space, we do not recommend stuffing the badge and hint directly into the ghost text body. Suggested display rules:

- ghost text still only renders the command name suffix; for example, typing `please /rev` shows `iew`
- When the token already fully matches a command and the command has an `argumentHint`, show a dim argument hint after the cursor, e.g. `/review [pr-number] [--comment]`
- source badge is shown only in the dropdown or status hint; if mid-input does not pop a dropdown, the badge does not have to be shown

### 5.4 Valid Command Token Highlighting

Borrowing Claude Code's `findSlashCommandPositions()`, color the valid slash command tokens in the body within `InputPrompt.renderLineWithHighlighting()`.

Suggested new helper function:

```typescript
export type SlashCommandToken = {
  start: number;
  end: number;
  commandName: string;
  valid: boolean;
};

export function findSlashCommandTokens(
  text: string,
  commands: readonly SlashCommand[],
): SlashCommandToken[];
```

Rules:

- A token must be at the start of the string or preceded by whitespace
- A token has the form `/[a-zA-Z][a-zA-Z0-9:_-]*`
- For mid-input highlighting, only `modelInvocable` commands are deemed valid
- For line-start tokens, all interactive visible commands can be deemed valid
- Valid tokens use the accent color; invalid tokens keep plain text, to avoid mislabeling a path like `/usr/bin` as a command

---

## 6. Phase 3.3: Help Directory Refactor

### 6.1 Current Problems

`Help.tsx` currently outputs:

- Basics
- A flat `Commands:`
- `[MCP]` explanation
- Keyboard Shortcuts

Problems:

- All sources are mixed together; skill, custom, plugin, and MCP are hard to distinguish
- Does not show `argumentHint`
- Does not show `supportedModes`
- Does not show `modelInvocable`
- Subcommands are only indented one level, without showing source/mode

### 6.2 Grouping Design

Group by `source` / `sourceLabel`:

1. **Built-in Commands**: `source === 'builtin-command'`
2. **Bundled Skills**: `source === 'bundled-skill'`
3. **Custom Commands**: `source === 'skill-dir-command'`, including `Custom` / `User` / `Project`
4. **Plugin Commands**: `source === 'plugin-command'`, including `Plugin:*` / `Extension:*`
5. **MCP Commands**: `source === 'mcp-prompt'`
6. **Other Commands**: compatibility fallback for missing source

Within each group, sort by command name; hidden commands are not shown.

### 6.3 Display Fields Per Command

Suggested format:

```text
/model [--fast] [<model-id>]  Switch model
  source: Built-in  modes: interactive, non_interactive, acp

/review [pr-number] [--comment]  Review changed code
  source: Skill  modes: interactive, non_interactive, acp  model: yes
```

To avoid Help being too wide, we suggest compressing to a single line:

```text
 /review [pr-number] [--comment] [Skill] [all] [model] - Review changed code
```

Suggested mode badges:

| supportedModes                      | badge            |
| ----------------------------------- | ---------------- |
| `interactive` only                  | `[interactive]`  |
| `interactive, non_interactive, acp` | `[all]`          |
| `non_interactive, acp`              | `[headless]`     |
| other combinations                  | `[i] [ni] [acp]` |

### 6.4 Whether `/help` Extends to headless

The roadmap only requires `/help` to output grouped by source; it does not explicitly require non-interactive/acp. Currently `/help` is `supportedModes: ['interactive']`.

Phase 3 suggests adding a headless path, but as an independent subtask:

- Change `supportedModes` to all modes
- interactive: continue rendering `HistoryItemHelp`
- non_interactive/acp: return a plain-text grouped directory as `message`

If scope needs to be reduced, we can first refactor only the interactive `Help` component and defer headless `/help`.

---

## 7. Phase 3.4: ACP available commands Metadata Enhancement

### 7.1 Current ACP Output

`Session.sendAvailableCommandsUpdate()` currently maps `SlashCommand[]` to:

```typescript
{
  name: cmd.name,
  description: cmd.description,
  input: cmd.argumentHint ? { hint: cmd.argumentHint } : null,
}
```

Here `argumentHint` is already exposed through `input.hint`.

### 7.2 Enhancement Plan

If the `AvailableCommand` type of the ACP protocol cannot have fields added directly, use `_meta` to maintain compatibility:

```typescript
const availableCommands: AvailableCommand[] = slashCommands.map((cmd) => ({
  name: cmd.name,
  description: cmd.description,
  input: cmd.argumentHint ? { hint: cmd.argumentHint } : null,
  _meta: {
    argumentHint: cmd.argumentHint,
    source: cmd.source,
    sourceLabel: cmd.sourceLabel,
    supportedModes: cmd.supportedModes ?? getEffectiveSupportedModes(cmd),
    subcommands: cmd.subCommands
      ?.filter((sub) => !sub.hidden)
      .map((sub) => sub.name),
    modelInvocable: cmd.modelInvocable === true,
  },
}));
```

If the `AvailableCommand` type allows extending fields, prefer emitting them as first-class fields:

```typescript
{
  name,
  description,
  input,
  argumentHint,
  source,
  supportedModes,
  subcommands,
  modelInvocable,
}
```

But we still suggest keeping the `_meta` mirror for a while, to ease gradual migration of older clients.

### 7.3 subcommands Recursion Strategy

The acceptance criteria only require a `subcommands` name list. Emitting first-level subcommands in the first iteration is sufficient:

```typescript
subcommands: cmd.subCommands?.map((sub) => sub.name) ?? [];
```

Later, if ACP clients need a multi-level tree, it can be extended to:

```typescript
type AcpSubcommandMeta = {
  name: string;
  description?: string;
  argumentHint?: string;
  subcommands?: AcpSubcommandMeta[];
};
```

---

## 8. Phase 3.5: Filling in Claude Code Missing Commands

### 8.1 `/doctor`: Already Implemented, Not Reimplemented

The current `doctorCommand` already exists:

- File: `packages/cli/src/ui/commands/doctorCommand.ts`
- Registration: `BuiltinCommandLoader`
- Modes: `['interactive', 'non_interactive', 'acp']`
- interactive: shows `HistoryItemDoctor`
- non_interactive/acp: returns JSON `message`
- Diagnostic logic: `packages/cli/src/ui/commands/doctorChecks.ts`

Phase 3 only needs to correctly show the source and mode for `/doctor` in Help and completion; if optimization is desired, the headless JSON can be changed to more human-readable Markdown, but this is not required.

### 8.2 `/release-notes`: Not Included in This Phase

`/release-notes` is no longer a Phase 3 requirement. This phase adds no command, registers no built-in, and writes no related tests, avoiding introducing a command surface with no clear product need.

---

## 9. Conflict Strategy Confirmation and Display

The current `CommandService` conflict strategy:

- If an extension/plugin command has the same name as an existing command, it is renamed to `extensionName.commandName`
- If there is a second conflict, a numeric suffix is appended: `extensionName.commandName1`
- For same-named non-extension commands, the later-loaded overrides the earlier-loaded

Phase 3 does not change execution semantics; it only clearly shows the final name and source in Help/Completion.

We suggest adding tests to ensure:

- A renamed plugin command shows its final name and the `[Plugin]` badge in completion
- Help shows the final name under the Plugin Commands group
- ACP output uses the final name

> The roadmap's priority of "built-in > bundled/skill-dir > plugin > mcp" does not fully match the current implementation's "later-loaded non-extension overrides earlier-loaded". The Phase 3 doc takes the current `CommandService` source as authoritative and does not change conflict semantics in this phase; if a strict priority adjustment is needed, it should be handled as a separate Phase to avoid altering the existing user/project command override behavior.

---

## 10. Testing Strategy

### 10.1 Completion Tests

Update or add:

- `packages/cli/src/ui/hooks/useSlashCompletion.test.ts`
- `packages/cli/src/ui/hooks/useCommandCompletion.test.ts`
- `packages/cli/src/ui/components/SuggestionsDisplay.test.tsx` (add if no file currently exists)

Cover:

- source badge: Skill/Custom/Plugin/MCP shown correctly
- argumentHint: hint shown after the command name, and column width does not break the description
- recently used: recent commands rank first when typing only `/`; exact matches take priority when an explicit query is typed
- alias hit: typing `?` shows `help (alias: ?)`; typing `he` does not show an alias-hit hint
- mid-input ghost: body `/rev` suggests the modelInvocable `/review` suffix
- mid-input does not suggest built-in: body `/sta` does not suggest `/stats` (unless a future design allows embedded built-in execution)

### 10.2 Help Tests

Update: `packages/cli/src/ui/components/Help.test.tsx`

Cover:

- Grouped by Built-in/Bundled Skills/Custom/Plugin/MCP
- hidden commands not shown
- Subcommands shown as a name list
- `argumentHint`, source badge, mode badge, model badge appear correctly
- altNames can still be shown but do not interfere with the main command name

### 10.3 ACP Tests

Update: `packages/cli/src/acp-integration/session/Session.test.ts`

Cover:

- `availableCommands[].input.hint` keeps existing behavior
- New metadata includes `argumentHint`, `source`, `sourceLabel`, `supportedModes`, `subcommands`, `modelInvocable`
- Commands without `argumentHint` keep `input: null` for compatibility
- `getAvailableCommands(config, signal, 'acp')` calls remain unchanged

### 10.4 New Command Tests

This phase adds no `/release-notes` or other built-in commands, so no new command tests are needed. We only keep the existing regression tests for `/doctor`.

### 10.5 E2E Test Plan

Phase 3 modifies TUI completion, slash command execution, and ACP command metadata simultaneously; unit tests cannot cover the full user path. E2E verification is done in four categories:

1. **Build the local CLI**: First run `npm run build && npm run bundle`, then use `node dist/cli.js` to verify the local implementation.
2. **Interactive / tmux scenarios**: Used to verify TUI behaviors such as the completion menu, ghost text, Tab acceptance, and Help rendering.
3. **Headless / JSON scenarios**: Used to verify non-interactive slash command output, independent of the TUI.
4. **ACP integration scenarios**: Used to verify `available_commands_update` metadata.

#### 10.5.1 E2E Prerequisites

```bash
npm run build && npm run bundle
```

For interactive scenarios, we suggest using a separate temporary directory to avoid polluting the current repo:

```bash
tmux new-session -d -s qwen-slash-phase3 -x 200 -y 50 \
  "cd /tmp/qwen-slash-phase3 && /Users/mochi/code/qwen-code-test/dist/cli.js --approval-mode yolo"
sleep 3
```

When sending input, split the text and Enter to avoid the TUI swallowing the submission:

```bash
tmux send-keys -t qwen-slash-phase3 "/help"
sleep 0.5
tmux send-keys -t qwen-slash-phase3 Enter
```

Capture output:

```bash
tmux capture-pane -t qwen-slash-phase3 -p -S -100
```

Cleanup:

```bash
tmux kill-session -t qwen-slash-phase3
```

#### 10.5.2 E2E Test Checklist

| Scenario                      | Mode             | Steps                                                                                  | Expected Result                                                                                                                                       |
| ----------------------------- | ---------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| completion source badge       | interactive/tmux | Type `/`, observe the completion menu                                                  | skill/custom/plugin/MCP commands show the corresponding source badge; built-in may omit the badge                                                     |
| completion argument hint      | interactive/tmux | Type `/model`, `/export`                                                               | `argumentHint` shown after the command name; commands with no parameters do not show a noisy hint                                                     |
| recently used ordering        | interactive/tmux | First run `/help`, then type `/`                                                       | `/help` appears first under equal match conditions; an exact query still prioritizes matching the query                                               |
| alias hit display             | interactive/tmux | Type `/?`                                                                              | The completion item shows `help (alias: ?)`; typing `/he` does not falsely show an alias hit                                                          |
| mid-input ghost text          | interactive/tmux | Type `please /rev` in the body                                                         | The `/review` ghost text suffix appears, and Tab can accept it                                                                                        |
| mid-input token highlight     | interactive/tmux | Type body containing `/review`                                                         | Valid model-invocable slash tokens use command highlighting; a path like `/usr/bin` is not highlighted as a command                                   |
| Help grouped directory        | interactive/tmux | Run `/help`                                                                            | Output includes the Built-in Commands, Bundled Skills, Custom Commands, Plugin Commands, and MCP Commands groups; each command shows source/mode/hint |
| `/doctor` headless regression | headless/json    | Run `node dist/cli.js "/doctor" --approval-mode yolo --output-format json 2>/dev/null` | Returns `message` without triggering a TUI-only component error                                                                                       |
| ACP metadata                  | integration      | Run an ACP session and trigger `available_commands_update`                             | Each command keeps `name`, `description`, `input.hint`, and includes `argumentHint`, `source`, `supportedModes`, `subcommands`, `modelInvocable`      |

#### 10.5.3 Headless Command Examples

`/release-notes` is not included in this phase; the headless regression only keeps verification of existing commands such as `/doctor`.

### 10.6 Regression Test Commands

Per AGENTS.md, prefer running single-file tests:

```bash
cd packages/cli && npx vitest run src/ui/hooks/useSlashCompletion.test.ts
cd packages/cli && npx vitest run src/ui/hooks/useCommandCompletion.test.ts
cd packages/cli && npx vitest run src/ui/components/Help.test.tsx
cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts
```

Final verification:

```bash
npm run build && npm run typecheck
npm run build && npm run bundle
```

---

## 11. Acceptance Criteria

### 11.1 Completion Menu

- [ ] The completion menu shows source badges (at least `[MCP]`, `[Skill]`, `[Custom]`, `[Plugin]`)
- [ ] The completion menu shows `argumentHint`
- [ ] Recently-used commands within the session appear first when typing only `/`
- [ ] On an alias hit, show `alias: <alias>`; non-alias hits do not show noise
- [ ] Commands renamed after a plugin/extension conflict show their final name and source in completion

### 11.2 mid-input slash

- [ ] Ghost text is correctly suggested when typing a model-invocable command like `/review` in the body
- [ ] Tab can accept the mid-input ghost text
- [ ] Valid mid-input slash command tokens are highlighted
- [ ] Built-in commands are not falsely suggested as executable embedded commands in the body
- [ ] The argument hint is shown when the command matches fully and has no args

### 11.3 Help

- [ ] `/help` shows commands grouped by source
- [ ] Each command shows its name, `argumentHint`, description, source, and supportedModes markers
- [ ] Model-invocable commands have a clear marker
- [ ] Subcommands are shown as a name list or indented items
- [ ] hidden commands are not shown

### 11.4 ACP

- [ ] ACP `available_commands_update` continues to include `name`, `description`, `input.hint`
- [ ] ACP command metadata includes `argumentHint`, `source`, `supportedModes`, `subcommands`, `modelInvocable`
- [ ] Older clients are unaffected when they ignore the new fields

### 11.5 Missing Commands

- [ ] `/doctor` is still usable, and non-interactive returns `message`
- [ ] No `/release-notes` is added; the docs, tests, and acceptance criteria no longer require that command

---

## 12. Non-Goals

The following are not included in Phase 3:

- Do not implement new Loaders for workflow command / dynamic skill / mcp skill
- Do not introduce persistent command usage tracking
- Do not change the model invocation protocol of `SkillTool`
- Do not change the model invocation path of MCP prompts
- Do not refactor the command executor or mode adapter
- Do not change the existing user/project command override semantics

---

## 13. Suggested Implementation Order

1. **Completion data structure and badge/hint display**: First extend `Suggestion` and `SuggestionsDisplay`; low risk and intuitive feedback.
2. **Add built-in `argumentHint`**: Lets the existing ghost text and ACP `input.hint` benefit immediately.
3. **recently used ordering**: Introduce the recent score in `useSlashCompletion` and add tests.
4. **alias hit display**: Adjust FZF/prefix matching to preserve `matchedAlias`.
5. **Help tabbed refactor**: Provide clear panels like General / Commands / Custom Commands in Claude Code style, avoiding a command dump.
6. **ACP metadata enhancement**: Extend `Session.sendAvailableCommandsUpdate()` while keeping `_meta` compatibility.
7. **mid-input highlight enhancement**: Handle the rendering layer last, to avoid making the change too large alongside completion logic.
