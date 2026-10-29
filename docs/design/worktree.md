# Worktree General-Purpose Capability Design

## Problem Statement

qwen-code currently has only an internal worktree implementation (`GitWorktreeService`) aimed at the Arena multi-model comparison scenario. Users cannot use worktrees to isolate work in a normal session, and AgentTool does not support creating an isolated worktree environment for a subagent.

The goal is to turn worktrees into a general-purpose capability that supports user-session-level isolation and Agent-level isolation, while guaranteeing that the existing Arena experience remains completely unchanged.

## Current State Comparison

| Feature                                        | qwen-code      | claude-code | Phase   |
| ---------------------------------------------- | -------------- | ----------- | ------- |
| `EnterWorktree` tool                           | ✅ (Phase A)   | ✅          | —       |
| `ExitWorktree` tool                            | ✅ (Phase A)   | ✅          | —       |
| AgentTool `isolation: 'worktree'`              | ✅ (Phase B)   | ✅          | —       |
| Automatic cleanup of stale worktrees           | ✅ (Phase B)   | ✅          | —       |
| Worktree session state persistence and restore | ❌             | ✅          | Phase C |
| Post-creation setup (hooks config)             | ❌             | ✅          | Phase C |
| StatusLine worktree status display             | ❌             | ✅          | Phase C |
| WorktreeExitDialog (exit prompt)               | ❌             | ✅          | Phase C |
| `--worktree` CLI startup flag                  | ✅ (Phase D)   | ✅          | —       |
| Symlinked directories (node_modules, etc.)     | ✅ (Phase D)   | ✅          | —       |
| PR reference (`--worktree=#123`)               | ✅ (Phase D)   | ✅          | —       |
| sparse checkout                                | ❌             | ✅          | Future  |
| tmux integration                               | ❌             | ✅          | Future  |
| Arena multi-model worktree isolation           | ✅ (qwen only) | ❌          | —       |
| Dirty-state coverage (stash + copy)            | ✅             | ✅          | —       |
| Baseline commit tracking                       | ✅ (qwen only) | ❌          | —       |

## Design Principles

**A worktree is a general-purpose capability, and Arena is an application layered on top of it.**

- General worktree layer: `EnterWorktree`/`ExitWorktree` tools, the AgentTool `isolation` parameter, session state management, automatic cleanup
- Arena layer: multi-model parallel scheduling, the `worktreeBaseDir` custom path, batch creation and diff comparison; it continues to use the existing logic of `GitWorktreeService.setupWorktrees()` and is unaffected by changes to the general layer

AgentTool's `isolation: 'worktree'` only goes through the general path; Arena does not create worktrees via this parameter internally. The two paths are independent.

## Paths and Configuration

### General worktree path

Worktrees created by the `EnterWorktree` tool or by AgentTool `isolation: 'worktree'` are stored at a fixed location:

```
{git repo root}/.qwen/worktrees/{slug}
```

The path is not configurable. slug naming rules:

- User-session worktree: a user-specified name, or auto-generated (format: `{adjective}-{noun}-{4 random chars}`)
- Agent worktree: `agent-{7 random hex chars}`

### Arena worktree path (existing, unchanged)

Arena's worktree path is controlled by `agents.arena.worktreeBaseDir`, defaulting to `~/.qwen/arena` (`ArenaManager.ts:125`). It is completely independent of the general path and is left unchanged.

### Extended configuration

| Config item                       | Type       | Purpose                                                                                       | Phase   |
| --------------------------------- | ---------- | --------------------------------------------------------------------------------------------- | ------- |
| `ui.hideBuiltinWorktreeIndicator` | `boolean`  | Hide the built-in `⎇ worktree-… (…)` line in the Footer, leaving room for a custom statusline | Phase C |
| `worktree.symlinkDirectories`     | `string[]` | Symlink specified directories (e.g. `node_modules`) into the worktree to avoid disk waste     | Phase D |
| `worktree.sparsePaths`            | `string[]` | git sparse-checkout cone mode; for large monorepos, only write the specified paths            | Future  |

