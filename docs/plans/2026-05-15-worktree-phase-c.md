# Worktree Phase C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session persistence, hooksPath initialization, Footer status display, and an exit dialog for worktrees, so that a worktree can be restored after `--resume` and the user always knows which isolated environment they are in.

**Architecture:** Add a `WorktreeSession` sidecar JSON file (coexisting with the JSONL session file); `EnterWorktree` writes it and `ExitWorktree` clears it. The CLI layer watches the file for changes via a `useWorktreeSession` hook and syncs it into `UIState.activeWorktree`; the Footer reads that field and renders a built-in worktree row; `WorktreeExitDialog` intercepts the second Ctrl+C when an active worktree is detected.

**Tech Stack:** TypeScript, React (Ink), Node.js `fs.watch`, `simple-git`, Vitest

---

## File Structure

| Operation | File                                                         | Description                                                                                  |
| --------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Create    | `packages/core/src/services/worktreeSessionService.ts`       | WorktreeSession interface + read/write/clear functions                                       |
| Create    | `packages/core/src/services/worktreeSessionService.test.ts`  | Unit tests                                                                                   |
| Modify    | `packages/core/src/services/sessionService.ts`               | Add the `getWorktreeSessionPath()` public method                                             |
| Modify    | `packages/core/src/services/gitWorktreeService.ts`           | Append `core.hooksPath` configuration after `createUserWorktree()` / `createAgentWorktree()` |
| Modify    | `packages/core/src/services/gitWorktreeService.test.ts`      | hooksPath tests                                                                              |
| Modify    | `packages/core/src/tools/enter-worktree.ts`                  | Write WorktreeSession after creating the worktree                                            |
| Modify    | `packages/core/src/tools/enter-worktree.test.ts`             | session write test                                                                           |
| Modify    | `packages/core/src/tools/exit-worktree.ts`                   | Clear WorktreeSession after exiting the worktree                                             |
| Modify    | `packages/core/src/tools/exit-worktree.test.ts`              | session clear test                                                                           |
| Create    | `packages/cli/src/ui/hooks/useWorktreeSession.ts`            | Watch the sidecar file and return the current WorktreeSession                                |
| Modify    | `packages/cli/src/ui/contexts/UIStateContext.tsx`            | Add the `activeWorktree` field                                                               |
| Modify    | `packages/cli/src/ui/AppContainer.tsx`                       | Sync `activeWorktree`, inject resume context, intercept exit                                 |
| Modify    | `packages/cli/src/ui/hooks/useStatusLine.ts`                 | Add the `worktree` field to `StatusLineCommandInput`                                         |
| Modify    | `packages/cli/src/ui/components/Footer.tsx`                  | Built-in worktree row display                                                                |
| Create    | `packages/cli/src/ui/components/WorktreeExitDialog.tsx`      | Exit-prompt dialog                                                                           |
| Create    | `packages/cli/src/ui/components/WorktreeExitDialog.test.tsx` | Component test                                                                               |
| Modify    | `packages/cli/src/ui/components/DialogManager.tsx`           | Register WorktreeExitDialog                                                                  |

---

## Task 1: WorktreeSession sidecar storage

**Files:**

- Create: `packages/core/src/services/worktreeSessionService.ts`
- Create: `packages/core/src/services/worktreeSessionService.test.ts`
- Modify: `packages/core/src/services/sessionService.ts`

- [ ] **Step 1: Create `worktreeSessionService.ts`**

