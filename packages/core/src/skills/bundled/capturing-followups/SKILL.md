---
name: capturing-followups
description: Use when working a large, long-running, or multi-phase task and you discover follow-up work partway through — a deferred fix, an out-of-scope issue, tech debt, duplication, a skipped or flaky test, a risky assumption, a "we should later X" — that would otherwise be forgotten by the time the task finishes. Record each as a task the moment you find it, then review and recommend at the end.
allowedTools:
  - task_create
  - task_list
  - task_update
---

# Capturing Follow-ups

During a big task the follow-up work you notice mid-implementation — a bug you
spotted but didn't fix, a shortcut you took, a test you skipped, a "this should
really be X later" — is **lost by the end**, because nothing recorded it when
you found it. Context doesn't survive a long or multi-session task. So record it
the instant it surfaces; review and recommend when the task is done.

The problem is loss-over-distance, not summarizing: a fresh list is easy to
recap — the trouble is the list is incomplete because the items from the start
were gone by the finish.

## The rule

1. **The moment you discover follow-up work, call `task_create`** — a clear
   imperative `subject` and a `description` of _what_ + _why it's deferred_. Add
   `metadata: { kind: "followup" }` so it's filterable later. Do it before
   moving on; don't plan to "remember it for the end" (you won't).
2. **Don't detour to do it now** unless it's in scope. Capturing is not doing —
   the follow-up gets a task, not a fix, so the main task stays on track.
3. **When the task is done, run `task_list`**, then present the user a short
   prioritized **recommendations** summary: each item _what · why it matters ·
   rough effort_, ending with what to do first. Use `task_update` to drop any
   that turned out to be a non-issue. If nothing surfaced, say so in one line.

## What counts as a follow-up

Deferred / out-of-scope issues · scope cuts you made · missed edge cases ·
skipped or flaky tests · duplication or tech debt you noticed · risky
assumptions · TODOs left in code · "should really be X later" · anything a
review flagged as non-blocking.

## Important — qwen tasks are claimable work, not passive notes

A created task's `description` can be **auto-claimed and executed by an idle
teammate agent** (same shape as delegating work). Implications:

- **Solo (no team):** the task is just a backlog entry you review with
  `task_list` at the end — safe to use freely.
- **In a team:** only `task_create` a follow-up you are OK with a teammate
  picking up and doing autonomously. For "record but a human must decide first"
  items (e.g. a security gap you noticed), make that explicit in the subject
  (`FOLLOW-UP — needs human decision: …`) or keep it in managed memory
  (`/remember`) instead of the task list.

## Scope

For **large / long / multi-phase** work. A quick one-file change doesn't need
this — just mention any loose end in your wrap-up.