Phases A / B do not add any config items.

## Tool Design

### EnterWorktree

**Trigger condition:** The user explicitly says phrases like "start a worktree", "use a worktree", "create a worktree". It should not be triggered automatically when the user says "fix a bug" or "develop a feature".

**Input schema:**

```
name?: string  // optional, slug format: letters/digits/dot/underscore/dash, max 64 chars
```

**Behavior:**

1. Validate that we are not currently in a worktree (prevent nesting)
2. Resolve to the git repo root (handle the case of already being in a subdirectory)
3. Call `GitWorktreeService` to create the worktree, with path `.qwen/worktrees/{slug}`
4. Write the worktree session to `SessionService`
5. Switch the working directory to the worktree path
6. Clear the file cache

**Output:** `worktreePath`, `worktreeBranch`, `message`

### ExitWorktree

**Trigger condition:** The user says "exit the worktree", "leave the worktree", "go back", etc.

**Input schema:**

```
action: 'keep' | 'remove'
discard_changes?: boolean  // only valid when action='remove'
```

**Safety guards:**

- Only operate on the worktree created by `EnterWorktree` in this session
- When `action='remove'` and there are uncommitted changes, refuse to execute (unless `discard_changes: true`)

**Behavior:**

- `keep`: clear the worktree state in the session, retain the worktree directory and branch, restore the original working directory
- `remove`: delete the worktree directory, delete the corresponding git branch, clear the session state, restore the original working directory

**Output:** `action`, `originalCwd`, `worktreePath`, `worktreeBranch`

## User Trigger Methods

| Method                      | Example                                                                     | Implementation Phase |
| --------------------------- | --------------------------------------------------------------------------- | -------------------- |
| Explicit request in session | The user says "start working in a worktree" → the model calls EnterWorktree | Phase A              |
| Agent isolation             | The model sets `isolation: 'worktree'` for a subagent                       | Phase B              |
| CLI startup flag            | `qwen --worktree my-feature`                                                | Phase D              |

No slash commands. Triggering a worktree in a session relies on the user explicitly mentioning it; `isolation: 'worktree'` is the scenario where the model decides on its own.

## Phased Implementation Plan

### Phase A: Core tools (user-session-level worktree)

**Goal:** The user can enter / exit a worktree within a session.

**Features to implement:**

- `EnterWorktree` tool: create a worktree, switch the working directory, record session state
- `ExitWorktree` tool: keep / remove exit modes, safety guards
- `GitWorktreeService` extension: add `createUserWorktree()` / `removeUserWorktree()` methods aimed at single-user sessions, reusing the existing git operation logic without changing the batch interface used by Arena
- `SessionService` extension: add a `WorktreeSession` field recording `{ slug, worktreePath, worktreeBranch, originalCwd, originalBranch }`; restore the worktree working directory on `--resume`
- Tool prompts: write usage instructions for each tool, clarifying when to call and when not to call

**Affected files:**

