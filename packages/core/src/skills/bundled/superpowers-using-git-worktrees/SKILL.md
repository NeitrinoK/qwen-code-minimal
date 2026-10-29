---
name: superpowers:using-git-worktrees
description: 'Used when starting work on a feature requiring isolation from the current working area, or before executing implementation plans.'
user-invocable: true
metadata:
  source: obra/superpowers (adapted for qwen-code-minimal)
  original_repo: https://github.com/obra/superpowers
---

# Using Git Worktrees — Workspace Isolation

**Description:** Used when starting work on a feature requiring isolation from the current working area, or before executing implementation plans.

**Core principle:** First discover existing isolation → use native tools → fallback to git.

## Announce at the Start

`"I'm using the using-git-worktrees skill to set up an isolated workspace."`

---

## Step 0: Discover Existing Isolation

Before creating anything, check whether you're already in an isolated working area:

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
```

**Submodule protection:** `GIT_DIR != GIT_COMMON` is also true inside git submodules. Check:

```bash
git rev-parse --show-superproject-working-tree 2>/dev/null
```

| State                                         | Action                                                  |
| --------------------------------------------- | ------------------------------------------------------- |
| `GIT_DIR != GIT_COMMON` (and not a submodule) | Already in a worktree → Step 3. DO NOT create a new one |
| `GIT_DIR == GIT_COMMON` (or submodule)        | Standard repository → Step 1                            |

---

## Step 1: Create an Isolated Workspace

### 1a. Native Tools (preferred)

If you have a tool for creating worktrees (e.g., the `/worktree` command), use it and proceed to Step 3.

### 1b. Git Worktree Fallback

**Use only if Step 1a is not applicable.**

#### Directory Selection (priority)

1. User's explicit preference
2. Existing local directory: `.worktrees/` (preferred) → `worktrees/`
3. Global directory: `~/.config/superpowers/worktrees/$project`
4. Default: `.worktrees/` at the project root

#### Safety Check (for local directories)

```bash
git check-ignore -q .worktrees 2>/dev/null || git check-ignore -q worktrees 2>/dev/null
```

**If NOT ignored:** Add to `.gitignore`, commit, then continue.

#### Create Worktree

```bash
project=$(basename "$(git rev-parse --show-toplevel)")
BRANCH_NAME="feature/your-feature-name"
git worktree add .worktrees/$BRANCH_NAME -b "$BRANCH_NAME"
cd ".worktrees/$BRANCH_NAME"
```

---

## Step 2: Project Setup

Automatically detect and run the appropriate setup:

```bash
# Go
if [ -f go.mod ]; then go mod download; fi

# Node.js
if [ -f package.json ]; then npm install; fi

# Rust
if [ -f Cargo.toml ]; then cargo build; fi

# Python
if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
if [ -f pyproject.toml ]; then poetry install; fi
```

---

## Step 3: Clean Baseline Check

Run tests to guarantee a clean start:

```bash
# Go
go test ./...

# Node.js
npm test

# Rust
cargo test

# Python
pytest
```

- **If tests fail:** Report the errors, ask whether to continue or investigate
- **If tests pass:** Report readiness

### Report

```
Worktree ready at .worktrees/feature/your-feature-name
Tests passing: X tests, 0 failures
Ready to implement
```

---

## Quick Reference Table

| Situation             | Action                         |
| --------------------- | ------------------------------ |
| Already in a worktree | Skip creation (Step 0)         |
| In a submodule        | Treat as a standard repository |
| Directory not ignored | Add to .gitignore + commit     |
| Base tests fail       | Report errors + ask            |

---

## Red Flags

**Never:**

- Create a worktree when Step 0 detects existing isolation
- Skip the ignore check (for local directories)
- Skip the base test check
- Continue working with failing tests without asking for permission

**Always:**

- Run discovery first (Step 0)
- Check directory ignore for local worktrees
- Automatically detect and run project setup
- Check the clean baseline tests
