---
name: superpowers:finishing-a-development-branch
description: 'Used when implementation is complete, all tests pass, and an integration decision needs to be made.'
user-invocable: true
metadata:
  source: obra/superpowers (adapted for qwen-code-minimal)
  original_repo: https://github.com/obra/superpowers
---

# Finishing a Development Branch

**Description:** Used when implementation is complete, all tests pass, and an integration decision needs to be made.

**Core principle:** Test check → Environment detection → Menu options → Execute choice → Cleanup.

## Announce at the Start

`"I'm using the finishing-a-development-branch skill to complete this work."`

---

## Process

### Step 1: Test Check

```bash
go test ./... -race -count=1
```

- **If tests fail:** Stop. Do not proceed to Step 2.
- **If tests pass:** Proceed to Step 2.

### Step 2: Detect Environment

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
```

| State                                         | Menu                 | Cleanup         |
| --------------------------------------------- | -------------------- | --------------- |
| `GIT_DIR == GIT_COMMON` (standard repository) | 4 options            | Not required    |
| `GIT_DIR != GIT_COMMON`, named branch         | 4 options            | Based on origin |
| `GIT_DIR != GIT_COMMON`, detached HEAD        | 3 options (no merge) | Not required    |

### Step 3: Determine Base Branch

```bash
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null
```

### Step 4: Present Options

**Standard repository/branch (exactly 4 options):**

```
Implementation complete. What would you like to do?
1. Merge back locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)
4. Discard this work
Which option?
```

**Detached HEAD (exactly 3 options):**

```
Implementation complete. You're on a detached HEAD (externally managed workspace).
1. Push as new branch and create a Pull Request
2. Keep as-is (I'll handle it later)
3. Discard this work
Which option?
```

### Step 5: Execute Choice

**Option 1: Local Merge**

```bash
cd "$(git rev-parse --show-toplevel)"
git checkout <base-branch> && git pull
git merge <feature-branch>
go test ./...                          # verify on the result
git worktree remove ".worktrees/<feature-branch>"  # from root
git branch -d <feature-branch>
```

**Option 2: Push and PR**

```bash
git push -u origin <feature-branch>
gh pr create --title "<title>" --body "## Summary
...
## Test Plan
- [ ] go test ./..."
```

_DO NOT clean up the worktree_ (the user needs to iterate on the feedback).

**Option 3: Keep**
`"Keeping branch <name>. Worktree preserved at <path>."`

**Option 4: Discard**
Exact confirmation: `Type 'discard' to confirm.`
→ `git worktree remove ...` → `git branch -D <feature-branch>`

### Step 6: Worktree Cleanup

Performed **only for Options 1 and 4**.

```bash
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"
git worktree remove "$WORKTREE_PATH"
git worktree prune
```

---

## Quick Reference

| Option         | Merge | Push | Preserve worktree | Delete branch |
| -------------- | ----- | ---- | ----------------- | ------------- |
| 1. Local Merge | ✅    | ❌   | ❌                | ✅            |
| 2. Create PR   | ❌    | ✅   | ✅                | ❌            |
| 3. Keep as-is  | ❌    | ❌   | ✅                | ❌            |
| 4. Discard     | ❌    | ❌   | ❌                | ✅ (force)    |

---

## Red Flags

**Never:**

- Merge without checking tests
- Delete work without `discard` confirmation
- Force-push without explicit request
- Clean up others' worktrees
- Run `git worktree remove` from inside the worktree being removed

**Always:**

- Check tests before presenting options
- Present exactly 4 options (or 3 for detached HEAD)
- Clean up worktree only for options 1 and 4
- `cd` to the main repository root before removing the worktree
