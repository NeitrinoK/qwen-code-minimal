---
name: superpowers:executing-plans
description: 'Use when you have a written implementation plan that needs to be executed in the current session with verification checkpoints.'
user-invocable: true
metadata:
  source: obra/superpowers (adapted for qwen-code-minimal)
  original_repo: https://github.com/obra/superpowers
---

# Executing Plans — Implementation Plan Execution

**Description:** Use when you have a written implementation plan that needs to be executed in the current session with verification checkpoints.

**Note:** If subagents are available (Agent tool), use `superpowers:subagent-driven-development` instead of this skill — it works significantly faster.

## Announce at the Start

`"I'm using the executing-plans skill to implement this plan."`

---

## Process

### Step 1: Load and Review the Plan

1. Read the plan file
2. Critically review: identify questions, concerns, gaps
3. If there are concerns → discuss with the user before starting
4. If no concerns → create a TodoWrite and continue

### Step 2: Execute Tasks

For each task in the plan:

1. Mark as `in_progress` in TodoWrite
2. Follow each step of the plan exactly (the plan is broken into small steps)
3. TDD: failing test → verify red → minimal code → verify green → refactor
4. Run the specified checks (`go test`, `go vet`, `golangci-lint`)
5. Commit: `git add ... && git commit -m "feat: ..."`
6. Mark as `completed` in TodoWrite

### Step 3: Finish Development

After executing and verifying all tasks:

```
"I'm using the finishing-a-development-branch skill to complete this work."
```

**REQUIRED SUBSKILL:** Use `superpowers:finishing-a-development-branch`.

---

## When to Stop and Ask for Help

**Immediately stop execution when:**

- You encounter a blocker (missing dependency, test fails, instruction unclear)
- Critical gaps in the plan prevent you from starting
- You don't understand the instruction
- Recurring verification errors

**Ask for clarification, don't guess.**

## When to Return to Step 1 (Review)

- The user updated the plan based on your feedback
- A fundamental approach change is required
- **Don't force your way through blockers** — stop and ask

---

## Important Rules

- Critically evaluate the plan first
- Follow the plan steps exactly
- Don't skip verification checks
- Refer to the specified skills when the plan requires them
- Stop on blockers, don't guess
- **Never start implementation in a `main/master` branch without explicit consent**

---

## Integration

| Skill                                        | When                                 |
| -------------------------------------------- | ------------------------------------ |
| `superpowers:using-git-worktrees`            | Before starting — isolated workspace |
| `superpowers:writing-plans`                  | Before this — creating the plan      |
| `superpowers:test-driven-development`        | Within each task — TDD               |
| `superpowers:systematic-debugging`           | On errors — root cause analysis      |
| `superpowers:verification-before-completion` | Before completion — run the command  |
| `superpowers:finishing-a-development-branch` | After all tasks — merge/PR/cleanup   |
