# AutoSkill: Automatic Skill Extraction System Design Document

## Overview

This document describes the design for adding an **AutoSkill** capability on top of QwenCode's existing Memory-Dream architecture.

AutoSkill is a **procedural-memory auto-extraction mechanism**: after the agent completes a tool-call-intensive task, the system quietly evaluates in the background whether the current conversation contains a reusable workflow, and automatically saves it as a project-level skill.

### How It Differs in Scope from Memory Extract

| Dimension          | Memory Extract                                           | AutoSkill                                           |
| ------------------ | -------------------------------------------------------- | --------------------------------------------------- |
| **Memory type**    | Declarative memory (who the user is, project background) | Procedural memory (how to perform a class of tasks) |
| **Trigger timing** | After every session ends                                 | When in-session tool calls reach a threshold        |
| **Write target**   | `${projectRoot}/.qwen/memory/`                           | `${projectRoot}/.qwen/skills/`                      |
| **Content nature** | User preferences, project context, feedback rules        | Reusable operational steps, best practices          |
| **Lifecycle**      | Periodically consolidated/pruned by Dream                | Updated on demand, maintained by the review agent   |

---

## Core Design Principles

1. **No dedicated write tool**: the skill review agent directly uses the generic `read_file`, `write_file`, and `edit` tools to operate on `.qwen/skills/`, without introducing a dedicated `skill_manage` tool. The same applies to the main session—if the user wants to manually maintain skills, they also use the same generic tools.
2. **Skill-change detection instead of tool-count reset**: following the way memory extract detects `memory_tool` calls, the system detects whether any write operation in the main session lands under the `.qwen/skills/` directory. If so, it means the user has already actively operated on skills this round, and the automatic skill review is skipped when the session ends.
3. **`auto-skill` marker protects user-created skills**: skills created by the review agent must include a `source: auto-skill` marker in their YAML frontmatter. The skill review agent may only modify skills carrying this marker, and must not touch user-handcrafted skills.
4. **Triggered by tool-call density**: triggered only when the cumulative tool calls within the session reach ≥ 20, ensuring extraction happens only after genuinely complex tasks.
5. **Clear write-protection boundary**: the review agent's permission manager confines `write_file` and `edit` to within `${projectRoot}/.qwen/skills/`, and cannot touch the user / extension / bundled layers.
6. **Preserve the Hermes core prompt as much as possible**: the prompt used by the review agent is ported directly from Hermes's `_SKILL_REVIEW_PROMPT`, with only minimal adaptation.

---

## Architecture Changes

### 1. Counter: `toolCallCount` and Skill-Change Detection

Maintain two parallel tracking quantities in the session state:

**Tool-call counter** (decides whether to trigger skill review):

```
session start
  toolCallCount = 0

each tool call completes
  toolCallCount += 1

session end
  if (toolCallCount >= AUTO_SKILL_THRESHOLD):  // default 20
    check skillsModifiedInSession
    ├─ true  → skip (skill already manually operated this round, no auto review needed)
    └─ false → scheduleSkillReview()
```

**Skill-change detection** (replaces the old `skill_manage` call reset):

```
each tool call completes
  if (the tool call's target path is under ${projectRoot}/.qwen/skills/):
    skillsModifiedInSession = true
```

Detection logic: scan the file paths involved in the tool-call results and determine whether they land under the skills directory. The concrete implementation follows the pattern of `historyCallsSkillManage()`—iterate over the tool results in `history`, extract the target paths of write operations such as `write_file` and `edit`, and perform prefix matching.

> **Why skill-change detection instead of tool-name detection?**
> There is no longer a dedicated `skill_manage` tool; both the main session and the review agent use the generic `write_file`/`edit`. Therefore the detection dimension shifts from "was a particular dedicated tool called" to "is there a write operation landing in the `.qwen/skills/` directory", which is semantically more accurate: as long as the user has already actively operated on skill files this round, the automatic review is skipped.

