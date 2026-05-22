# Skill Spec: Test Conventions

## Goal

Scan every test file in the project, detect the testing patterns actually in
use (framework, assertion style, describe/it structure, setup/teardown hooks,
naming conventions), identify files that deviate from the dominant pattern, and
apply normalisation so the entire test suite speaks the same language.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "standardise test conventions"
- "normalise test structure"
- "make all tests consistent"
- "enforce the same testing style across files"
- "align test patterns"
- "fix inconsistent test setup / teardown"

Also invoked by the **TDD Orchestrator** agent as part of Phase 2.

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to scan. Default: entire project |
| `fix` | No | `true` to apply normalisation in-place. Default: `false` (report only) |
| `convention` | No | Path to a `test-conventions.json` config file to enforce. Default: auto-detected from the majority pattern |
| `ignore` | No | File glob to exclude from normalisation |

---

## Behavior

### Step 1 — Detect the dominant convention

Scan all test files (`*.test.ts`, `*.test.js`, `*.spec.ts`, `*.spec.js`) and measure:

**Framework:**

| Signal | Framework |
|---|---|
| `import { describe, it, expect } from 'vitest'` | Vitest |
| `import { describe, it } from '@jest/globals'` | Jest (ESM) |
| `import '@testing-library/jest-dom'` | Jest + Testing Library |
| `const { expect } = require('chai')` | Mocha + Chai |
| No import (global `describe`, `it`, `expect`) | Jest (CJS globals) |

**Test structure patterns detected:**

| Pattern | Description |
|---|---|
| Nesting depth | How many `describe` levels deep tests are written |
| `describe` / `context` usage | Does the project use `describe`, `context`, or both? |
| `it` vs `test` | Which keyword is used for test cases |
| `beforeEach` / `afterEach` vs `beforeAll` / `afterAll` | Per-test vs suite-level hooks |
| Shared `let` variables in `describe` scope | Declared at top of `describe`, assigned in `beforeEach` |
| `async/await` vs `.then()` chains in async tests | |
| `expect(x).toBe(y)` vs `expect(x).toEqual(y)` usage patterns | |

**Naming conventions:**

| Convention | Example |
|---|---|
| Sentence case description | `it('returns the user when found')` |
| `should` prefix | `it('should return the user when found')` |
| `does` / verb prefix | `it('does not return deleted users')` |
| Nested `describe` mirrors code structure | `describe('UserService > findById')` |

**Assertion style:**

| Style | Example |
|---|---|
| Inline `expect` | `expect(result).toEqual(expected)` |
| Extracted expected | `const expected = …; expect(result).toEqual(expected)` |
| `toMatchObject` for partial | `expect(result).toMatchObject({ id: '1' })` |
| `toStrictEqual` for exact | `expect(result).toStrictEqual(expected)` |

Tally each pattern across all files. The pattern appearing in ≥ 60% of files is the **dominant convention**. Write `<target>/.tdd/detected-conventions.json`:

```json
{
  "framework": "vitest",
  "testKeyword": "it",
  "nestingDepth": 2,
  "hookStyle": "beforeEach",
  "namingPattern": "sentence-case",
  "asyncStyle": "async/await",
  "assertionStyle": "toEqual"
}
```

If no dominant pattern exists (all patterns < 60%), report the split and ask the user to choose a convention before continuing.

### Step 2 — Identify deviating files

For each test file, compare its patterns against the dominant convention. Flag any file where ≥ 1 pattern differs:

```
DEVIATION REPORT
────────────────
src/auth/auth.test.ts
  ✗ uses `test` keyword (expected `it`)
  ✗ uses `afterAll` hook (expected `beforeEach` / `afterEach`)
  ✗ naming: `should` prefix (expected sentence-case)

src/cart/cart.spec.ts
  ✗ uses `.then()` async chains (expected `async/await`)
```

Writes `<target>/.tdd/convention-deviations.json`.

### Step 3 — Normalise deviating files (when `fix: true`)

Apply the dominant convention to each deviating file. Changes are mechanical and
safe — they do not alter test logic, only syntax and structure:

**`test` → `it` (or vice versa):**
```typescript
// Before
test('returns the user', async () => { … });
// After
it('returns the user', async () => { … });
```

