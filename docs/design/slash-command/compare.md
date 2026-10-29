# Qwen Code Command Module Refactoring Plan

## 1. Goal Definition

This plan takes the following principles as its sole premise:

- **The code architecture does not have to copy Claude Code verbatim**
- **But the core functionality, usage experience, and interaction experience of the command system must align 95% with Claude Code**

"Alignment" here refers to capabilities that users can directly perceive, including:

1. Command source coverage
2. Command help and discoverability
3. Command completion and the mid-input slash command experience
4. ACP / non-interactive availability
5. Model invocation capability for prompt command / skill

This refactoring is not about adding a few fields, nor about making minor tweaks to the existing `SlashCommand`. It is about upgrading the command module from an "interactive UI add-on capability" into a "unified command platform spanning interactive / ACP / non-interactive / model."

---

## 2. Conclusion After Rewriting

The problem with Qwen's existing command system is not that it has no capabilities at all, but that:

1. It is only relatively complete on the interactive main path
2. The type model is too thin to support a Claude-level product surface
3. ACP / non-interactive relies on an allowlist, making it extremely hard to extend
4. Command sources exist, but they do not form a unified mental model visible to users
5. The prompt command and model skill exposure systems are fragmented

Therefore the new plan must solve four things simultaneously:

1. **Fill in Claude Code's capability surface**
2. **Preserve the engineering advantage of Qwen's unified outcome model**
3. **Establish a unified registry / resolver / executor / adapter architecture**
4. **Let help, completion, ACP available commands, and documentation share the same set of metadata**

---

## 3. Refactoring Principles

### 3.1 Functional Alignment Takes Priority Over Implementation Alignment

Differences are allowed in:

- Internal class names
- Module decomposition approach
- Executor implementation
- effect / outcome structure

Differences are not allowed in:

- Significant shrinkage of command source coverage
- Significant shrinkage of command help and completion experience
- Significant shrinkage of ACP / non-interactive availability
- Significant shrinkage of the fusion between prompt command and model capabilities

When trade-offs arise, the priority order should be:

1. User experience alignment
2. Command capability coverage alignment
3. Mode consistency alignment
4. Internal implementation simplicity

### 3.2 Preserve Qwen's Unified Outcome Model

Mechanically copying Claude's execution implementation is not recommended.

Qwen's current unified outcome model is still worth keeping, because it is naturally suited to:

- UI takeover
- Approval / confirmation
- tool dispatch
- prompt submission
- Cross-mode adaptation

But it must be upgraded to carry Claude-level command capabilities, rather than continuing to exist as a simplified UI command framework.

### 3.3 Type, Source, Mode, and Visibility Must Be Thoroughly Decoupled

The new command model must at least separate the following dimensions:

1. **Type**: how the command executes
2. **Source**: where the command comes from
3. **Mode capability**: which runtime environments it is available in
4. **Visibility**: whether it is visible to the user or to the model

---

## 4. Claude Code Capability Surface to Align With

### 4.1 Command Types

Qwen needs to explicitly support three categories of commands:

1. `prompt`
2. `local`
3. `local-jsx`

### 4.2 Command Sources

Qwen's command schema must cover the following sources from phase one onward:

1. built-in commands
2. bundled skills
3. skill dir commands
4. workflow commands
5. plugin commands
6. plugin skills
7. dynamic skills
8. mcp prompts
9. mcp skills

We cannot fall back to "only support the few categories we already have" here.

### 4.3 Command Metadata

At least fill in the following fields:

1. `argumentHint`
2. `whenToUse`
3. `examples`
4. `sourceLabel`
5. `userFacingName`
6. `alias`
7. `immediate`
8. `isSensitive`
9. `userInvocable`
10. `modelInvocable`
11. `supportedModes`
12. `requiresUi`

### 4.4 Experience Capabilities

At least fill in the following experiences:

1. alias-hit completion
2. source badge
3. argument hints
4. recently used ordering
5. mid-input slash command detection and completion
6. command-directory-style Help
7. complete expression of ACP available commands

---

## 5. New Command Model

## 5.1 Core Structure

It is recommended to introduce a unified `CommandDescriptor` as the registration format for all commands.

It contains at least four parts:

1. `identity`
2. `metadata`
3. `capabilities`
4. `handler`

### `identity`

- `id`
- `name`
- `altNames`
- `canonicalPath`

### `metadata`

- `description`
- `argumentHint`
- `whenToUse`
- `examples`
- `group`
- `source`
- `sourceLabel`
- `userFacingName`
- `hidden`

### `capabilities`

- `type`: `prompt | local | local-jsx`
- `supportedModes`: `interactive | acp | non_interactive`
- `requiresUi`
- `supportsDialog`
- `supportsStreaming`
- `supportsToolInvocation`
- `supportsConfirmation`
- `remoteSafe`
- `readOnly`
- `immediate`
- `isSensitive`
- `userInvocable`
- `modelInvocable`

### `handler`

- `resolveArgs()`
- `execute()`
- `completion()`
- `fallback()`

---