| File                                               | Change type                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/core/src/tools/tool-names.ts`            | Add `ENTER_WORKTREE`, `EXIT_WORKTREE` constants                      |
| `packages/core/src/tools/EnterWorktreeTool/`       | New directory: `EnterWorktreeTool.ts`, `prompt.ts`                   |
| `packages/core/src/tools/ExitWorktreeTool/`        | New directory: `ExitWorktreeTool.ts`, `prompt.ts`                    |
| `packages/core/src/services/gitWorktreeService.ts` | Add user-session-level interfaces (no change to the Arena interface) |
| `packages/core/src/services/sessionService.ts`     | Add the `WorktreeSession` field and read/write methods               |
| `packages/core/src/tools/` registration entry      | Register the new tools                                               |

**Out of scope for Phase A:**

- Agent isolation (Phase B)
- Post-creation setup such as hooks config (Phase C)
- UI status display (Phase C)

---

### Phase B: Agent isolation (AgentTool `isolation: 'worktree'`) + description updates

**Goal:** The model can create a temporary isolated worktree for a subagent, which is cleaned up automatically after the agent finishes; meanwhile, update the affected tool descriptions and prompts.

**Features to implement:**

_Agent isolation core:_

- `AgentTool` adds an `isolation?: 'worktree'` parameter
- Create a temporary worktree when the agent starts (slug: `agent-{7hex}`, path: `.qwen/worktrees/agent-{7hex}`)
- After the agent finishes: if there are no changes, delete it automatically; if there are changes, retain it and return the path and branch in the result
- Automatic cleanup of stale worktrees: scan `.qwen/worktrees/`, match the `agent-{7hex}` pattern, and delete any older than 30 days with no unpushed commits, using a fail-closed strategy

_Description and prompt updates:_

- Supplement the `AgentTool` description with an explanation of the `isolation: 'worktree'` parameter (see claude-code `AgentTool/prompt.ts:272`)
- Add `buildWorktreeNotice()`: when a forked subagent runs in a worktree, inject a context hint into it stating that it is in an isolated worktree, that the path is inherited from the parent agent, and that it must re-read files before editing (see claude-code `forkSubagent.ts:buildWorktreeNotice`)

_No changes needed:_

- review skill (`SKILL.md`): review uses an independent mechanism (path `.qwen/tmp/review-pr-<n>`, created via the `qwen review fetch-pr` command), which is completely different from the general worktree path and mechanism, so there is no confusion

**Arena compatibility guarantee:** Arena does not create worktrees via the `isolation` parameter internally, so this change does not touch the Arena code path.

**Affected files:**

| File                                               | Change type                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/core/src/tools/agent/agent.ts`           | Add the `isolation` parameter and worktree creation/cleanup logic |
| `packages/core/src/tools/agent/fork-subagent.ts`   | Add `buildWorktreeNotice()` and inject it in worktree mode        |
| `packages/core/src/services/gitWorktreeService.ts` | Add `createAgentWorktree()` / `removeAgentWorktree()`             |
| `packages/core/src/services/worktreeCleanup.ts`    | New: automatic cleanup logic for stale worktrees                  |

---

### Phase C: Session completeness (SessionService persistence + UI safety net)

**Goal:** Worktree state is recoverable after a session is interrupted; the user always knows in the UI which worktree they are in; and there is a safety prompt when exiting the session.

**Features to implement:**

_SessionService worktree state persistence + `--resume` restore:_

- `SessionService` extends the `WorktreeSession` field, recording `{ slug, worktreePath, worktreeBranch, originalCwd, originalBranch }`
- `EnterWorktreeTool` calls `sessionService.setWorktreeSession()` to write the state
- `ExitWorktreeTool` calls `sessionService.clearWorktreeSession()` to clear the state
- The `--resume` startup path reads this field, restores `targetDir`, and injects a context hint into the model

_Post-creation setup:_

- After creating a worktree, automatically run `git config core.hooksPath <mainRepo>/.git/hooks` to ensure commits inside the worktree behave consistently with the main repo's hooks

_StatusLine worktree display:_

- `UIStateContext` adds an `activeWorktree` field (read from the session state), updated when the session enters / exits a worktree
- The `StatusLineCommandInput` payload adds a `worktree?: { slug: string; branch: string }` field for use by user statusline scripts
- The `Footer`, when `activeWorktree` is non-empty, displays a built-in `⎇ <branch> (<slug>)` line, providing basic visibility without the user needing to configure a statusline script

_WorktreeExitDialog:_

- Add a `WorktreeExitDialog.tsx` component, following the existing Dialog conventions
- Modify the exit-key (Ctrl+C / Ctrl+D) handling logic: when `activeWorktree` is detected as non-empty, intercept the second confirmation and show the Dialog prompting the user to choose keep or remove
- The keep / remove operations reuse the existing path of `ExitWorktreeTool`

**Affected files:**