> **Why tool-call count instead of conversation turns?**
> Tool-call count reflects task complexity—a single user message may trigger 1 or 30 tool calls. High tool density means more behaviors such as trial-and-error and strategy adjustment, and a higher probability of producing reusable experience. The threshold of 20 is more conservative than Hermes's 10, because QwenCode's tool-call granularity is usually finer (e.g., line-by-line `edit`).

### 2. Scheduling Point

The existing `MemoryManager` call point (session end) serves as the unified scheduling entry, extended to also schedule skill review simultaneously.

```
session end
  ├─ scheduleExtract(params)           // existing logic unchanged
  └─ scheduleSkillReview(params)       // new
       condition: toolCallCount >= AUTO_SKILL_THRESHOLD
             && !skillsModifiedInSession
```

extract and skill review are scheduled independently and run in parallel via `MemoryManager.track()`, without blocking each other.

### 3. Tool Access Permissions of the Skill Review Agent

The skill review agent **does not use** the dedicated `skill_manage` tool, but instead directly uses the generic file tools:

| Tool         | Purpose                                        | Scope restriction                                                                                       |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `read_file`  | Read existing skill content, check frontmatter | None                                                                                                    |
| `ls`         | Scan the `.qwen/skills/` directory structure   | None                                                                                                    |
| `write_file` | Create new skill files                         | Limited to within `${projectRoot}/.qwen/skills/`                                                        |
| `edit`       | Modify existing skill content                  | Limited to within `${projectRoot}/.qwen/skills/`, and the target file must contain `source: auto-skill` |
| `shell`      | Read-only commands (e.g., `cat`, `find`)       | Only read-only commands allowed (Shell AST static analysis)                                             |

**Additional constraint on `edit` (`auto-skill` protection)**:

Before executing `edit` or `write_file` (overwriting an existing file), the skill review agent's permission manager reads the target file's YAML frontmatter and checks the `source: auto-skill` field. If this field is absent, it rejects the write and returns an error:

```
skill_review_agent: edit is only allowed on skills with 'source: auto-skill' in frontmatter.
This skill appears to be user-created. Modify it manually or ask the user.
```

This check is implemented at the permission layer in `createSkillScopedAgentConfig`, rather than relying solely on the system prompt, ensuring that even if the model makes a mistake it will not overwrite user-handcrafted skills.

**Tool access in the main session**: the main agent does not restrict reads/writes to `.qwen/skills/`—the user can manage skills via normal `write_file`/`edit` commands. Such operations trigger `skillsModifiedInSession = true`, causing the automatic skill review to be skipped when the session ends.

### 4. Permission Sandbox: `SkillScopedPermissionManager`

Following `createMemoryScopedAgentConfig` in `extractionAgentPlanner.ts`, create a dedicated permission scope for the skill review agent:

```typescript
// operations the skill review agent is allowed
read_file:    no path restriction (needs to read arbitrary files to understand project context)
ls:           no path restriction
shell:        read-only commands (Shell AST static analysis, reusing the existing isShellCommandReadOnlyAST)
write_file:   only files under the ${projectRoot}/.qwen/skills/ path (create new skill)
edit:         only within ${projectRoot}/.qwen/skills/, and the target file contains source: auto-skill
```

**Implementation layers of `auto-skill` protection**:

1. **Permission-manager layer** (hard constraint): read frontmatter before `edit`; reject if `source: auto-skill` is absent
2. **System-prompt layer** (soft constraint): explicitly tell the agent it may only modify skills carrying the `source: auto-skill` marker
3. **Dual safeguard**: even if the system-prompt constraint is bypassed, the permission manager will intercept

---

## Skill Review Agent Design

### Trigger prompt (ported from Hermes, minimally adapted)

