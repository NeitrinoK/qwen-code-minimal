# Slash Command Refactor Roadmap

## Overall Goal

Using Qwen's internal architectural style, deliver a command platform whose external experience is 95% aligned with Claude Code, while fixing the three core problems: the three-mode split, the single command source, and prompt commands not being invocable by the model.

---

## Core Design Principles

1. **Each Phase can ship independently**: once complete, the behavior is self-consistent and does not depend on a future Phase to run.
2. **Phase 1 is pure infrastructure**: aside from fixing MCP_PROMPT being incorrectly blocked, it does not change any existing usable command set.
3. **Separate behavior changes from architecture changes**: Phase 1 does the architecture, Phase 2 does the capability expansion.
4. **Do not copy Claude Code's internal architecture wholesale**: but do align with the user-perceivable capability surface.

---

## Phase 1: Infrastructure Rebuild (pure architecture, zero behavior change)

### Goal

Establish a unified command metadata model and a cross-mode management mechanism, providing the underlying foundation for all subsequent Phases.

### Features

#### 1.1 Extend the `SlashCommand` metadata model

Add the following fields to the existing `SlashCommand` interface:

**Source fields**

- `source: CommandSource`: command source enum (`builtin-command` / `bundled-skill` / `skill-dir-command` / `plugin-command` / `mcp-prompt`, etc.)
- `sourceLabel?: string`: display source label (e.g. `"Built-in"` / `"MCP: github-server"`)

**Mode capability fields**

- `supportedModes: ExecutionMode[]`: declares which run modes it is available in (`interactive` / `non_interactive` / `acp`)

**Execution type field**

- `commandType: CommandType`: declares the execution type (`prompt` / `local` / `local-jsx`)

**Visibility fields**

- `userInvocable: boolean`: whether the user can invoke it via a slash command (default `true`)
- `modelInvocable: boolean`: whether the model can invoke it via a tool call (default `false`)

**Auxiliary metadata fields** (reserved for Phase 3; in Phase 1 only defined, not used)

- `argumentHint?: string`: argument hint, e.g. `"<model-id>"` / `"show|list|set"`
- `whenToUse?: string`: a description of when to invoke this command (for model use)
- `examples?: string[]`: usage examples

#### 1.2 Loaders populate the source/commandType fields

Each Loader must populate `source` and `commandType` when constructing a `SlashCommand`:

| Loader                             | source              | commandType                                      |
| ---------------------------------- | ------------------- | ------------------------------------------------ |
| `BuiltinCommandLoader`             | `builtin-command`   | declared by each command (`local` / `local-jsx`) |
| `BundledSkillLoader`               | `bundled-skill`     | `prompt`                                         |
| `FileCommandLoader` (user/project) | `skill-dir-command` | `prompt`                                         |
| `FileCommandLoader` (plugin)       | `plugin-command`    | `prompt`                                         |
| `McpPromptLoader`                  | `mcp-prompt`        | `prompt`                                         |

#### 1.3 Built-in commands declare `supportedModes` and `commandType`

Explicitly declare for all built-in commands:

- `commandType`: `local` (no UI dependency) or `local-jsx` (depends on dialog/React)
- `supportedModes`: `local`-type commands declare `['interactive', 'non_interactive', 'acp']`; `local-jsx`-type commands declare `['interactive']`

#### 1.4 Replace the hardcoded allowlist with capability-based filtering

- Remove the `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE` constant
- Remove the `filterCommandsForNonInteractive` function
- Add the `filterCommandsForMode(commands, mode)` function, which filters based on the `supportedModes` field
- Add the `getEffectiveSupportedModes(cmd)` utility function (accounting for the CommandKind default policy)
- Modify the `handleSlashCommand` / `getAvailableCommands` function signatures to remove the `allowedBuiltinCommandNames` parameter

#### 1.5 Upgrade CommandService into a unified Registry

- Add the `getCommandsForMode(mode: ExecutionMode)` method
- Add the `getModelInvocableCommands()` method (used by Phase 2/3; Phase 1 provides the interface)
- The existing `getCommands()` stays unchanged (used by interactive)

### Acceptance Criteria

- [ ] The `SlashCommand` interface includes all new fields, and TypeScript compiles.
- [ ] All Loaders populate the `source` and `commandType` fields.
- [ ] All built-in commands declare `commandType` and `supportedModes`.
- [ ] `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE` is removed and replaced by the capability filter.
- [ ] **The usable command set under non-interactive is exactly the same as before the refactor** (existing tests do not break).
- [ ] MCP prompt commands execute normally under non-interactive/acp (fixing the original incorrect restriction).
- [ ] `CommandService.getCommandsForMode('non_interactive')` returns the correct command set.
- [ ] All existing tests pass.

---

## Phase 2: Capability Expansion (command cleanup and prompt command model invocation)

### Goal

Building on the Phase 1 metadata foundation, expand the range of available commands across the three modes and open up the model-invocation path for prompt commands.

### Features

#### 2.1 Expand the non-interactive / acp usable command set

**ACP semantics design principles**