| File                                                                  | Change type                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/core/src/services/sessionService.ts`                        | Add the `WorktreeSession` field and read/write methods                                |
| `packages/core/src/tools/enter-worktree.ts`                           | Call `sessionService.setWorktreeSession()`                                            |
| `packages/core/src/tools/exit-worktree.ts`                            | Call `sessionService.clearWorktreeSession()`                                          |
| `packages/core/src/services/gitWorktreeService.ts`                    | Append `core.hooksPath` config after `createUserWorktree()` / `createAgentWorktree()` |
| `packages/cli/src/ui/contexts/UIStateContext.tsx`                     | Add the `activeWorktree` field and set/clear actions                                  |
| `packages/cli/src/ui/hooks/useStatusLine.ts`                          | Add the `worktree` field to `StatusLineCommandInput`                                  |
| `packages/cli/src/ui/components/Footer.tsx`                           | Built-in worktree line display                                                        |
| `packages/cli/src/ui/components/WorktreeExitDialog.tsx`               | New                                                                                   |
| `packages/cli/src/ui/components/DialogManager.tsx`                    | Register `WorktreeExitDialog`                                                         |
| `packages/cli/src/ui/components/ExitWarning.tsx` or exit-key handling | Detect `activeWorktree` and intercept the exit                                        |

---

### Phase D: Startup configuration (`--worktree` CLI flag + directory symlinks + PR reference)

**Goal:** Support entering a worktree directly at startup, reduce disk overhead for large projects via directory symlinks, and quickly create a worktree based on a pull request via a PR reference.

**Scope:** The three features land together in one phase because they all hang off the same startup entry point, and both symlink / PR fetch need to run immediately after worktree creation — splitting them apart would repeatedly modify the bootstrap sequence.

#### D-1: `--worktree [name]` CLI startup flag

**Argument forms:** The yargs option accepts three forms:

| Form                      | Behavior                                                           |
| ------------------------- | ------------------------------------------------------------------ |
| `qwen --worktree`         | bare flag, auto-generate a slug (`{adjective}-{noun}-{6hex}`)      |
| `qwen --worktree my-name` | explicit slug, follows `EnterWorktreeTool`'s slug validation rules |
| `qwen --worktree=my-name` | equivalent to the previous one                                     |

No short alias `-w` is provided (qwen-code reserves short aliases only for the most frequently used arguments, to avoid naming conflicts).

**Startup sequence:** The worktree is created at the following point:

1. `parseArguments()` parses argv (existing)
2. resume picker (existing, line 588-629 of `gemini.tsx`)
3. `loadCliConfig()` initializes Config + auth (existing, line 643-653)
4. **New:** if `argv.worktree !== undefined`, call `createUserWorktree()`
   - write the sidecar (`writeWorktreeSession()`)
   - set `process.chdir(worktreePath)` and `Config.setTargetDir(worktreePath)`
   - re-attach path for the same worktree: skip `git worktree add` and chdir in place (Phase 6 fix). The cross-projectHash `--resume` × `--worktree` combination fails at the session lookup stage; see "Priority relative to `--resume`" below.
5. Main loop (all three entry points — TUI / headless `-p` / ACP — must go through step 4)

**Difference from the Phase A simplification:** Phase A's `EnterWorktreeTool` does **not** modify `Config.targetDir`; it relies on the model reading the absolute path from the tool result and continuing to use it. Phase D's CLI flag takes effect at startup, with no running model context to remain compatible with, so it **switches `targetDir` and `process.cwd()` directly** — this is a stronger isolation guarantee. The two paths behave differently and this needs to be explained in the user docs.

**Exit behavior:** Reuse the existing `WorktreeExitDialog` (implemented in Phase C). Triggering Ctrl+C/D twice → the user chooses between keep / remove / cancel. No new code path is needed.

**Priority relative to `--resume`:**

Because session storage is keyed by `projectHash(process.cwd())`, and `--worktree` chdir's into the worktree before the resume picker / `loadCliConfig`, "resuming, from inside worktree Y, a session that was started in worktree X" is **architecturally unreachable** (the two have different projectHashes, so the session files land in different directories). The table below reflects the actual behavior after the D-1 implementation + the Phase 6 re-attach fix:

| `--resume` state                 | `--worktree` state         | Result                                                                                      |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| none                             | none                       | Normal session, no worktree                                                                 |
| none                             | yes (new slug)             | Create a new worktree                                                                       |
| none                             | yes (existing slug)        | **re-attach** to the existing worktree (Phase 6 fix)                                        |
| yes                              | none                       | Restore the old worktree (Phase C behavior; if the sidecar hits, inject a reminder)         |
| yes (sid from the same worktree) | yes (same slug, re-attach) | re-attach + session hit: normal resume                                                      |
| yes (sid from the main checkout) | yes (any slug)             | **session lookup fails**: `No saved session found with ID …`, exit 1. documented limitation |
| yes (sid from worktree X)        | yes (slug Y, X != Y)       | Same as above; the session is cross-projectHash and unlookupable                            |

The semantics of cross-projectHash override (`--worktree` transferring a session between different worktrees / the main checkout) require storage to be anchored to the repo root rather than the cwd-derived projectHash, which falls under a future Config refactor. The `overrodeResumedWorktree` branch code inside `persistStartupWorktreeSidecar` is retained so that it can take effect automatically once that refactor lands; currently it is never triggered on the production path.

#### D-2: `worktree.symlinkDirectories` config item

**schema:**

```jsonc
{
  "worktree": {
    "symlinkDirectories": ["node_modules", "dist", ".turbo"],
  },
}
```

- Type: `string[]`, default `undefined` (off, opt-in)
- The top-level namespace `worktree` is new (inserted alphabetically between `tools` and `ui` in `settingsSchema.ts`)
- Paths are **relative to the main repo root**; absolute paths or paths containing `..` are rejected by the path-traversal guard

**Scope:** All worktrees created by the general layer, including:

- `EnterWorktreeTool` (Phase A)
- `AgentTool` `isolation: 'worktree'` (Phase B)
- the `--worktree` CLI flag (Phase D-1)

Arena's worktrees do not go through the general layer and are **not** affected by this config.

**Implementation location:** `GitWorktreeService.performPostCreationSetup()` — immediately following the existing `configureHooksPath()` (the pattern established in Phase C). Add a `symlinkConfiguredDirectories()` method that iterates the config items and calls `fs.symlink(absSource, absDest, 'dir')`.

**Error handling (fail-open):**

| Scenario                                     | Behavior                                          |
| -------------------------------------------- | ------------------------------------------------- |
| Source directory missing (ENOENT)            | Silently skip, debug log                          |
| Target path already exists (EEXIST)          | Silently skip, debug log (no overwrite)           |
| Path traversal (`../`, absolute paths, etc.) | Reject the item, debug log warn                   |
| Other I/O errors                             | debug log warn, continue with the remaining items |

Worktree creation itself **does not** abort because a symlink fails — the same "best-effort post-creation setup" principle as `configureHooksPath()`.

#### D-3: PR reference parsing (`--worktree=#<N>` / full URL)