```
Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial
and error, or changing course due to experiential findings along the way, or did
the user expect or desire a different method or outcome? If a relevant skill
already exists and has 'source: auto-skill' in its frontmatter, update it with
what you learned. Otherwise, create a new skill if the approach is reusable.

IMPORTANT constraints:
- You may ONLY modify skill files that contain 'source: auto-skill' in their
  YAML frontmatter. Always read a skill file before editing it.
- Do NOT touch skills that lack this marker — they were created by the user.
- When creating a new skill, you MUST include 'source: auto-skill' in the
  frontmatter so future review agents can safely update it.
- Do NOT delete any skill. Only create or update.

If nothing is worth saving, just say 'Nothing to save.' and stop.

Skills are saved to the current project (.qwen/skills/).
Use write_file to create a new skill, edit to update an existing auto-skill.
Each skill lives at .qwen/skills/<name>/SKILL.md with YAML frontmatter:

---
name: <skill-name>
description: <one-line description>
metadata:
  source: auto-skill
  extracted_at: '<ISO-8601 timestamp>'
---

<markdown body with the procedure/approach>
```

### Agent Configuration

```typescript
{
  name: "managed-skill-extractor",
  tools: [
    "read_file",   // read existing skill content, check source: auto-skill
    "ls",          // scan the .qwen/skills/ directory
    "write_file",  // create new skill files (path restricted by permission manager)
    "edit",        // modify existing auto-skill (frontmatter validated by permission manager)
    "shell",       // read-only commands (e.g., find, cat)
  ],
  permissionManager: createSkillScopedAgentConfig(config, projectRoot),
  history: sessionHistory,  // pass in the full conversation history snapshot
}
```

---

## Integration with the Existing MemoryManager

### `ScheduleSkillReviewParams` (new type)

```typescript
export interface ScheduleSkillReviewParams {
  projectRoot: string;
  sessionId: string;
  history: Content[]; // full session history snapshot
  toolCallCount: number; // tool-call count for this session
  skillsModified: boolean; // whether any write operation landed in .qwen/skills/ this session
  config?: Config;
  enabled?: boolean;
  threshold?: number;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface SkillReviewScheduleResult {
  status: 'scheduled' | 'skipped';
  taskId?: string;
  skippedReason?: 'below_threshold' | 'skills_modified_in_session' | 'disabled';
}
```

### `MemoryManager.scheduleSkillReview()` (new method)

```typescript
scheduleSkillReview(params: ScheduleSkillReviewParams): SkillReviewScheduleResult {
  // 1. config gate
  if (params.enabled === false) {
    return { status: 'skipped', skippedReason: 'disabled' };
  }

  // 2. threshold check
  const threshold = params.threshold ?? AUTO_SKILL_THRESHOLD;
  if (params.toolCallCount < threshold) {
    return { status: 'skipped', skippedReason: 'below_threshold' };
  }

  // 3. skill already actively operated this round, skip auto review
  if (params.skillsModified) {
    return { status: 'skipped', skippedReason: 'skills_modified_in_session' };
  }

  // 4. independent scheduling
  const record = makeTaskRecord('skill-review', params.projectRoot, params.sessionId);
  const promise = this.track(record.id, this.runSkillReview(record, params));
  return { status: 'scheduled', taskId: record.id, promise };
}
```

### Task-Type Extension

```typescript
// extend the existing MemoryTaskRecord.taskType
export type MemoryTaskType = 'extract' | 'dream' | 'skill-review';

// constant
export const AUTO_SKILL_THRESHOLD = 20; // tool-call count threshold
```

---

## Data Flow