**`should` prefix removal (sentence-case normalisation):**
```typescript
// Before
it('should return the user when found', …)
// After
it('returns the user when found', …)
```

**`.then()` → `async/await`:**
```typescript
// Before
it('fetches data', () => {
  return service.fetch().then(result => {
    expect(result).toEqual(expected);
  });
});
// After
it('fetches data', async () => {
  const result = await service.fetch();
  expect(result).toEqual(expected);
});
```

**`beforeAll` → `beforeEach` with reset (when dominant style is per-test):**
```typescript
// Before
let user: User;
beforeAll(() => { user = createUserMock(); });

// After
let user: User;
beforeEach(() => { user = createUserMock(); });
```

**`toStrictEqual` ↔ `toEqual` normalisation:**
Only normalise when the dominant convention is clear and the alternative is not
intentional (e.g. `toStrictEqual` on an exact type check stays).

After each file is rewritten, run the test suite for that file only
(`--testPathPattern`). If the file fails after normalisation, revert it and add
it to the manual-review list.

### Step 4 — Write or update `test-conventions.json`

Write (or update if it already exists) a `test-conventions.json` in the project
root documenting the canonical convention:

```json
{
  "framework": "vitest",
  "testKeyword": "it",
  "describeNestingMaxDepth": 2,
  "hookStyle": "beforeEach",
  "namingPattern": "sentence-case",
  "asyncStyle": "async/await",
  "assertionPreferences": {
    "equality": "toEqual",
    "partial": "toMatchObject",
    "exact": "toStrictEqual"
  },
  "filePattern": "**/*.test.{ts,tsx}"
}
```

This file is consumed by the **TDD Orchestrator** when generating new test files,
ensuring new tests follow the same conventions from the start.

### Step 5 — Generate report

Write `.tdd/test-conventions-report.md`:

```markdown
## Test Conventions Report — 2026-05-22

### Detected convention
- Framework:    vitest
- Test keyword: it
- Hook style:   beforeEach
- Naming:       sentence-case
- Async style:  async/await

### Deviating files
- Total scanned: 34
- Conforming:    29
- Deviating:      5

### Normalised (fix: true)
- src/auth/auth.test.ts       ✓ normalised (3 changes)
- src/cart/cart.spec.ts       ✓ normalised (1 change)

### Needs manual review
- src/legacy/old.test.js      ✗ reverted — test broke after normalisation
  (async .then() chain uses non-standard Promise chaining that cannot be
  safely transformed automatically)
```

---

## Output structure

```
test-conventions.json       ← project root, canonical convention config
.tdd/
  detected-conventions.json
  convention-deviations.json
  test-conventions-report.md
```

---

## Edge cases and constraints

- **Multiple frameworks in one project** (e.g. Jest for unit, Playwright for E2E): treat each `testMatch` pattern as a separate scope; detect and enforce conventions per scope independently
- **`.spec.ts` vs `.test.ts` naming**: treat as the same; normalise file naming only if explicitly requested
- **Assertion message strings**: preserve third-argument description strings in `expect(x, 'message').toBe(y)` during normalisation
- **Complex `beforeAll` blocks** (expensive setup like DB seeds, server start): do not convert to `beforeEach` — flag as an exception and document in the report
- **Files with mixed conventions intentionally** (e.g. one `describe` uses `beforeAll` for a performance reason): normalise at the file level; add an inline `// convention-ignore` comment to suppress future warnings on intentional exceptions
- **No dominant convention** (project is new or deeply inconsistent): present the detected spread to the user and ask them to pick a convention; write `test-conventions.json` with the chosen values without applying any normalisation
- **Snapshot tests**: do not alter `toMatchSnapshot()` or `toMatchInlineSnapshot()` calls — these are data-driven and normalisation cannot verify they remain correct

---

## Success criteria

- `test-conventions.json` exists and accurately describes the canonical test style
- Every file in scope either conforms to the convention or is documented as a manual-review exception
- No test that passes before normalisation fails after it
- New tests generated by the TDD Orchestrator use the convention from `test-conventions.json` automatically
- The report lists every deviation, every applied fix, and every reversion with its reason