```typescript
// packages/core/src/services/worktreeSessionService.ts
import * as fs from 'node:fs/promises';
import { isNodeError } from '../utils/errors.js';

export interface WorktreeSession {
  slug: string;
  worktreePath: string;
  worktreeBranch: string;
  originalCwd: string;
  originalBranch: string;
  /** HEAD commit SHA at the moment the worktree was created. Used by WorktreeExitDialog to count new commits. */
  originalHeadCommit: string;
}

export async function readWorktreeSession(
  filePath: string,
): Promise<WorktreeSession | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as WorktreeSession;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeWorktreeSession(
  filePath: string,
  session: WorktreeSession,
): Promise<void> {
  await fs.mkdir(require('node:path').dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
}

export async function clearWorktreeSession(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// packages/core/src/services/worktreeSessionService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readWorktreeSession,
  writeWorktreeSession,
  clearWorktreeSession,
  type WorktreeSession,
} from './worktreeSessionService.js';

const sample: WorktreeSession = {
  slug: 'my-feature',
  worktreePath: '/repo/.qwen/worktrees/my-feature',
  worktreeBranch: 'worktree-my-feature',
  originalCwd: '/repo',
  originalBranch: 'main',
};

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-session-test-'));
  filePath = path.join(tmpDir, 'test.worktree.json');
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('readWorktreeSession', () => {
  it('returns null when file does not exist', async () => {
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('reads back what was written', async () => {
    await fs.writeFile(filePath, JSON.stringify(sample), 'utf-8');
    expect(await readWorktreeSession(filePath)).toEqual(sample);
  });
});

describe('writeWorktreeSession', () => {
  it('writes a readable JSON file', async () => {
    await writeWorktreeSession(filePath, sample);
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(sample);
  });

  it('overwrites existing file', async () => {
    await writeWorktreeSession(filePath, sample);
    const updated = { ...sample, slug: 'updated' };
    await writeWorktreeSession(filePath, updated);
    expect(await readWorktreeSession(filePath)).toEqual(updated);
  });
});

describe('clearWorktreeSession', () => {
  it('deletes the file', async () => {
    await writeWorktreeSession(filePath, sample);
    await clearWorktreeSession(filePath);
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('is a no-op when file does not exist', async () => {
    await expect(clearWorktreeSession(filePath)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
cd packages/core
npx vitest run src/services/worktreeSessionService.test.ts
```

Expected: `FAIL` — the module does not exist.

- [ ] **Step 4: Fix the require call in `writeWorktreeSession`**

`worktreeSessionService.ts` uses `path.dirname`, so `node:path` needs to be imported at the top of the file:

```typescript
// Replace "require('node:path').dirname(filePath)" with a proper import
import * as path from 'node:path';

export async function writeWorktreeSession(
  filePath: string,
  session: WorktreeSession,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
}
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
cd packages/core
npx vitest run src/services/worktreeSessionService.test.ts
```

Expected: `PASS` — 6 tests passed.

- [ ] **Step 6: Add `getWorktreeSessionPath()` to `SessionService`**

In `packages/core/src/services/sessionService.ts`, find the `private getChatsDir()` method (around line 180) and add after it:

```typescript
getWorktreeSessionPath(sessionId: string): string {
  return path.join(this.getChatsDir(), `${sessionId}.worktree.json`);
}
```

- [ ] **Step 7: Type check**

```bash
cd packages/core
npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/services/worktreeSessionService.ts \
        packages/core/src/services/worktreeSessionService.test.ts \
        packages/core/src/services/sessionService.ts
git commit -m "feat(worktree): add WorktreeSession sidecar storage"
```

---

## Task 2: hooksPath post-creation setup

**Files:**

- Modify: `packages/core/src/services/gitWorktreeService.ts:1133-1158` (`createUserWorktree`)
- Modify: `packages/core/src/services/gitWorktreeService.test.ts`

- [ ] **Step 1: Write the failing test**

In `gitWorktreeService.test.ts`, find the `createUserWorktree` test group and add:

```typescript
it('configures core.hooksPath to main repo after creation', async () => {
  const result = await service.createUserWorktree('hooks-test');
  expect(result.success).toBe(true);

  const worktreePath = result.worktree!.path;
  const worktreeGit = simpleGit(worktreePath);
  const hooksPath = await worktreeGit.raw([
    'config',
    '--local',
    'core.hooksPath',
  ]);
  // Should point to the main repo's .git/hooks
  expect(hooksPath.trim()).toContain('.git/hooks');
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd packages/core
npx vitest run src/services/gitWorktreeService.test.ts -t "configures core.hooksPath"
```

Expected: `FAIL` — hooksPath is empty.

- [ ] **Step 3: Append hooksPath configuration in `createUserWorktree`**

In `gitWorktreeService.ts`, find the spot after the `git worktree add` call inside `createUserWorktree` (around line 1140), and before `return { success: true, worktree }` add:

```typescript
// Configure hooksPath so commits inside this worktree run the main
// repo's hooks. Priority: .husky/ (common) → .git/hooks (fallback).
// Mirrors claude-code's performPostCreationSetup() logic.
try {
  const huskyPath = path.join(this.sourceRepoPath, '.husky');
  const gitHooksPath = path.join(this.sourceRepoPath, '.git', 'hooks');
  let hooksPath: string | null = null;
  for (const candidate of [huskyPath, gitHooksPath]) {
    try {
      await fs.stat(candidate);
      hooksPath = candidate;
      break;
    } catch {
      // Not found — try next.
    }
  }
  if (hooksPath) {
    const worktreeGit = simpleGit(worktreePath);
    // Skip the subprocess if core.hooksPath is already set to the same value
    // (~14ms spawn overhead per claude-code's comment on parseGitConfigValue).
    let existing = '';
    try {
      existing = (
        await worktreeGit.raw(['config', '--local', 'core.hooksPath'])
      ).trim();
    } catch {
      // Key not set — empty string means "proceed".
    }
    if (existing !== hooksPath) {
      await worktreeGit.raw(['config', 'core.hooksPath', hooksPath]);
    }
  }
} catch (hookError) {
  debugLogger.warn(
    `createUserWorktree: failed to set core.hooksPath: ${hookError}`,
  );
  // Non-fatal: worktree is usable, just without inherited hooks.
}
```

