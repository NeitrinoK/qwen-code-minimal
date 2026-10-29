---
name: superpowers:requesting-code-review
description: 'Used when completing tasks, implementing major features, or before merging to check compliance with requirements.'
user-invocable: true
metadata:
  source: obra/superpowers (adapted for qwen-code-minimal)
  original_repo: https://github.com/obra/superpowers
---

# Code Review — Request + Receive

## 🔹 Requesting Code Review

**Description:** Used when completing tasks, implementing major features, or before merging to check compliance with requirements.

**Core principle:** Review early, review often.

### When to request review

**Mandatory:**

- After each task in subagent development
- After completing a major feature
- Before merging with the main branch

**Recommended:**

- When stuck (fresh perspective)
- Before refactoring (check the baseline)
- After fixing complex bugs

### How to request

**1. Get git SHAs:**

```bash
BASE_SHA=$(git rev-parse HEAD~1)
HEAD_SHA=$(git rev-parse HEAD)
```

**2. Launch a code review subagent** (Agent tool, general-purpose):

```markdown
Conduct a code review of the changes between $BASE_SHA and $HEAD_SHA.

Change description: [brief description]
Requirements/Plan: [link or plan text]

Check:

1. SPEC COMPLIANCE — are all task requirements met?
2. CODE QUALITY — style, error handling, concurrency, naming, DRY

Response format:

- Critical: [list — must fix immediately]
- Important: [list — fix before proceeding]
- Minor: [list — can defer]
- Overall: [brief summary]
```

**3. Act on the feedback:**

- Fix `Critical` immediately
- Fix `Important` before proceeding
- Defer `Minor` for the future
- Push back on reviewer errors with technical justification

---

## 🔹 Receiving Code Review

**Description:** Used when receiving review feedback, before implementing suggestions.

**Core principle:** `Verify before implementing. Technical correctness over social comfort.`

### Response Pattern

```
WHEN receiving code review feedback:
1. READ — read the full feedback without reacting
2. UNDERSTAND — restate the requirement in your own words (or ask)
3. VERIFY — check against the actual codebase
4. EVALUATE — technically sound for THIS project?
5. RESPOND — technical acknowledgment or justified pushback
6. IMPLEMENT — one item at a time, test each
```

### Forbidden Reactions

**Never write:**

- ❌ "Absolutely right!" / "Great point!" (performative agreement)
- ❌ "Let me implement that now" (before verification)

**Instead:**

- ✅ Restate the technical requirement
- ✅ Ask clarifying questions
- ✅ Push back with technical justification if incorrect
- ✅ Just start working (actions > words)

### Handling Unclear Feedback

```
IF any item is unclear:
  STOP — don't implement anything yet
  ASK — clarify the unclear items
  WHY — items may be related. Partial understanding = incorrect implementation.
```

**Example:**

```
Reviewer: "Fix items 1-6"
You understand 1,2,3,6. Items 4,5 are unclear.

❌ "I'll implement 1,2,3,6 now, I'll ask about 4,5 later"
✅ "Understood items 1,2,3,6. Need clarification on 4 and 5 before starting."
```

### YAGNI Check

```
IF reviewer suggests "implementing it properly":
  grep the codebase for actual usage
  IF unused: "This endpoint isn't called anywhere. Remove it (YAGNI)?"
  IF used: Then implement
```

### Feedback Implementation Order

1. Clarify everything unclear FIRST
2. Implement in order:
   - Blocking issues (broken, security)
   - Simple fixes (typos, imports)
   - Complex fixes (refactoring, logic)
3. Test each fix individually
4. Check for no regressions

### When to Push Back

Push back when:

- The suggestion breaks existing functionality
- The reviewer doesn't have full context
- It violates YAGNI (unused feature)
- It's technically incorrect for this stack
- It conflicts with architectural decisions

**How to push back:**

- Use technical justification, not defensive reaction
- Ask specific questions
- Reference working tests/code

### Acknowledging Correct Feedback

```
✅ "Fixed. [Brief description of changes]"
✅ "Good catch — [specific issue]. Fixed in [location]."
✅ [Just fix it and show in code]

❌ "Thanks for catching that!"
❌ "Absolutely right!"
❌ Any expressions of gratitude
```

**Why no gratitude:** Actions speak. Just fix it. The code shows you heard the feedback.

---

## Common Mistakes

| Mistake                   | Fix                                 |
| ------------------------- | ----------------------------------- |
| Performative agreement    | Restate the requirement or just act |
| Blind implementation      | Verify against codebase first       |
| Batch without tests       | One at a time, test each            |
| Assumes reviewer is right | Check whether it breaks something   |
| Avoids pushback           | Technical correctness > comfort     |