```
session in progress
  agent main loop
    ├─ each tool call → toolCallCount += 1
    └─ if a write operation's target path is under ${projectRoot}/.qwen/skills/
         → skillsModifiedInSession = true

session end (sessionEnd event)
  ├─ scheduleExtract(params)
  │     └─ [existing logic: fork extraction agent → write .qwen/memory/]
  │
  └─ toolCallCount >= 20 && !skillsModifiedInSession ?
       ├─ no → skip (insufficient density or skill already manually operated this round)
       └─ yes → scheduleSkillReview(params)
                 └─ independently fork the skill review agent
                        ↓
                 skill review agent (max 8 turns, 2 min, sandboxed permissions)
                 tools: read_file, ls, write_file, edit, shell
                 pass in the full sessionHistory
                        ↓
                 model judges whether there is a reusable approach
                 ├─ yes → read existing skill (check source: auto-skill)
                 │         → write_file to create a new skill (with source: auto-skill)
                 │         → edit to update an existing auto-skill
                 │         → SkillManager cache invalidation (notifyChangeListeners)
                 └─ no → "Nothing to save." end


next session
  SkillManager.listSkills({ level: 'project' })
  → scan .qwen/skills/ and discover the newly created skill
  → inject into the <available_skills> block of the system prompt (Tier 1)
```

---

## SKILL.md Format Convention (project-level)

Auto-extracted skills are written to `${projectRoot}/.qwen/skills/<name>/SKILL.md`, in a format fully compatible with the existing SkillManager:

```yaml
---
name: <skill-name> # required, lowercase letters + hyphens
description: <description> # required, ≤ 1024 characters
version: 1.0.0
metadata:
  source: auto-skill # required (forcibly written when the review agent creates the skill)
  extracted_at: '2026-04-24T12:00:00Z'
---
# <skill title>

<operational steps / best practices / caveats>
```

**Constraint semantics of `source: auto-skill`**:

| Marker value | Creator          | Skill review agent can modify?            | User can modify? |
| ------------ | ---------------- | ----------------------------------------- | ---------------- |
| `auto-skill` | review agent     | ✅ yes                                    | ✅ yes           |
| field absent | user-handcrafted | ❌ no (intercepted by permission manager) | ✅ yes           |

If the user adds `source: auto-skill` to a skill they created themselves, it signals permission for the review agent to automatically update it later.

---

## Security Considerations

| Risk                                                                    | Mitigation                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto-extraction overwrites a carefully written user skill               | The permission manager reads the frontmatter and rejects `edit` if `source: auto-skill` is absent; the system prompt also explicitly states only auto-skills may be modified |
| Unbounded skill growth                                                  | The review prompt explicitly requires "prefer updating existing skills"; updating an existing skill is preferred over creating a new one                                     |
| Writing to paths outside the project                                    | `write_file`/`edit` permissions are limited to within `${projectRoot}/.qwen/skills/`; `assertRealProjectSkillPath` rejects symlink traversal                                 |
| Extracting content carrying injection risk                              | Reuse the existing content-safety scanning logic                                                                                                                             |
| The review agent deleting a skill                                       | The review agent's toolset contains no delete operation (no `rm`, no `shell` write operations); the system prompt explicitly forbids deletion                                |
| Review still triggered after manual skill operation in the main session | `skillsModifiedInSession` detection: if there is a write operation landing in `.qwen/skills/` in the main session, skip the review                                           |
| Symlink traversal writing to files outside the skills directory         | `assertRealProjectSkillPath` (async): use `fs.realpath()` to resolve the real path and allow the write only after confirming it is within the real skills root               |

---

## Configuration Options

Add the following configuration options to the QwenCode config (optional, with default values):

```typescript
// new in config schema (under memory)
memory?: {
  enableAutoSkill?: boolean;   // default true
}
```

Corresponding QWEN.md / `~/.qwen/config.json` configuration example:

```json
{
  "memory": {
    "enableAutoSkill": true
  }
}
```

---

## E2E Test Checklist

After the feature is implemented, follow the procedure in `.qwen/skills/e2e-testing/SKILL.md`: first run `npm run build && npm run bundle`, then use the local build artifact `node dist/cli.js` for end-to-end verification.

### 1. Low tool-call density does not trigger

- Run headless mode using a temporary project directory.
- Configure `memory.enableAutoSkill: true`.
- Execute a simple task that requires only a few tool calls and end the session normally.
- Assert that `.qwen/skills/` has no newly added `source: auto-skill` skill; the JSON stream should contain no write operations to `.qwen/skills/`.