Before expanding a command to ACP/non-interactive mode, follow these design principles:

1. **The recipient is different**: in ACP mode, the message recipient is the IDE (Zed/VS Code plugin), not the terminal user. Message content is best in plain text or Markdown format, and should not contain terminal-specific ANSI styling.
2. **The implementation strategy is to add a mode branch, not to replace**: the correct approach is to add a mode check inside the command's `action`—the interactive path keeps the existing UI rendering logic unchanged, while the non_interactive/acp path returns a `message` or `submit_prompt` suitable for machine consumption. The two paths coexist within the same `action` function.
3. **Stateful operations need their semantics explained**: within a single non-interactive invocation (e.g. the CLI `-p` argument), changes from stateful commands like `/model set` and `/language set` are only effective within this session, which should be noted in the command response text.
4. **Read-only vs. side-effecting**: read-only commands (e.g. `/about`, `/stats`) directly return current-state text; side-effecting commands (e.g. `/model set`, `/language set`) need to confirm the operation result in the response.
5. **Avoid environment-dependent side effects**: operations that depend on a graphical environment, such as opening a browser (`/docs`, `/insight`) or manipulating the clipboard (`/copy`), should be skipped on the non_interactive/acp path and instead return the relevant URL or the content itself in the response text.

**Overview of commands to be expanded**

> Note: `btw`, `bug`, `compress`, `context`, `init`, `summary` were already expanded to all modes in Phase 1 and are not in this phase's list.

The following 13 commands will be expanded to `non_interactive` and `acp` mode in Phase 2:

**Class A: the action already returns `message` or `submit_prompt`; only need to extend `supportedModes` and design the ACP message content**

| Command       | Return type     | ACP/non-interactive handling notes                                                       |
| ------------- | --------------- | ---------------------------------------------------------------------------------------- |
| `/copy`       | `message`       | No clipboard under ACP; instead return the content itself or a hint in the response text |
| `/export`     | `message`       | Return the full path of the exported file                                                |
| `/plan`       | `submit_prompt` | No change needed; directly extend the mode                                               |
| `/restore`    | `message`       | Return a description of the restore operation result                                     |
| `/language`   | `message`       | Return the current language setting or change-confirmation text                          |
| `/statusline` | `submit_prompt` | No change needed; directly extend the mode                                               |

**Class A': executes normally when arguments are present, triggers a dialog when no arguments (needs a non-interactive handling path for the no-argument case)**

| Command          | No-argument interactive behavior | No-argument non_interactive/acp behavior              |
| ---------------- | -------------------------------- | ----------------------------------------------------- |
| `/model`         | Open the model selection dialog  | Return the current model name and descriptive text    |
| `/approval-mode` | Open the approval mode dialog    | Return the current approval mode and descriptive text |

**Class B: the action internally uses `context.ui.addItem()` to render a React component; needs a mode branch to return plain text**

| Command    | interactive behavior                     | non_interactive/acp return content                                                                                         |
| ---------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/about`   | Render version/config React component    | Plain-text summary of version number, current model, and key config                                                        |
| `/stats`   | Render token/cost statistics component   | Plain-text format of the session statistics                                                                                |
| `/insight` | Render analysis component + open browser | `non_interactive` synchronously generates and returns a file path; `acp` pushes progress and results via `stream_messages` |
| `/docs`    | Render docs entry + open browser         | Return the docs URL, do not open the browser                                                                               |

**Class C: special handling**

| Command  | interactive behavior                                    | non_interactive/acp behavior                                                                                            |
| -------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/clear` | Call `context.ui.clear()` to clear the terminal display | Return a context-boundary marker message, with content `"Context cleared. Previous messages are no longer in context."` |

#### 2.2 Open up prompt command model invocation

- In `CommandService` (or `CommandRegistry`), implement `getModelInvocableCommands()`, returning all commands with `modelInvocable: true`
- Mark commands loaded by `BundledSkillLoader` and `FileCommandLoader` (user/project commands) as `modelInvocable: true`
- **MCP prompts are not marked as `modelInvocable`**: MCP prompts are invoked by the model via the independent MCP tool call mechanism, without going through the `SkillTool` relay
- Refactor `SkillTool`: change from consuming only `SkillManager.listSkills()` to also consuming `CommandService.getModelInvocableCommands()`
- Build a unified model-invocable command description and inject it into the `SkillTool` description

#### 2.3 mid-input slash command detection (basic version)

- In `InputPrompt`, detect a slash token near the cursor (not limited to the start of a line)
- After detecting a slash token, suggest the best-matching command name via inline ghost text (Tab to accept)
- Does **not** include the dropdown completion menu, argument hints, source badge, etc. (Phase 3 does these)
- The ghost text candidate set is limited to `modelInvocable: true` commands (skill / file command)

### Acceptance Criteria

**2.1 Command expansion**

