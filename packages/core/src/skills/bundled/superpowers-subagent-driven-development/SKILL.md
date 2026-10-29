---
name: superpowers:subagent-driven-development
description: 'Purpose: Executing implementation plans consisting of independent tasks within the current session.'
user-invocable: true
metadata:
  source: obra/superpowers (adapted for qwen-code-minimal)
  original_repo: https://github.com/obra/superpowers
---

# Subagent-Driven Development

**Purpose:** Executing implementation plans consisting of independent tasks within the current session.

**Core principle:** For each task, a fresh isolated subagent is created (via the Agent tool). After execution, a two-stage review is conducted: first spec compliance, then code quality.

## When to Apply

- A ready implementation plan exists
- Tasks are mostly independent
- Work is needed in the current session
- _(Differs from `superpowers:executing-plans`, which is intended for execution without subagents)_

## Process (Cycle for Each Task)

```
┌─────────────────────────────────────────────────────────┐
│ for each task in the plan:                              │
│                                                         │
│  1. Dispatch subagent (Agent tool)                      │
│     ↓                                                   │
│  2. Answer agent's questions + provide context          │
│     ↓                                                   │
│  3. Implementer completes the task + tests + commit     │
│     ↓                                                   │
│  4. Spec Compliance Review                              │
│     ├─ OK → step 5                                     │
│     └─ Issues → fix → re-review                        │
│     ↓                                                   │
│  5. Code Quality Review                                 │
│     ├─ OK → step 6                                     │
│     └─ Issues → fix → re-review                        │
│     ↓                                                   │
│  6. Mark task as completed in TodoWrite                 │
│     ↓                                                   │
│  Repeat for all tasks                                   │
│                                                         │
│ After all tasks → final review → finishing-branch       │
└─────────────────────────────────────────────────────────┘
```

### Step 1: Dispatch Subagent

Use the Agent tool (general-purpose) with a detailed task from the plan:

```
Dispatch an agent with the prompt:

"Implement Task N: [name] from the plan.

Project context: [brief description]
Files to create/modify: [list]
Task requirements: [full task text from the plan with code]

Use TDD: first a failing test, then minimal implementation.
Follow the existing codebase style.
Make a commit after completion.

Return: a brief summary of changes and status (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT)."
```

### Step 2: Handle Subagent Questions

If the subagent requests context (`NEEDS_CONTEXT`):

- Provide the missing information from the plan
- Clarify task boundaries
- RESEND the task with full context

### Step 3: Implementer Self-Review

The implementer must self-review before returning:

- Verify all task steps are completed
- Run tests: `go test ./...`
- Ensure no lint errors

### Step 4: Spec Compliance Review

Check the result against the spec:

```
- Are all task requirements met?
- Are all specified files created/modified?
- Do tests cover the expected behavior?
- Are there any unfinished TBD/TODO items?
```

If issues → return to implementer with specific items → re-review.

### Step 5: Code Quality Review

Check the implementation quality:

```
- Was TDD followed (test first)?
- Does the code follow the project style?
- Is error handling correct?
- Is there any duplication (DRY)?
- Are names clear and idiomatic?
- Is context propagation correct?
```

If issues → return to implementer → re-review.

### Step 6: Mark Task

Mark the task as `completed` in TodoWrite. Move to the next.

## Subagent Model Selection

Use the least powerful model capable of handling the role:

- **Mechanical tasks** (1-2 files, clear spec) → fast/cheap model
- **Integration, debugging, multiple files** → standard model
- **Architecture, design, review** → most powerful available model

## Handling Implementer Statuses

| Status               | Action                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DONE`               | Proceed to spec review                                                                                          |
| `DONE_WITH_CONCERNS` | Analyze the concerns. If they affect correctness → resolve before review. If observations → record and continue |
| `NEEDS_CONTEXT`      | Provide the missing information and resend the task                                                             |
| `BLOCKED`            | Remove the blocker (add context, upgrade model, split task, or escalate). **Never ignore**                      |

## Critical Rules (Red Flags / Never)

**Never:**

- Start working on `main/master` branch without explicit consent
- Skip review stages or fix cycles
- Run multiple `implementer`s in parallel (risk of conflicts)
- Force the subagent to read the plan file — provide the full task text directly
- Break the order: first ✅ spec compliance, then code quality review
- Start implementing before fully answering the subagent's questions

**Always:**

- Dispatch one subagent per task
- Check spec compliance before code quality
- Get a full summary from the subagent before review

## Integration with Workflow Skills

| Skill                                        | When Used                       |
| -------------------------------------------- | ------------------------------- |
| `superpowers:using-git-worktrees`            | Before starting (isolation)     |
| `superpowers:writing-plans`                  | Before starting (plan creation) |
| `superpowers:test-driven-development`        | Within each task (TDD)          |
| `superpowers:requesting-code-review`         | After each task                 |
| `superpowers:verification-before-completion` | Before completion               |
| `superpowers:finishing-a-development-branch` | After all tasks                 |

## 📚 Example Prompt for a Subagent

```markdown
Implement Task 3: Add HTTP health check endpoint.

Context: Go REST API with chi router. Port is configured via config.Host/config.Port.

Files:

- Create: `internal/api/health.go` — handler + router registration
- Create: `internal/api/health_test.go` — table-driven tests

Task requirements:

1. GET /health returns 200 {"status":"ok"}
2. Handler uses context for timeout
3. Tests: success case, timeout case, invalid method

Use TDD: first a failing test, then minimal implementation.
Follow the project style: Functional Options, proper error wrapping.
Make a commit after completion.

Return: a summary of changes and status.
```
