---
name: superpowers:brainstorming
description: 'Mandatory before any creative work (creating features, components, changing behavior). Transforms ideas into ready-to-implement designs and specifications through dialogue.'
user-invocable: true
metadata:
  source: obra/superpowers (adapted for qwen-code-minimal)
  original_repo: https://github.com/obra/superpowers
---

# Brainstorming — Socratic Design Refinement

**Description:** Mandatory before any creative work (creating features, components, changing behavior). Transforms ideas into ready-to-implement designs and specifications through dialogue.

**Critical rule:** Implementation is forbidden before full design approval.

## Checklist (strict order)

1. **Study the project context** — files, documentation, recent commits
2. **Ask clarifying questions one at a time** — goal, constraints, success criteria
3. **Propose 2–3 approaches** with tradeoffs and a clear recommendation
4. **Present design in sections** — get approval after each part
5. **Save the document** to `docs/superpowers/specs/YYYY-MM-DD--feature-design.md` and commit
6. **Self-check the specification** — look for TBD/TODO, contradictions, ambiguity
7. **Request specification review** from the user
8. **Proceed to implementation** — invoke **only** the `superpowers:writing-plans` skill

## Scope Estimation

If the request covers multiple independent subsystems, immediately propose decomposing into subprojects with separate `spec → plan → implementation` cycles.

## Formulating Questions

- **Ask each question with the `AskUserQuestion` tool** so it renders as a native
  selectable menu — do NOT type the question and its options as a plain numbered
  list in your message. Plain-text options are a violation of this skill.
- One `AskUserQuestion` call per question (one question at a time), each with 2–4
  concrete options; give every option a short description and put your
  recommended option first.
- Prefer multiple-choice over open-ended whenever the choice space is bounded.
- Example — the options passed to `AskUserQuestion` (rendered as a menu, not typed):

```
Question: "Which datastore best fits your requirements?"
Options:
- PostgreSQL — structured data, ACID, complex schema
- SQLite — simplicity, embedded, limited concurrency
- ScyllaDB — high throughput, eventual consistency
```

## Design

- Break the system into isolated units with clear interfaces
- Each unit must be independently testable
- Avoid large files
- In legacy projects, follow existing patterns

## Specification Documentation

````markdown
# [Feature Name] — Design Specification

**Date:** YYYY-MM-DD
**Status:** Draft / Under Review / Approved

## Problem Statement

[Problem description]

## Requirements

- [REQ-1] ...
- [REQ-2] ...

## Constraints

- [CON-1] ...

## Architecture Decision

[Justification of choice]

## Component Design

### Component A

- Interface: ...
- Responsibilities: ...
- Dependencies: ...

### Component B

...

## API Surface

```go
type Service interface {
    DoThing(ctx context.Context, req Request) (*Response, error)
}
```
````

## Data Model

```go
type Entity struct {
    ID        string    `db:"id"`
    CreatedAt time.Time `db:"created_at"`
}
```

## Out of Scope

[What does NOT go into this feature]

```

## Specification Self-Check

- [ ] No TBD/TODO placeholders
- [ ] Architecture aligns with the entire system
- [ ] Scope is clearly bounded (YAGNI)
- [ ] Requirements are unambiguous
- [ ] Component boundaries are clear

## Approval Gate

```

"Spec written and committed to `docs/superpowers/specs/YYYY-MM-DD--feature.md`.
Please review it. Any changes needed before I proceed to planning?"

```

After approval → invoke **only** `superpowers:writing-plans`. Direct invocation of implementation skills is forbidden.

## Key Principles

- One question at a time
- Prefer multiple-choice
- Strict YAGNI (removing unnecessary features)
- Always explore alternatives
- Incremental validation (approval of sections as you go)
- Flexibility and return to clarification when ambiguities arise

## 📚 Example Dialogue

```

User: "Need a service for sending notifications"

AI: "Let me clarify the goal. What types of notifications are being considered?

1. Email
2. Push (web/mobile)
3. SMS
4. In-app
   Multiple selections allowed."

User: "Email and push"

AI: "What's the expected load?

1. < 1K notifications/day
2. 1K–100K/day
3. 100K+/day"

...