**Supported forms:**

| Form                                                            | Parsed PR number |
| --------------------------------------------------------------- | ---------------- |
| `--worktree=#123`                                               | 123              |
| `--worktree '#123'`                                             | 123              |
| `--worktree https://github.com/foo/bar/pull/123`                | 123              |
| `--worktree https://gh.enterprise.com/foo/bar/pull/123?baz=qux` | 123              |

**slug and branch naming:**

- slug: `pr-<N>` (a special reserved prefix, to distinguish from user slugs)
- branch: `worktree-pr-<N>` (follows qwen-code's existing `worktree-<slug>` naming rule; does not adopt claude-code's direct `pr-<N>` naming, to avoid conflicting with a local `pr-<N>` branch)

**fetch strategy:**

```
git fetch origin pull/<N>/head
→ use FETCH_HEAD as the base for the new worktree
```

Does not depend on the `gh` CLI — pure git fetch, supporting any GitHub instance (public or enterprise), as long as the `origin` remote points at GitHub.

**Error paths:**

| Scenario                      | Error message                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `origin` remote missing       | `--worktree=#<N> requires an "origin" remote that points at GitHub.`                 |
| `git fetch` fails             | `Failed to fetch PR #<N>: PR may not exist or origin remote is unreachable.`         |
| Network timeout (30s)         | Same as above, with `(timeout)` appended                                             |
| `origin` remote is not GitHub | No active check; let `git fetch` fail naturally (the PR protocol is GitHub-specific) |