### 2. Skill review triggers after the threshold is reached

- Run headless mode using a temporary project directory (`AUTO_SKILL_THRESHOLD` is hardcoded to 20; it can be lowered in the test fixture).
- Send a task that requires multiple tool calls and contains a reusable workflow.
- Assert that a skill review is scheduled after the session ends; if the model judges it worth saving, `.qwen/skills/<name>/SKILL.md` is created and the frontmatter contains `source: auto-skill`.
- If the model judges `Nothing to save.`, assert that the flow ends normally with no permission errors.

### 3. Skip review after the main session operates on a skill

- Construct a session where, at the same time tool calls reach the threshold, a file under `.qwen/skills/` is written via `write_file` or `edit` (simulating the user manually managing skills).
- Assert that at session end `skillsModifiedInSession = true` and `scheduleSkillReview` returns `skippedReason: 'skills_modified_in_session'`.
- Assert that the review agent is not started, avoiding duplicate writes.

### 4. Write protection allows only project-level skills

- Through the skill review agent, attempt to write to a path outside the project, a user-level skill path, or a bundled skill path.
- Assert that the write is rejected and the error message points to only being able to write to `${projectRoot}/.qwen/skills/`.
- Assert that writing to `${projectRoot}/.qwen/skills/<name>/SKILL.md` is allowed.

### 5. `auto-skill` marker protects user-created skills

- Pre-place a user-created skill without `source: auto-skill` in `.qwen/skills/`.
- Trigger the skill review agent and steer the model to attempt to modify that skill.
- Assert that the write is rejected by the permission manager, with an error message explaining that the skill is not an auto-skill.
- Assert that a skill with `source: auto-skill` in the same directory can be updated normally.

### 6. Symlink traversal is rejected

- Create a symlink under `.qwen/skills/` pointing to a directory outside the project.
- Trigger the skill review agent to attempt to write to that symlink path.
- Assert that `assertRealProjectSkillPath` rejects the write and returns a `symlink traversal detected` error.

### 7. Config switch takes effect

- Configure `memory.enableAutoSkill: false`; it does not trigger even when the tool-call count exceeds the threshold.
- Verify that when enabled by default (`enableAutoSkill` unconfigured or `true`), it triggers normally once tool calls reach the threshold.

### 8. Local build artifact verification

- Following the e2e-testing skill, use headless JSON output:
  `node dist/cli.js "<prompt>" --approval-mode yolo --output-format json 2>/dev/null`.
- When necessary, add `--openai-logging --openai-logging-dir <tmp-dir>` to inspect the tool schema, prompt, and permission configuration in the request body.
- For scenarios involving TUI or sessionEnd-visible state, use the tmux interactive flow to capture the final output.

## Relationship to the Existing System

```
existing MemoryManager
  ├─ scheduleExtract()       ← unchanged
  ├─ scheduleDream()         ← unchanged
  ├─ recall()                ← unchanged
  ├─ forget()                ← unchanged
  └─ scheduleSkillReview()   ← new (this document)

existing SkillManager
  ├─ listSkills()            ← unchanged (auto-discovers new files under .qwen/skills/)
  └─ loadSkill()             ← unchanged

existing file tools (read_file / write_file / edit)
  ├─ in the main session: the user can manually manage skills via these tools
  │   └─ write operation lands in .qwen/skills/ → skillsModifiedInSession = true
  └─ in the skill review agent: used directly to create/update auto-skill
      └─ permission manager restricts the path + validates source: auto-skill

trigger point (existing sessionEnd hook)
  └─ calls scheduleExtract + scheduleSkillReview simultaneously (when conditions are met)
```

The read side of SkillManager (`listSkills`, `loadSkill`) needs no modification at all—after the review agent writes to `${projectRoot}/.qwen/skills/`, `SkillManager` automatically detects the change via its existing `chokidar` file watcher, calls `notifyChangeListeners()` to trigger a cache refresh, and the new skill naturally appears in the system prompt of the next conversation.