`this.sourceRepoPath` is a private field assigned in the `GitWorktreeService` constructor (`this.sourceRepoPath = path.resolve(sourceRepoPath)`, around line 224). Confirm that `import * as fs from 'node:fs/promises'` is already present at the top of the file.

- [ ] **Step 4: Make the same change to `createAgentWorktree`**

Find the `createAgentWorktree` method and add the same hooksPath code block after its `git worktree add` (the full code is identical to Step 3, with `slug` coming from the agent worktree's parameters).

- [ ] **Step 5: Run the test to confirm it passes**

```bash
cd packages/core
npx vitest run src/services/gitWorktreeService.test.ts -t "configures core.hooksPath"
```

Expected: `PASS`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/gitWorktreeService.ts \
        packages/core/src/services/gitWorktreeService.test.ts
git commit -m "feat(worktree): configure core.hooksPath after worktree creation"
```

---

## Task 3: EnterWorktreeTool writes WorktreeSession

**Files:**

- Modify: `packages/core/src/tools/enter-worktree.ts`
- Modify: `packages/core/src/tools/enter-worktree.test.ts`

- [ ] **Step 1: Write the failing test**

After the successful-creation case in `enter-worktree.test.ts`, add:

```typescript
import { readWorktreeSession } from '../services/worktreeSessionService.js';

it('writes WorktreeSession sidecar after creating worktree', async () => {
  // Arrange: use the existing test setup that creates a real git repo
  // and invokes the tool (copy from existing "custom name" test)
  const result = await invokeTool(tool, { name: 'session-test' });
  expect(result.error).toBeUndefined();

  const sessionPath = config
    .getSessionService()
    .getWorktreeSessionPath(config.getSessionId());
  const session = await readWorktreeSession(sessionPath);

  expect(session).not.toBeNull();
  expect(session!.slug).toBe('session-test');
  expect(session!.worktreePath).toContain('session-test');
  expect(session!.worktreeBranch).toBe('worktree-session-test');
  expect(session!.originalCwd).toBeTruthy();
  expect(session!.originalBranch).toBeTruthy();
  expect(session!.originalHeadCommit).toMatch(/^[0-9a-f]{7,40}$/);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd packages/core
npx vitest run src/tools/enter-worktree.test.ts -t "writes WorktreeSession"
```

Expected: `FAIL` — session file is null.

- [ ] **Step 3: Modify `enter-worktree.ts` to write the session after successful creation**

Add an import at the top of `enter-worktree.ts`:

```typescript
import { writeWorktreeSession } from '../services/worktreeSessionService.js';
```

In the `execute()` method, after obtaining baseBranch and before the `createUserWorktree()` call, first capture the current HEAD commit SHA:

```typescript
// Capture HEAD before branching — WorktreeExitDialog uses this to count
// new commits created inside the worktree (mirrors claude-code approach).
let originalHeadCommit = '';
try {
  originalHeadCommit = await service.getHeadCommit();
} catch {
  // Non-fatal.
}
```

Also add a public method to `GitWorktreeService` (in `gitWorktreeService.ts`, placed near `getCurrentBranch()`):

```typescript
async getHeadCommit(): Promise<string> {
  try {
    return (await this.git.raw(['rev-parse', '--short', 'HEAD'])).trim();
  } catch {
    return '';
  }
}
```

After the `writeWorktreeSessionMarker(...)` call, add:

```typescript
// Persist worktree session so --resume can restore context.
try {
  await writeWorktreeSession(
    this.config
      .getSessionService()
      .getWorktreeSessionPath(this.config.getSessionId()),
    {
      slug,
      worktreePath: result.worktree.path,
      worktreeBranch: result.worktree.branch,
      originalCwd: projectRoot,
      originalBranch: baseBranch ?? 'HEAD',
      originalHeadCommit,
    },
  );
} catch (error) {
  debugLogger.warn(`enter_worktree: failed to write session state: ${error}`);
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd packages/core
npx vitest run src/tools/enter-worktree.test.ts
```

Expected: all pass, no regressions.

- [ ] **Step 5: Type check**

```bash
cd packages/core && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/enter-worktree.ts \
        packages/core/src/tools/enter-worktree.test.ts
git commit -m "feat(worktree): persist WorktreeSession in EnterWorktreeTool"
```

---

## Task 4: ExitWorktreeTool clears WorktreeSession

**Files:**

- Modify: `packages/core/src/tools/exit-worktree.ts`
- Modify: `packages/core/src/tools/exit-worktree.test.ts`

- [ ] **Step 1: Write the failing test**

Add two cases to `exit-worktree.test.ts` (both keep and remove should clear the session):

```typescript
import {
  writeWorktreeSession,
  readWorktreeSession,
} from '../services/worktreeSessionService.js';

async function seedSession(cfg: Config, slug: string) {
  await writeWorktreeSession(
    cfg.getSessionService().getWorktreeSessionPath(cfg.getSessionId()),
    {
      slug,
      worktreePath: `/repo/.qwen/worktrees/${slug}`,
      worktreeBranch: `worktree-${slug}`,
      originalCwd: '/repo',
      originalBranch: 'main',
    },
  );
}

it('clears WorktreeSession after keep', async () => {
  await seedSession(config, 'exit-keep-test');
  // Create the worktree first so exit_worktree can find it
  await config.getWorktreeService().createUserWorktree('exit-keep-test');
  await invokeTool(tool, { name: 'exit-keep-test', action: 'keep' });

  const sessionPath = config
    .getSessionService()
    .getWorktreeSessionPath(config.getSessionId());
  expect(await readWorktreeSession(sessionPath)).toBeNull();
});

it('clears WorktreeSession after remove', async () => {
  await seedSession(config, 'exit-remove-test');
  await config.getWorktreeService().createUserWorktree('exit-remove-test');
  await invokeTool(tool, { name: 'exit-remove-test', action: 'remove' });

  const sessionPath = config
    .getSessionService()
    .getWorktreeSessionPath(config.getSessionId());
  expect(await readWorktreeSession(sessionPath)).toBeNull();
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd packages/core
npx vitest run src/tools/exit-worktree.test.ts -t "clears WorktreeSession"
```

Expected: `FAIL`.

- [ ] **Step 3: Modify `exit-worktree.ts`**

Add an import at the top:

```typescript
import { clearWorktreeSession } from '../services/worktreeSessionService.js';
```

Find the return path for `action === 'keep'` (around lines 184-196) and, before `return { llmContent: ..., returnDisplay: ... }`, add:

```typescript
try {
  await clearWorktreeSession(
    this.config
      .getSessionService()
      .getWorktreeSessionPath(this.config.getSessionId()),
  );
} catch (error) {
  debugLogger.warn(`exit_worktree: failed to clear session state: ${error}`);
}
```

Find the success return path for `action === 'remove'` (after the `removeUserWorktree` call) and likewise add the same `clearWorktreeSession` call block.

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd packages/core
npx vitest run src/tools/exit-worktree.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/exit-worktree.ts \
        packages/core/src/tools/exit-worktree.test.ts
git commit -m "feat(worktree): clear WorktreeSession in ExitWorktreeTool"
```

---

## Task 5: useWorktreeSession hook + UIState.activeWorktree

**Files:**

- Create: `packages/cli/src/ui/hooks/useWorktreeSession.ts`
- Modify: `packages/cli/src/ui/contexts/UIStateContext.tsx`
- Modify: `packages/cli/src/ui/AppContainer.tsx`

- [ ] **Step 1: Add the `activeWorktree` field to `UIStateContext.tsx`**

Find the `UIState` interface (around line 85) and, near `branchName: string | undefined;`, add:

```typescript
activeWorktree: {
  slug: string;
  branch: string;
  path: string;
  originalCwd: string;
  originalBranch: string;
  originalHeadCommit: string;
} | null;
```

Find the initial value of UIState (usually at the UIState provider in `AppContainer.tsx`) or the `createContext` defaultValue, and add `activeWorktree: null`.

- [ ] **Step 2: Create `useWorktreeSession.ts`**

```typescript
// packages/cli/src/ui/hooks/useWorktreeSession.ts
import { useState, useEffect } from 'react';
import * as fs from 'node:fs';
import {
  readWorktreeSession,
  type WorktreeSession,
} from '@qwen-code/qwen-code-core';
import { useConfig } from '../contexts/ConfigContext.js';

export function useWorktreeSession(): WorktreeSession | null {
  const config = useConfig();
  const [session, setSession] = useState<WorktreeSession | null>(null);

  useEffect(() => {
    const sessionService = config.getSessionService();
    const sessionId = config.getSessionId();
    const filePath = sessionService.getWorktreeSessionPath(sessionId);

    let watcher: fs.FSWatcher | undefined;

    const load = async () => {
      try {
        const ws = await readWorktreeSession(filePath);
        setSession(ws);
      } catch {
        setSession(null);
      }
    };

    void load();

    try {
      watcher = fs.watch(filePath, () => void load());
    } catch {
      // File does not exist yet — watcher set up on next write event via load()
    }

    return () => {
      watcher?.close();
    };
  }, [config]);

  return session;
}
```

Note: `readWorktreeSession` and `WorktreeSession` need to be exported from `@qwen-code/qwen-code-core`, so a new export must also be added in `packages/core/src/index.ts`:

```typescript
export {
  readWorktreeSession,
  writeWorktreeSession,
  clearWorktreeSession,
  type WorktreeSession,
} from './services/worktreeSessionService.js';
```

- [ ] **Step 3: Use the hook in `AppContainer.tsx` to sync `activeWorktree`**

Add an import at the top of `AppContainer.tsx`:

```typescript
import { useWorktreeSession } from './hooks/useWorktreeSession.js';
```

Inside the `AppContainer` function body (near where `branchName` is used), add:

```typescript
const worktreeSession = useWorktreeSession();
```

In the value passed to `UIStateContext.Provider`, add:

```typescript
activeWorktree: worktreeSession
  ? {
      slug: worktreeSession.slug,
      branch: worktreeSession.worktreeBranch,
      path: worktreeSession.worktreePath,
      originalCwd: worktreeSession.originalCwd,
      originalBranch: worktreeSession.originalBranch,
      originalHeadCommit: worktreeSession.originalHeadCommit,
    }
  : null,
```

- [ ] **Step 4: Type check**

```bash
npm run typecheck
```

Run from the repository root (cross-workspace check). Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/worktreeSessionService.ts \
        packages/core/src/index.ts \
        packages/cli/src/ui/hooks/useWorktreeSession.ts \
        packages/cli/src/ui/contexts/UIStateContext.tsx \
        packages/cli/src/ui/AppContainer.tsx
git commit -m "feat(worktree): add useWorktreeSession hook and UIState.activeWorktree"
```

---

## Task 6: StatusLineCommandInput.worktree field + Footer worktree row

**Files:**

- Modify: `packages/cli/src/ui/hooks/useStatusLine.ts`
- Modify: `packages/cli/src/ui/components/Footer.tsx`

- [ ] **Step 1: Add the `worktree` field to `useStatusLine.ts`**

Find the `StatusLineCommandInput` interface (around line 21) and, after the `git?: { branch: string }` field, add:

```typescript
worktree?: {
  /** worktree slug (short name, e.g. "my-feature") */
  name: string;
  /** worktree physical path */
  path: string;
  /** git branch name (e.g. "worktree-my-feature") */
  branch: string;
  /** working directory before entering the worktree */
  original_cwd: string;
  /** branch before entering the worktree */
  original_branch: string;
};
```

The field names are kept consistent with claude-code so users can reuse statusline scripts between qwen-code and claude-code.

Find where the `input: StatusLineCommandInput` object is constructed in the `doUpdate` callback (around line 225) and, after `...(ui.branchName && { git: { branch: ui.branchName } })`, add:

```typescript
...(uiStateRef.current.activeWorktree && {
  worktree: {
    name: uiStateRef.current.activeWorktree.slug,
    path: uiStateRef.current.activeWorktree.path,
    branch: uiStateRef.current.activeWorktree.branch,
    original_cwd: uiStateRef.current.activeWorktree.originalCwd,
    original_branch: uiStateRef.current.activeWorktree.originalBranch,
  },
}),
```

Note: `UIState.activeWorktree` must also include the `originalCwd` and `originalBranch` fields (added in the AppContainer mapping in Task 5).

- [ ] **Step 2: Add the built-in worktree display row to `Footer.tsx`**

Import `useUIState` at the top of `Footer.tsx` (already present).

Find the `statusLineLines` rendering region (around lines 140-148):

```tsx
{
  statusLineLines.length > 0 &&
    !uiState.ctrlCPressedOnce &&
    !uiState.ctrlDPressedOnce &&
    statusLineLines.map((line, i) => (
      <Text key={`status-line-${i}`} dimColor wrap="truncate">
        {line}
      </Text>
    ));
}
```

Insert the worktree row before it (shown when `activeWorktree` is non-null and there is no user statusline):

```tsx
{
  uiState.activeWorktree &&
    !uiState.ctrlCPressedOnce &&
    !uiState.ctrlDPressedOnce &&
    statusLineLines.length === 0 && (
      <Text dimColor wrap="truncate">
        {`⎇ ${uiState.activeWorktree.branch} (${uiState.activeWorktree.slug})`}
      </Text>
    );
}
```

- [ ] **Step 3: Type check + build**

```bash
npm run typecheck && npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/ui/hooks/useStatusLine.ts \
        packages/cli/src/ui/components/Footer.tsx
git commit -m "feat(worktree): show active worktree in Footer and StatusLine payload"
```

---

## Task 7: --resume worktree context injection

**Files:**

- Modify: `packages/cli/src/ui/AppContainer.tsx:459-489`

- [ ] **Step 1: Inject a worktree context message into the resume path**

In `AppContainer.tsx`, find the resume path (around lines 459-489):

```typescript
const resumedSessionData = config.getResumedSessionData();
if (resumedSessionData) {
  const historyItems = buildResumedHistoryItems(resumedSessionData, config);
  historyManager.loadHistory(historyItems);
  // ...
}
```

Change it to:

```typescript
const resumedSessionData = config.getResumedSessionData();
if (resumedSessionData) {
  const historyItems = buildResumedHistoryItems(resumedSessionData, config);
  historyManager.loadHistory(historyItems);

  // If there is an active worktree session, inject a context reminder so
  // the model immediately knows to continue using the worktree path.
  const ws = await readWorktreeSession(
    config.getSessionService().getWorktreeSessionPath(config.getSessionId()),
  );
  if (ws) {
    // Verify the worktree directory still exists before treating it as active.
    const worktreeAlive = await fs
      .stat(ws.worktreePath)
      .then((s) => s.isDirectory())
      .catch(() => false);

    if (worktreeAlive) {
      historyManager.addItem(
        {
          type: MessageType.INFO,
          text:
            `[Resumed] Active worktree: "${ws.slug}" at ${ws.worktreePath} ` +
            `(branch: ${ws.worktreeBranch}). Continue using this path for all file operations.`,
        },
        Date.now(),
      );
    } else {
      // Stale sidecar — worktree was deleted externally, clean up.
      await clearWorktreeSession(
        config
          .getSessionService()
          .getWorktreeSessionPath(config.getSessionId()),
      );
    }
  }

  // ... rest of existing resume code (background agents, session name)
}
```

Add imports at the top of the file:

```typescript
import {
  readWorktreeSession,
  clearWorktreeSession,
} from '@qwen-code/qwen-code-core';
import * as fs from 'node:fs/promises';
```

(`fs` may already be imported; check and merge.)

- [ ] **Step 2: Type check**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/ui/AppContainer.tsx
git commit -m "feat(worktree): inject context message on --resume when worktree is active"
```

---

## Task 8: WorktreeExitDialog

**Files:**

- Create: `packages/cli/src/ui/components/WorktreeExitDialog.tsx`
- Create: `packages/cli/src/ui/components/WorktreeExitDialog.test.tsx`
- Modify: `packages/cli/src/ui/components/DialogManager.tsx`
- Modify: `packages/cli/src/ui/contexts/UIStateContext.tsx`
- Modify: `packages/cli/src/ui/AppContainer.tsx`

- [ ] **Step 1: Add dialog state to `AppContainer.tsx`**

Dialog states such as `showWelcomeBackDialog` are returned to AppContainer by their respective hooks and then passed into the Provider via the UIState value object. Use the same pattern for WorktreeExitDialog:

Add to the `AppContainer.tsx` function body:

```typescript
const [showWorktreeExitDialog, setShowWorktreeExitDialog] = useState(false);
```

Add to the UIState Provider's value object:

```typescript
showWorktreeExitDialog,
```

Add to the `UIState` interface (near the other dialog fields):

```typescript
showWorktreeExitDialog: boolean;
```

- [ ] **Step 2: Write the failing component test**

```typescript
// packages/cli/src/ui/components/WorktreeExitDialog.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { WorktreeExitDialog } from './WorktreeExitDialog.js';

describe('WorktreeExitDialog', () => {
  it('shows loading state initially', () => {
    const { lastFrame } = render(
      <WorktreeExitDialog
        slug="my-feature"
        branch="worktree-my-feature"
        worktreePath="/tmp/repo/.qwen/worktrees/my-feature"
        originalHeadCommit="abc1234"
        onKeep={vi.fn()}
        onRemove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Should show loading spinner immediately before git status resolves
    expect(lastFrame()).toContain('Checking');
  });

  it('renders slug, branch, and options after loading (no changes)', async () => {
    // Use vi.mock to stub execFileNoThrow / execFile so git status returns empty
    // and rev-list returns "0". See existing dialog tests for the mock pattern.
    // After async effect resolves:
    //   - shows "my-feature" and "worktree-my-feature"
    //   - shows Keep and Remove options
    //   - shows "no uncommitted changes" or similar
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
cd packages/cli
npx vitest run src/ui/components/WorktreeExitDialog.test.tsx
```

Expected: `FAIL` — the module does not exist.

- [ ] **Step 4: Create `WorktreeExitDialog.tsx`**

Follow the RadioSelect pattern of `WelcomeBackDialog.tsx`, adding a dirty-state check on mount (aligned with the `loadChanges` logic in claude-code's `WorktreeExitDialog.tsx`):

```tsx
// packages/cli/src/ui/components/WorktreeExitDialog.tsx
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { execa } from 'execa';
import { RadioSelect } from '../shared/RadioSelect.js';
import type { RadioSelectItem } from '../shared/RadioSelect.js';
import { theme } from '../semantic-colors.js';

interface WorktreeExitDialogProps {
  slug: string;
  branch: string;
  worktreePath: string;
  originalHeadCommit: string;
  onKeep: () => void;
  onRemove: () => void;
  onCancel: () => void;
}

type Choice = 'keep' | 'remove' | 'cancel';

export const WorktreeExitDialog: React.FC<WorktreeExitDialogProps> = ({
  slug,
  branch,
  worktreePath,
  originalHeadCommit,
  onKeep,
  onRemove,
  onCancel,
}) => {
  const [loading, setLoading] = useState(true);
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
  const [commitCount, setCommitCount] = useState(0);
  const [selected, setSelected] = useState<Choice>('keep');

  useEffect(() => {
    async function loadDirtyState() {
      try {
        // Uncommitted changes (tracked + untracked)
        const { stdout: statusOut } = await execa(
          'git',
          ['status', '--porcelain'],
          { cwd: worktreePath },
        );
        const files = statusOut.split('\n').filter((l) => l.trim().length > 0);
        setChangedFiles(files);

        // New commits since worktree was created
        if (originalHeadCommit) {
          const { stdout: countOut } = await execa(
            'git',
            ['rev-list', '--count', `${originalHeadCommit}..HEAD`],
            { cwd: worktreePath },
          );
          setCommitCount(parseInt(countOut.trim(), 10) || 0);
        }
      } catch {
        // If git fails, show dialog without counts.
      } finally {
        setLoading(false);
      }
    }
    void loadDirtyState();
  }, [worktreePath, originalHeadCommit]);

  const options: Array<RadioSelectItem<Choice>> = [
    {
      key: 'keep',
      label: 'Keep worktree (exit without deleting)',
      value: 'keep',
    },
    {
      key: 'remove',
      label:
        changedFiles.length > 0 || commitCount > 0
          ? `Remove worktree and branch (discards ${commitCount} commit(s), ${changedFiles.length} file(s))`
          : 'Remove worktree and branch',
      value: 'remove',
    },
    { key: 'cancel', label: 'Cancel (stay in session)', value: 'cancel' },
  ];

  if (loading) {
    return (
      <Box marginY={1} paddingX={2}>
        <Text color={theme.text.secondary}>Checking worktree status…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1} paddingX={2}>
      <Text color={theme.status.warning}>
        {`Active worktree: "${slug}" (${branch})`}
      </Text>
      {(changedFiles.length > 0 || commitCount > 0) && (
        <Box flexDirection="column" marginBottom={1}>
          {commitCount > 0 && (
            <Text color={theme.text.secondary}>
              {`  ${commitCount} new commit(s) on ${branch}`}
            </Text>
          )}
          {changedFiles.length > 0 && (
            <Text color={theme.text.secondary}>
              {`  ${changedFiles.length} uncommitted file(s)`}
            </Text>
          )}
        </Box>
      )}
      <Text color={theme.text.secondary}>What would you like to do?</Text>
      <RadioSelect
        items={options}
        selectedValue={selected}
        onSelect={(value) => {
          if (value === 'keep') onKeep();
          else if (value === 'remove') onRemove();
          else onCancel();
        }}
        onChange={setSelected}
      />
    </Box>
  );
};
```

Note: `execa` is an existing project dependency (or use `execFileNoThrow`, following claude-code's approach). Check `packages/cli/package.json` to confirm the available exec utility; if `execa` is not present, use a wrapper around Node.js's built-in `execFile`.

- [ ] **Step 5: Run the test to confirm it passes**

```bash
cd packages/cli
npx vitest run src/ui/components/WorktreeExitDialog.test.tsx
```

Expected: the loading-state test passes.

- [ ] **Step 6: Register in `DialogManager.tsx`**

Find the last dialog rendering block in `DialogManager` and add:

```tsx
import { WorktreeExitDialog } from './WorktreeExitDialog.js';

// In the JSX returned by DialogManager, after the last dialog, add:
{
  uiState.showWorktreeExitDialog && uiState.activeWorktree && (
    <WorktreeExitDialog
      slug={uiState.activeWorktree.slug}
      branch={uiState.activeWorktree.branch}
      worktreePath={uiState.activeWorktree.path}
      originalHeadCommit={uiState.activeWorktree.originalHeadCommit}
      onKeep={() => {
        setShowWorktreeExitDialog(false);
        handleSlashCommand('/quit');
      }}
      onRemove={async () => {
        setShowWorktreeExitDialog(false);
        // Remove the worktree directly via service (no tool call needed).
        try {
          const svc = new GitWorktreeService(config.getTargetDir());
          await svc.removeUserWorktree(uiState.activeWorktree!.slug, {
            deleteBranch: true,
          });
          await clearWorktreeSession(
            config
              .getSessionService()
              .getWorktreeSessionPath(config.getSessionId()),
          );
        } catch {
          // Non-fatal — exit anyway.
        }
        handleSlashCommand('/quit');
      }}
      onCancel={() => {
        setShowWorktreeExitDialog(false);
      }}
    />
  );
}
```

`setShowWorktreeExitDialog` comes from the useState defined in AppContainer in Step 1; it needs to be passed in via props or directly at the DialogManager call site (follow the prop-passing pattern of the other dialogs).

- [ ] **Step 7: Intercept the second Ctrl+C in `AppContainer.tsx`**

In the `handleExit` callback (around line 2387), find the branch where `handleSlashCommand('/quit')` is called when `pressedOnce` is `true`:

```typescript
// Fast double-press: Direct quit (preserve user habit)
if (pressedOnce) {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
  }
  // Exit directly
  handleSlashCommand('/quit');
  return;
}
```

Change it to:

```typescript
if (pressedOnce) {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
  }
  // If inside a worktree, show the exit dialog instead of quitting directly.
  if (worktreeSession) {
    setShowWorktreeExitDialog(true);
    return;
  }
  handleSlashCommand('/quit');
  return;
}
```

`worktreeSession` is the return value of `useWorktreeSession()` from Step 1 (already in the AppContainer function body). Add it to the `useCallback` dependency array of `handleExit`. `setShowWorktreeExitDialog` comes from the useState in Step 1.

- [ ] **Step 9: Type check + full test suite**

```bash
npm run typecheck
cd packages/core && npx vitest run
cd packages/cli && npx vitest run
```

Expected: all pass, no regressions.

- [ ] **Step 10: Build**

```bash
npm run build && npm run bundle
```

Expected: `dist/cli.js` is generated without errors.

- [ ] **Step 11: Commit**

```bash
git add packages/cli/src/ui/components/WorktreeExitDialog.tsx \
        packages/cli/src/ui/components/WorktreeExitDialog.test.tsx \
        packages/cli/src/ui/components/DialogManager.tsx \
        packages/cli/src/ui/contexts/UIStateContext.tsx \
        packages/cli/src/ui/AppContainer.tsx
git commit -m "feat(worktree): add WorktreeExitDialog — intercept Ctrl+C when worktree is active"
```

---

## Acceptance Criteria

| Scenario                               | Expected behavior                                                           |
| -------------------------------------- | --------------------------------------------------------------------------- |
| After `enter_worktree` is called       | `<sessionId>.worktree.json` exists, containing slug / path / branch         |
| After `exit_worktree` is called        | `<sessionId>.worktree.json` is deleted                                      |
| Worktree still exists on `--resume`    | Footer shows the worktree row; an INFO message indicates the path           |
| Worktree already deleted on `--resume` | The sidecar file is cleaned up, no worktree row is shown                    |
| First Ctrl+C inside a worktree         | Shows "Press Ctrl+C again to exit."                                         |
| Second Ctrl+C inside a worktree        | Shows WorktreeExitDialog (keep / remove / cancel)                           |
| Second Ctrl+C outside a worktree       | Quits directly (behavior unchanged)                                         |
| Commit inside a new worktree           | `core.hooksPath` points to the main repo's hooks, pre-commit fires normally |
| statusline script stdin                | JSON payload contains `worktree.slug` and `worktree.branch`                 |