**Relationship to D-2:** PR worktrees **also** apply `symlinkDirectories` (the user expects to be able to run tests on the PR immediately, so dependency directories need to be reused).

#### Affected files

| File                                                         | Change type                                                                                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/config/config.ts`                          | yargs adds the `--worktree` option; the `CliArgs` interface adds `worktree?: string \| boolean`                                                           |
| `packages/cli/src/gemini.tsx`                                | Call the new `setupStartupWorktree()` helper after `loadCliConfig()` and before the main loop                                                             |
| `packages/cli/src/startup/worktreeStartup.ts`                | New: `setupStartupWorktree()` handles slug parsing, PR fetch, sidecar write, cwd switch                                                                   |
| `packages/cli/src/nonInteractiveCli.ts`                      | Reuse the same helper (the existing `restoreWorktreeContext` injection logic needs no change)                                                             |
| `packages/cli/src/acp-integration/acpAgent.ts`               | Reuse the same helper                                                                                                                                     |
| `packages/core/src/services/gitWorktreeService.ts`           | Add `parsePRReference()`, `fetchPullRequestRef()`, `symlinkConfiguredDirectories()`; `createUserWorktree()` accepts an optional `baseBranchRef` parameter |
| `packages/cli/src/config/settingsSchema.ts`                  | Add the top-level `worktree.symlinkDirectories: string[]` item                                                                                            |
| `packages/vscode-ide-companion/schemas/settings.schema.json` | Regenerate                                                                                                                                                |
| `docs/users/features/worktree.md`                            | Add a Quick Start CLI flag section and a new row to the Settings table                                                                                    |

#### Safety and Rollback

- **fail-open vs fail-close:** symlink / hooks failures do **not** abort worktree creation (same as the established Phase C pattern); a PR fetch failure **aborts** startup (without a base ref the worktree cannot be created); a slug validation failure **aborts** startup (consistent with `EnterWorktreeTool`).
- **path traversal:** Each `symlinkDirectories` item must still be inside `repoRoot` after resolution, otherwise the item is rejected and logged.
- **PR fetch timeout:** A 30-second hard timeout, to avoid an unresponsive network stalling startup.
- **Side effects of switching cwd:** After switching `process.cwd()`, the resolution of relative paths (e.g. `--prompt-file ./foo.txt`) is affected. **Countermeasure:** resolve all relative-path arguments before switching cwd (specifically, run a single normalize at the entry of `setupStartupWorktree()`).

#### Open Questions

1. **`--worktree-keep-on-exit`?** claude-code doesn't have it; does qwen-code need a CLI flag to make the Exit Dialog default to keep? Recommendation: **don't add it for now**, wait for user feedback.
2. **Does `worktree.symlinkDirectories` need a per-project override?** The current settings already support three-level user/workspace/project merging, so no special handling is needed.
3. **Should PR fetch pull the `merge` ref (`pull/<N>/merge`, i.e. the ref after merging with base) instead of `head`?** claude-code chooses `head`, on the grounds that users usually want to see the PR's actual changes. Follow this choice.

---

### Future: Advanced features (implemented on demand)

The following features target more specific use cases. They are not scheduled in the current phase and will be evaluated for implementation once user needs are clear.

| Feature                 | Description                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| sparse checkout         | A `worktree.sparsePaths` config item; for large monorepos, only checkout the specified paths to shorten creation time and disk usage |
| `.worktreeinclude` file | Automatically copy gitignored files (`.env`, `secrets.json`, etc.) into the worktree                                                 |
| tmux integration        | `--worktree --tmux` starts the worktree session in a new tmux window                                                                 |