## 5.2 Responsibilities of the Three Command Types

### `prompt`

Used for:

- skills
- file commands
- workflow prompt commands
- plugin skills
- mcp prompt / skill

Characteristics:

- Produces prompt / skill assets
- Supports interactive / ACP / non-interactive by default
- Can be invoked by the user and by the model

### `local`

Used for:

- query-type commands
- configuration-type commands
- headless-executable state-type commands
- the core execution entry point of most built-in commands

Characteristics:

- Does not depend on UI
- Should become the primary carrier type for ACP / non-interactive

### `local-jsx`

Used for:

- picker
- panels
- wizard
- interactive UI shell

Characteristics:

- Handles only interactive UI
- Can no longer be the sole execution entry point
- Must provide a fallback or a corresponding local subcommand

---

## 6. Command Source Model

## 6.1 External Source Model

This is the source model presented to users, and it must be as consistent as possible with Claude Code's mental model:

- `builtin-command`
- `bundled-skill`
- `skill-dir-command`
- `workflow-command`
- `plugin-command`
- `plugin-skill`
- `dynamic-skill`
- `builtin-plugin-skill`
- `mcp-prompt`
- `mcp-skill`

This set of fields will be used directly for:

- Help grouping
- Completion source badge
- ACP available commands
- Documentation export

## 6.2 Internal Normalized Model

To avoid being locked into external naming, add an additional layer of implementation fields internally:

- `providerType`
- `artifactType`
- `activationMode`
- `builtinProvided`
- `originPath`
- `namespace`

This allows:

- External experience to align with Claude
- Internal implementation to retain Qwen's maintainability

## 6.3 Conflict Strategy

Manage everything by a stable `id`, with the display name and input name separated:

1. `id`: stable unique identifier
2. `name`: primary input name
3. `userFacingName`: display name for help / completion

Recommended conflict priority:

1. built-in
2. bundled / skill-dir / workflow
3. plugin / builtin-plugin
4. dynamic
5. mcp in its own independent namespace

---

## 7. Unified Execution Architecture

## 7.1 `CommandRegistry`

Responsibilities:

1. Aggregate all loaders / providers
2. Build multi-dimensional indexes
3. Output help, completion, ACP, and documentation views
4. Provide independent views for user-visible commands and model-visible commands

Providers that must be supported:

1. `BuiltinCommandLoader`
2. `BundledSkillLoader`
3. `FileCommandLoader`
4. `McpPromptLoader`
5. `WorkflowCommandLoader`
6. `PluginCommandLoader`
7. `PluginSkillLoader`
8. `DynamicSkillProvider`
9. `BuiltinPluginSkillLoader`

Even if some providers are not fully implemented in the first iteration, the schema and API must support them up front.

## 7.2 `CommandResolver`

Responsibilities:

1. Parse slash commands
2. Resolve aliases
3. Resolve subcommand paths
4. Detect mid-input slash tokens
5. Output the canonical resolved command

## 7.3 `CommandExecutor`

Responsibilities:

1. Perform capability checks
2. Execute `prompt | local | local-jsx`
3. Produce a unified outcome
4. Handle fallback / unsupported

## 7.4 `ModeAdapter`

Three adapters must be split out:

1. `InteractiveModeAdapter`
2. `AcpModeAdapter`
3. `NonInteractiveModeAdapter`

This way the three modes can share the same command registry and executor, instead of each being hard-coded separately.

---

## 8. UI Command Refactoring Principle: Separate Core Commands from the Interaction Shell

This is the key to making ACP and non-interactive actually usable.

Any command that is essentially "open a dialog" today must be reshaped into:

1. one interactive shell
2. a set of local subcommands

### First Batch of Commands That Must Be Split

1. `/model`
2. `/permissions`
3. `/mcp`
4. `/resume`
5. `/hooks`
6. `/extensions`
7. `/agents`
8. `/approval-mode`

### Target Shape Examples

#### `/model`

- `/model`
- `/model show`
- `/model list`
- `/model set <id>`

#### `/permissions`

- `/permissions`
- `/permissions show`
- `/permissions set <mode>`
- `/permissions allow <tool>`
- `/permissions deny <tool>`

#### `/mcp`

- `/mcp`
- `/mcp list`
- `/mcp show <server>`
- `/mcp enable <server>`
- `/mcp disable <server>`

---

## 9. Unified Design for Prompt Command / Skill

This is a P0 of the refactoring, not a follow-up capability.

## 9.1 Goal

Establish a unified **Model-Invocable Prompt Command Registry** that merges the following assets into a single model-invocable view:

1. bundled skills
2. file commands
3. workflow prompt commands
4. plugin skills
5. mcp prompts / mcp skills

## 9.2 Key Fields

Must add:

1. `userInvocable`
2. `modelInvocable`
3. `allowedTools`
4. `whenToUse`
5. `argSchema` or a minimal parameter description
6. `contextMode: inline | fork`
7. `agent`
8. `effort`

## 9.3 Relationship with `SkillTool`

After the refactoring, `SkillTool` should no longer consume only narrowly defined skills.