- [ ] Class A: `/copy`, `/export`, `/plan`, `/restore`, `/language`, `/statusline` execute normally and return meaningful text output under non-interactive and acp modes.
- [ ] Class A': `/model`, `/approval-mode` with no arguments return current-state text under non-interactive/acp (without triggering a dialog); with arguments they perform the change and return confirmation text.
- [ ] Class B: `/about`, `/stats`, `/docs` return plain text under non-interactive/acp, and `/docs` does not open the browser; `/insight` synchronously generates and returns a file path message under `non_interactive`, and pushes progress via `stream_messages` under `acp`.
- [ ] Class C: `/clear` returns a context-boundary marker message under non-interactive/acp and does not call `context.ui.clear()`.
- [ ] All expanded commands behave exactly the same as before the refactor under interactive mode (no regression).

**2.2 Model invocation**

- [ ] The model can invoke bundled skills and file commands (user/project) via `SkillTool` during a conversation.
- [ ] MCP prompts do not go through `SkillTool`; they are invoked natively by the model via the MCP tool call mechanism.
- [ ] The model cannot invoke built-in commands (`userInvocable: true`, `modelInvocable: false`).
- [ ] The `SkillTool` description includes the descriptions of all `modelInvocable` commands.

**2.3 mid-input slash**

- [ ] mid-input slash: after typing `/` within body text, the best-matching command is suggested via inline ghost text (Tab to accept).

---

## Phase 3: Experience Alignment (completion enhancements + Claude Code command parity)

### Goal

Building on the Phase 1/2 metadata and command capabilities, round out the completion experience and add the commands that exist in Claude Code but are missing in Qwen Code.

### Features

#### 3.1 Completion experience enhancements

**source badge**

- Display a command source label in the completion menu (`[MCP]` already exists, extend it to `[Skill]`, `[Custom]`, etc.)
- Render using the `source` / `sourceLabel` fields

**argument hint**

- Display the `argumentHint` after the command name in the completion menu (e.g. `set <model-id>`)
- `argumentHint` is provided by the Phase 1 metadata field

**recently used ordering**

- Record the commands the user has recently used (session level, no persistence needed)
- Weight recently used commands in the completion ordering

**alias hit highlighting**

- When a completion hits `altNames` rather than the primary name, note it in the display (e.g. `help (alias: ?)`)

**conflict policy alignment**

- Clarify the priority: built-in > bundled/skill-dir > plugin > mcp
- On conflict, rename the lower-priority command (e.g. `pluginName.commandName`)

#### 3.2 mid-input slash command full version

- On top of the Phase 2 basic version, add argument hints and source badge display
- ghost text suggestion (show the faded `/help` hint when typing `/he`)
- Valid command token highlighting (a completed-match slash command is shown in a different color)

#### 3.3 Help directory restructure

Change `/help` from a flat list to a grouped directory:

- **Built-in Commands** (local + local-jsx, with mode noted)
- **Bundled Skills**
- **Custom Commands** (user/project file commands)
- **Plugin Commands**
- **MCP Commands**

Each command displays: name, argumentHint, description, source, supportedModes marker

#### 3.4 ACP available commands metadata enhancement

In `sendAvailableCommandsUpdate()`, expose more metadata to the ACP client:

- `argumentHint`
- `source`
- `supportedModes`
- `subcommands` (name list)
- `modelInvocable`

#### 3.5 Claude Code missing command parity

Confirm and regression-test Qwen Code's existing `/doctor` command; `/release-notes` is not included in this phase, to avoid introducing a built-in command surface with no clear product need.

| Command   | Type    | Description                                                               |
| --------- | ------- | ------------------------------------------------------------------------- |
| `/doctor` | `local` | Environment self-check, outputs config/connection/tool status diagnostics |

> Note: `/commit` has landed as a built-in prompt command (see #4000); task-type commands like `/review` are still provided as bundled skills and are not listed here.

### Acceptance Criteria

- [ ] The completion menu displays source badges (`[MCP]`, `[Skill]`, `[Custom]`).
- [ ] The completion menu displays argumentHint (e.g. `set <model-id>`).
- [ ] Recently used commands appear first in the completion list.
- [ ] On an alias hit, the original name is noted in the completion item.
- [ ] mid-input slash: the ghost text suggestion renders correctly.
- [ ] `/help` is displayed Claude Code-style in tabs, avoiding command clutter, and shows the supported-modes marker on the command page.
- [ ] ACP available commands include the `argumentHint`, `source`, and `subcommands` fields.
- [ ] The `/doctor` command is available.
- [ ] `/doctor` is executable under non-interactive mode (returns a `message`).
- [ ] `/release-notes` is not added.

---

## Inter-Phase Dependencies

```
Phase 1 (metadata + unified filtering)
    │
    ├──► Phase 2 (capability expansion)
    │        │
    │        ├──► slash command subcommand split
    │        └──► prompt command model invocation (needs getModelInvocableCommands())
    │
    └──► Phase 3 (experience alignment)
             │
             ├──► source badge (needs the Phase 1 source field)
             ├──► argument hint (needs the Phase 1 argumentHint field)
             └──► Help grouping (needs the Phase 1 source field)
```

Phase 2 and Phase 3 do not depend on each other and can proceed in parallel (or have some sub-items swapped based on priority).
