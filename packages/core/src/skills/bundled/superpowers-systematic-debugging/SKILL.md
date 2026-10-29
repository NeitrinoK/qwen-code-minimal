---
name: superpowers:systematic-debugging
description: 'Use when encountering any error, test failure, or unexpected behavior BEFORE suggesting fixes.'
user-invocable: true
metadata:
  source: obra/superpowers (adapted for qwen-code-minimal)
  original_repo: https://github.com/obra/superpowers
---

# Systematic Debugging

**Description:** Use when encountering any error, test failure, or unexpected behavior BEFORE suggesting fixes.

**Core principle:** ALWAYS find the root cause before fixing. Fixing symptoms is a failure.

**Iron law:** `NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST`

## When to Apply

For any technical problem: test failures, production bugs, unpredictable behavior, performance, build, or integration issues.

**Mandatory use when:**

- You're short on time and a "quick fix" seems obvious
- You've already tried fixing multiple times
- Previous fixes didn't work
- The problem isn't fully understood

Don't skip even for "simple" bugs.

---

## Four Phases (Strictly Sequential)

### Phase 1: Root Cause Analysis

- Read errors, warnings, call stacks, line numbers, and codes carefully
- Reproduce the problem stably (document the steps). If not reproducible → gather more data
- Check recent changes: `git diff`, new dependencies, configs, environment differences
- In multi-component systems, add diagnostics at boundaries: log input/output data

**Golang Tools:**

```bash
# Check changes
git diff HEAD~5

# Run test with verbose output
go test ./pkg -run TestName -v -count=1

# Race detector
go test ./pkg -race -run TestName -v

# GODEBUG for tracing
GODEBUG=gctrace=1 go test ./pkg

# pprof for performance
go test ./pkg -cpuprofile=cpu.prof -memprofile=mem.prof
go tool pprof cpu.prof
```

### Phase 2: Pattern Analysis

- Find similar working code in the base
- If using a pattern → read the full reference
- List all differences between working and broken code
- Understand dependencies, config requirements, and hidden assumptions

**Example:**

```bash
# Search for similar patterns in code
grep -r "sync.Map" --include="*.go" .
grep -r "context.WithTimeout" --include="*.go" .
```

### Phase 3: Hypothesis and Testing

- Formulate one clear hypothesis: "I believe the cause is X, because of Y"
- Make the MINIMAL change to test (only one variable)
- Check the result. Worked → Phase 4. Didn't work → new hypothesis

**Never stack patches on top of each other.**

### Phase 4: Implementation

1. Create a failing test (simple script or automated test). Use `superpowers:test-driven-development`
2. Make one targeted fix for the root cause. No "drive-by" refactoring
3. Verify: test passed, other tests didn't fall, problem is resolved
4. If the fix doesn't work → stop. At ≥3 failed attempts → stop and reconsider the architecture

---

## Go-Specific Debugging Techniques

### Goroutine Leak Detection

```go
import "go.uber.org/goleak"

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}
```

### Delve Debugger

```bash
# Launch in delve
dlv debug ./cmd/myapp

# Breakpoints
break main.(*Server).Start
continue

# Inspect variables
print cfg.Port
locals
```

### Stack Trace Analysis

```bash
# Run with recover for stack trace
go run ./cmd/myapp

# panic: ...
# goroutine 1 [running]:
# runtime.Stack(0xc0000a0000, ...)
#   /usr/local/go/src/runtime/stack.go:...
# mypkg.DoSomething(...)
#   /path/to/mypkg/foo.go:42
```

### Race Condition Diagnostics

```bash
# Go race detector
go build -race ./cmd/myapp
./myapp

# Output:
# WARNING: DATA RACE
# Read at 0x00c000012340 by goroutine 5:
#   mypkg.(*Cache).Get(...)
# Previous write at 0x00c000012340 by goroutine 3:
#   mypkg.(*Cache).Set(...)
```

---

## Supporting Techniques

### Root Cause Tracing (Backward Tracing)

Go from symptom to source:

```
Symptom (HTTP 500)
  → where? (handler layer)
  → what error? (database timeout)
  → why timeout? (connection pool exhausted)
  → why pool exhausted? (connections not returned)
  → where is the leak? (missing defer conn.Close())
  → FIX: add defer conn.Close()
```

### Defense in Depth

- Validation at input boundaries (API layer)
- Checks in business logic (service layer)
- Constraints in the database (DB layer)

### Condition-Based Waiting (Replacing Hardcoded Timeouts)

```go
// BAD: hardcoded timeout
time.Sleep(5 * time.Second)

// GOOD: polling with backoff
ticker := time.NewTicker(100 * time.Millisecond)
defer ticker.Stop()
for range ticker.C {
    if isReady() {
        break
    }
}
```

---

## Red Flags (STOP Signals)

| Phrase                                       | Action                       |
| -------------------------------------------- | ---------------------------- |
| "quick fix now, figure it out later"         | Stop. Return to Phase 1      |
| "I'll just change X and check"               | Stop. Formulate a hypothesis |
| "I'll make several changes at once"          | Stop. One variable           |
| "I'll skip the test"                         | Stop. Test is mandatory      |
| "most likely X"                              | Stop. Evidence               |
| "I don't fully understand but it might work" | Stop. Investigate            |

---

## Common Rationalizations vs. Reality

| Rationalization                        | Reality                                             |
| -------------------------------------- | --------------------------------------------------- |
| "The bug is simple, no process needed" | Simple bugs have causes too. The process is faster  |
| "Emergency, no time"                   | Systematic debugging is faster than random attempts |
| "Fix first, figure it out later"       | The first fix sets the tone                         |
| "Multiple fixes at once saves time"    | Impossible to isolate the successful fix            |

---

## Practical Impact

| Approach       | Time to Fix | Success on First Try | New Bugs             |
| -------------- | ----------- | -------------------- | -------------------- |
| Systematic     | 15–30 min   | 95%                  | ~0                   |
| Random Patches | 2–3 hours   | 40%                  | frequent regressions |