It should be changed so that:

1. `CommandRegistry.getModelInvocablePromptCommands()` produces a unified view
2. `SkillTool`, or a future unified command tool, consumes that view
3. User slash commands and model skill invocation share the same pool of prompt-command assets

Only then can Qwen approach, in terms of experience, the way Claude handles capabilities like `/review`, `/commit`, and `/openspec-apply`.

---

## 10. Reworking Help / Completion / Discoverability

## 10.1 Completion

Completion items must at least display:

1. `label`
2. `description`
3. `argumentHint`
4. `sourceBadge`
5. `modeBadges`
6. `aliasHit`
7. `recentlyUsedScore`

Ordering must at least consider:

1. Exact match
2. alias match
3. Recently used
4. prefix match
5. fuzzy match

## 10.2 Mid-input slash command

Must fill in:

1. Detection of the slash token near the cursor
2. ghost text hints
3. Tab completion
4. Highlighting of valid command tokens

The first phase aligns the input experience first; whether to introduce stronger "embedded command execution semantics" can be left to later iterations.

## 10.3 Help

Help is no longer a flat list, but a complete command directory.

At least grouped into:

1. Built-in Commands
2. Bundled Skills
3. Skill Dir Commands
4. Workflow Commands
5. Plugin Commands
6. Plugin Skills
7. Dynamic Skills
8. Builtin Plugin Skills
9. MCP Commands / MCP Skills

Each command must at least display:

1. Name
2. Argument hint
3. Description
4. Source
5. Supported modes
6. Whether it is model-invocable
7. Subcommand summary

---

## 11. ACP / Non-Interactive Refactoring

## 11.1 Completely Abandon the Allowlist Approach

Old approach:

- built-in allowlist
- FILE / SKILL special-casing
- other result types unsupported

New approach:

- Each command declares its own capability
- The registry is responsible for filtering
- The adapter is responsible for execution and fallback

## 11.2 Outcome Support Goals

### interactive

- `submit_prompt`
- `message`
- `stream_messages`
- `tool`
- `dialog`
- `load_history`
- `confirm_action`
- `confirm_shell_commands`

### acp

- `submit_prompt`
- `message`
- `stream_messages`
- `tool`
- `confirm_action`
- `confirm_shell_commands`
- `dialog fallback`

### non_interactive

- `submit_prompt`
- `message`
- `stream_messages`
- `tool`
- `confirm_action`
- `confirm_shell_commands`
- `dialog fallback / structured failure`

## 11.3 ACP available commands Output

Must at least include:

1. `name`
2. `description`
3. `argumentHint`
4. `source`
5. `examples`
6. `supportedModes`
7. `interactiveOnly`
8. `subcommands`
9. `modelInvocable`

---

## 12. Documentation, Help, and Completion Share the Same Metadata

After the refactoring, the following must all be exported from the same registry view:

1. Help
2. Completion
3. ACP available commands
4. Documentation export

This is meant to solve the current problem of "implementation, help, and documentation being three inconsistent command surfaces."

---

## 13. Implementation Phasing

## Phase 1: Rebuild the Foundation

Deliverables:

1. New `CommandDescriptor`
2. Complete source schema
3. capability model
4. `userInvocable / modelInvocable`
5. `CommandRegistry`
6. `CommandResolver`
7. `CommandExecutor`
8. The three `ModeAdapter`s
9. `getModelInvocablePromptCommands()`

## Phase 2: Migrate Core Commands

Deliverables:

1. `/model`
2. `/permissions`
3. `/mcp`
4. `/resume`
5. `/hooks`
6. `/extensions`
7. `/agents`
8. `/approval-mode`

All of these commands must complete the "interactive shell + local subcommands" refactoring.

## Phase 3: Wire Up Model Capabilities

Deliverables:

1. `SkillTool` integrated with the unified registry view
2. file command / bundled skill / mcp prompt / plugin skill enter the unified model-invocable set
3. prompt command and skill assets fully unified

## Phase 4: Align the Experience Layer with Claude

Deliverables:

1. recently used ordering
2. source badge
3. argument hint
4. mode badge
5. complete help directory
6. mid-input slash command experience
7. automatic documentation export or validation

---

## 14. Acceptance Criteria

Once complete, the following must at least hold:

1. Help, completion, ACP, and documentation can all express the complete source model
2. Apart from pure UI shell commands, most built-in commands can be used in ACP / non-interactive
3. prompt command and model skill invocation use the same asset pool
4. The command experience reaches 95% of Claude Code's level in help, completion, source expression, argument hints, and mid-input experience
5. ACP / non-interactive command capability no longer relies on a built-in allowlist

---

## 15. Final Judgment

The essence of this refactoring is not "adding a few more fields to the existing SlashCommand," but:

- **Delivering, in Qwen's internal architectural style, a command platform whose external experience aligns 95% with Claude Code**

If a choice must be made between the two:

- Internal implementation that more closely resembles Claude
- External experience that more closely resembles Claude

This plan explicitly chooses the latter.
