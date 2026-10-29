---
name: superpowers:test-driven-development
description: 'Use when implementing any new features or fixing bugs, strictly before writing implementation code.'
user-invocable: true
metadata:
  source: obra/superpowers (adapted for qwen-code-minimal)
  original_repo: https://github.com/obra/superpowers
---

# Test-Driven Development (TDD)

**Description:** Use when implementing any new features or fixing bugs, strictly **before** writing implementation code.

## 🔹 Overview and Core Principle

Write the test first. Watch it fail. Write minimal code to make the test pass.
**Core:** If you haven't seen the test fail, you don't know whether it's checking the right thing.

## 🔹 When to Apply

**Always:** new features, bug fixes, refactoring, behavior changes.
**Exceptions (clarify with the developer):** throwaway prototypes, generated code, configuration files.

## 🔹 Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Wrote code before the test? **Delete it.** Start over. No exceptions.

## 🔹 Red-Green-Refactor Cycle

### 🔴 RED — Write a Failing Test

One minimal test for real behavior. Clear name, no mocks if possible.

```go
func TestRetryOperationRetriesThreeTimes(t *testing.T) {
    attempts := 0
    operation := func() (string, error) {
        attempts++
        if attempts < 3 {
            return "", errors.New("fail")
        }
        return "success", nil
    }
    result, err := RetryOperation(operation)
    if result != "success" {
        t.Errorf("expected success, got %s", result)
    }
    if attempts != 3 {
        t.Errorf("expected 3 attempts, got %d", attempts)
    }
}
```

### 🔍 Verify RED — Confirm It Fails (MANDATORY)

```bash
go test ./path/to/pkg -run TestRetryOperationRetriesThreeTimes -v
```

- The test must fail (not with a compilation/syntax error)
- The error message is the expected one
- It fails because of the missing feature, not a typo

_Test passes immediately?_ Fix the test. _Compilation errors?_ Fix them and rerun until it correctly fails.

### 🟢 GREEN — Minimal Code

Write the simplest code to make the test pass. Don't complicate, don't add features, don't refactor the rest.

```go
func RetryOperation(fn func() (string, error)) (string, error) {
    for i := 0; i < 3; i++ {
        result, err := fn()
        if err == nil {
            return result, nil
        }
        if i == 2 {
            return "", err
        }
    }
    return "", errors.New("unreachable")
}
```

### 🔍 Verify GREEN — Confirm It Passes (MANDATORY)

```bash
go test ./path/to/pkg -run TestRetryOperationRetriesThreeTimes -v
```

- Test passes
- All other tests pass: `go test ./...`
- Output is clean (no errors or warnings)

### 🛠 REFACTOR — Clean Up

Only after GREEN: remove duplication, improve names, extract helpers. Keep tests green.

---

## 🔹 Criteria for Good Tests

| Quality          | Good                                        | Bad                                        |
| ---------------- | ------------------------------------------- | ------------------------------------------ |
| **Minimality**   | One behavior. If the name has "and" — split | `TestValidatesEmailAndDomainAndWhitespace` |
| **Clarity**      | Name describes the behavior                 | `Test1`                                    |
| **Transparency** | Demonstrates the desired API                | Obscures what the code should do           |

---

## 🔹 Go-Specific Testing Techniques

### Table-Driven Tests (Idiomatic Go)

```go
func TestParseDuration(t *testing.T) {
    tests := []struct {
        name    string
        input   string
        want    time.Duration
        wantErr bool
    }{
        {"valid hours", "2h", 2 * time.Hour, false},
        {"invalid format", "2x", 0, true},
        {"empty input", "", 0, true},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := ParseDuration(tt.input)
            if (err != nil) != tt.wantErr {
                t.Errorf("ParseDuration() error = %v, wantErr %v", err, tt.wantErr)
                return
            }
            if got != tt.want {
                t.Errorf("ParseDuration() = %v, want %v", got, tt.want)
            }
        })
    }
}
```

### Subtests for Independent Checks

```go
func TestUserService(t *testing.T) {
    t.Run("CreateUser succeeds with valid email", func(t *testing.T) { ... })
    t.Run("CreateUser rejects empty email", func(t *testing.T) { ... })
    t.Run("GetUser returns not found for missing id", func(t *testing.T) { ... })
}
```

### Parallel Tests

```go
t.Run("test1", func(t *testing.T) {
    t.Parallel()
    // ...
})
```

---

## 🔹 Why Order Matters (Addressing Objections)

- **"I'll write tests later"**: Tests after code pass immediately. Passing tests prove nothing.
- **"I already tested manually"**: Manual testing is unsystematic and not preserved.
- **"Deleting X hours of work is wasteful"**: Leaving unverified code = technical debt.
- **"TDD will slow things down"**: TDD is faster than debugging.

---

## 🔹 Red Flags (STOP and Start Over)

- Code before test
- Test after implementation
- Test passes immediately
- Can't explain the failure reason
- Manual testing instead of automated tests
- Saving old code as a reference

---

## 🔹 Pre-Completion Checklist

- [ ] Every new function/method has a test
- [ ] You saw each test fail
- [ ] Each test failed for the expected reason
- [ ] Code is minimal for the test to pass
- [ ] All tests pass: `go test ./...`
- [ ] Output is clean (no errors/warnings)
- [ ] Real dependencies are used (mocks only when necessary)
- [ ] Edge cases and errors are covered

---

## 🔹 Example: Bug Fix

**Bug:** Empty email is accepted

**RED:**

```go
func TestSubmitFormRejectsEmptyEmail(t *testing.T) {
    result := SubmitForm(FormData{Email: ""})
    if result.Error != "Email required" {
        t.Errorf("expected 'Email required', got %q", result.Error)
    }
}
```

**Verify RED:** `go test -run TestSubmitFormRejectsEmptyEmail -v`
→ `FAIL: expected 'Email required', got ""`

**GREEN:**

```go
func SubmitForm(data FormData) FormResult {
    if strings.TrimSpace(data.Email) == "" {
        return FormResult{Error: "Email required"}
    }
    // ...
}
```

**Verify GREEN:** `go test -run TestSubmitFormRejectsEmptyEmail -v`
→ `PASS`

**REFACTOR:** Extract validation into a separate function if needed.
