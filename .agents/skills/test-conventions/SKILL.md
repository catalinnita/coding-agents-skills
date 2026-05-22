---
name: test-conventions
description: >
  Scans every test file to detect the dominant testing pattern (framework,
  describe/it structure, hook style, naming convention, async style, assertion
  style), identifies deviating files, and normalises them so the entire test
  suite follows the same conventions. Writes a test-conventions.json consumed
  by the tdd-agent when generating new tests. Use when asked to standardise
  test conventions, normalise test structure, or make all tests consistent.
compatibility: >
  Requires Python 3.10+. File normalisation requires the project's test runner
  (Jest or Vitest) to verify files still pass after changes.
metadata:
  author: the-morning-bell
  version: "1.0"
---

## Overview

Detect and enforce consistent testing conventions across the entire test suite.
Measures patterns across all test files, identifies the dominant convention,
normalises deviating files mechanically (without altering test logic), and
writes a `test-conventions.json` that the `tdd-agent` reads when generating
new test files.

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to scan. Default: entire project |
| `fix` | No | Apply normalisation in-place. Default: `false` (report only) |
| `convention` | No | Path to an existing `test-conventions.json` to enforce instead of auto-detecting |
| `ignore` | No | File glob to exclude from normalisation |

## Step 1 — Detect the dominant convention

```bash
python3 .agents/skills/test-conventions/scripts/runner.py \
  --mode detect \
  --project-dir <path-to-project>
```

Scan all test files (`*.test.ts`, `*.test.js`, `*.spec.ts`, `*.spec.js`) and measure:

**Framework detection:**

| Signal | Framework |
|---|---|
| `import { describe, it, expect } from 'vitest'` | Vitest |
| `import { describe, it } from '@jest/globals'` | Jest (ESM) |
| `import '@testing-library/jest-dom'` | Jest + Testing Library |
| `const { expect } = require('chai')` | Mocha + Chai |
| Global `describe`, `it`, `expect` with no import | Jest (CJS globals) |

**Patterns tallied across all files:**

| Pattern | Options measured |
|---|---|
| Test keyword | `it` vs `test` |
| `describe` nesting depth | 1 / 2 / 3+ levels |
| Hook style | `beforeEach`/`afterEach` vs `beforeAll`/`afterAll` |
| Naming style | sentence-case vs `should` prefix vs `does`/verb prefix |
| Async style | `async/await` vs `.then()` chains |
| Assertion equality | `toEqual` vs `toStrictEqual` |
| Assertion partial | `toMatchObject` vs manual property checks |

The pattern appearing in ≥ 60% of files is the **dominant convention**.

If no pattern reaches 60%, report the split to the user and ask them to choose before proceeding. Do not apply any normalisation without a clear dominant convention.

Writes `.tdd/detected-conventions.json`:

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

## Step 2 — Identify deviating files

```bash
python3 .agents/skills/test-conventions/scripts/runner.py \
  --mode diff \
  --project-dir <path-to-project>
```

For each test file, compare its patterns against the dominant convention. Flag any file where ≥ 1 pattern differs:

```
DEVIATION REPORT
─────────────────────────────────────────────
src/auth/auth.test.ts
  ✗ uses `test` keyword        (expected `it`)
  ✗ uses `afterAll` hook       (expected `beforeEach`/`afterEach`)
  ✗ naming: `should` prefix    (expected sentence-case)

src/cart/cart.spec.ts
  ✗ uses `.then()` async chains (expected `async/await`)
```

Writes `.tdd/convention-deviations.json`.

## Step 3 — Normalise deviating files (when `fix: true`)

```bash
python3 .agents/skills/test-conventions/scripts/runner.py \
  --mode fix \
  --project-dir <path-to-project>
```

Apply the dominant convention mechanically — never alter test logic, only syntax and structure:

**`test` → `it` (or vice versa):**
```typescript
// Before
test('returns the user', async () => { … });
// After
it('returns the user', async () => { … });
```

**`should` prefix removal:**
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
  return service.fetch().then(result => { expect(result).toEqual(expected); });
});
// After
it('fetches data', async () => {
  const result = await service.fetch();
  expect(result).toEqual(expected);
});
```

**`beforeAll` → `beforeEach` (when dominant style is per-test):**
```typescript
// Before
let user: User;
beforeAll(() => { user = createUserMock(); });
// After
let user: User;
beforeEach(() => { user = createUserMock(); });
```

After each file is rewritten, run `--testPathPattern <file>` to verify it still passes. If it breaks, revert that file only and add it to the manual-review list.

## Step 4 — Write `test-conventions.json`

```bash
python3 .agents/skills/test-conventions/scripts/runner.py \
  --mode write-config \
  --project-dir <path-to-project>
```

Write (or update) `test-conventions.json` in the project root:

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

This file is the source of truth consumed by `tdd-agent` when generating new test files.

## Step 5 — Generate report

```bash
python3 .agents/skills/test-conventions/scripts/runner.py \
  --mode report \
  --project-dir <path-to-project>
```

Writes `.tdd/test-conventions-report.md`:

```markdown
## Test Conventions Report — 2026-05-22

### Detected convention
- Framework:    vitest  |  Test keyword: it
- Hook style:   beforeEach  |  Naming: sentence-case
- Async style:  async/await

### Files
- Scanned: 34  |  Conforming: 29  |  Deviating: 5

### Normalised
- src/auth/auth.test.ts      ✓  3 changes applied
- src/cart/cart.spec.ts      ✓  1 change applied

### Needs manual review
- src/legacy/old.test.js     ✗  reverted — async .then() chain uses non-standard
  Promise chaining that cannot be safely transformed automatically
```

## Convenience: run the full pipeline

```bash
python3 .agents/skills/test-conventions/scripts/runner.py \
  --mode run \
  --project-dir <path-to-project>
```

Runs Steps 1–5 in sequence.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Output structure

```
test-conventions.json         ← project root, read by tdd-agent
.tdd/
  detected-conventions.json
  convention-deviations.json
  test-conventions-report.md
```

## Edge cases

- **Multiple frameworks** (Jest unit + Playwright E2E): detect each `testMatch` glob as a separate scope; enforce conventions per scope independently
- **No dominant pattern** (all < 60%): present the spread, ask user to choose, write `test-conventions.json` with the chosen values — apply no normalisation until chosen
- **Complex `beforeAll` blocks** (DB seeds, server start): do not convert to `beforeEach` — flag as exception and document in the report
- **Intentional mixed conventions**: add `// convention-ignore` comment to suppress future warnings on deliberate exceptions
- **Snapshot tests** (`toMatchSnapshot`, `toMatchInlineSnapshot`): do not alter — normalisation cannot verify they remain correct
- **Assertion message strings**: preserve third-argument description strings (`expect(x, 'message').toBe(y)`) during normalisation
- **`.spec.ts` vs `.test.ts` naming**: treat as equivalent; normalise file naming only if explicitly requested

## Success criteria

- `test-conventions.json` exists and accurately describes the canonical test style
- Every file in scope either conforms or is documented as a manual-review exception with a reason
- No test that passes before normalisation fails after it
- New tests generated by `tdd-agent` use `test-conventions.json` automatically
- Report lists every deviation, every applied fix, and every reversion with its reason
