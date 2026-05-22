---
name: unified-mocks
description: >
  Scans the test suite for all mock definitions, identifies duplication and
  inconsistency, consolidates them into shared typed mock factory functions,
  and replaces inline mock literals with calls to those factories. Use when
  asked to create unified mocks, consolidate mocks, extract shared mock
  factories, remove duplicate mocks, or make mocks consistent across test files.
compatibility: >
  Requires Python 3.10+. Rewriting test files requires the project's test
  runner (Jest or Vitest) to verify files still pass after changes.
metadata:
  author: the-morning-bell
  version: "1.0"
---

## Overview

Consolidate duplicate test mocks into shared typed factory functions. Scans
every test file for mock definitions, groups them by identity, generates typed
factory files with an `overrides` parameter, and replaces inline literals with
factory calls. Runs the suite after each rewrite to verify nothing breaks.

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to scan. Default: entire project |
| `outputDir` | No | Where to write factory files. Default: detected `__mocks__/` or `src/test/mocks/` |
| `fix` | No | Rewrite test files to use factories. Default: `false` (report only) |
| `minDuplicates` | No | Min occurrences before consolidating. Default: `2` |
| `ignore` | No | File glob or mock names to skip |

## Step 1 — Discover all mocks

```bash
python3 .agents/skills/unified-mocks/scripts/runner.py \
  --mode discover \
  --project-dir <path-to-project>
```

Scan every test file (`*.test.ts`, `*.test.js`, `*.spec.ts`, `*.spec.js`) and step-definition files.

**Patterns detected:**

| Pattern | Framework |
|---|---|
| `jest.fn()`, `jest.mock('m')`, `jest.spyOn(obj, 'method')` | Jest |
| `vi.fn()`, `vi.mock('m')`, `vi.spyOn(obj, 'method')` | Vitest |
| `sinon.stub()`, `sinon.spy()`, `sinon.mock()` | Sinon / Mocha |
| Inline object literals assigned to `mock*` or `fake*` variables | Framework-agnostic |
| `nock('http://…')` intercepts | Nock |
| `msw` handler definitions | MSW |

Per mock, record: module path / object being mocked, specific method/property, return value(s), file path + line number, usage count across files.

Writes `.tdd/mock-inventory.json`.

## Step 2 — Identify duplication and inconsistency

```bash
python3 .agents/skills/unified-mocks/scripts/runner.py \
  --mode analyze \
  --project-dir <path-to-project>
```

Group mocks by identity (module + method). Within each group:

- **Exact duplicate** (identical return value in ≥ `minDuplicates` files) → consolidate with a single default
- **Near-duplicate** (same shape, different literal values) → consolidate with a factory that accepts overrides
- **Inconsistent** (different return shapes for the same module) → flag; may indicate intentional per-test variation

Writes `.tdd/mock-analysis.json` with a duplication score per group.

## Step 3 — Generate mock factory files

```bash
python3 .agents/skills/unified-mocks/scripts/runner.py \
  --mode generate \
  --project-dir <path-to-project>
```

For each group meeting the consolidation threshold, create a factory file in `outputDir`:

**Data entity factory:**
```typescript
// src/test/mocks/userMock.ts
export function createUserMock(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    name: 'Test User',
    email: 'test@example.com',
    role: 'user',
    ...overrides,
  };
}

export function createUserListMock(count = 3, overrides: Partial<User> = {}): User[] {
  return Array.from({ length: count }, (_, i) =>
    createUserMock({ id: `user-${i + 1}`, ...overrides })
  );
}
```

**API / HTTP mock factory (MSW):**
```typescript
// src/test/mocks/apiHandlers.ts
export const userHandlers = [
  http.get('/api/users/:id', ({ params }) =>
    HttpResponse.json(createUserMock({ id: params.id as string }))
  ),
];
```

**Naming conventions:**
- `create<Entity>Mock(overrides?)` for single-item factories
- `create<Entity>ListMock(count?, overrides?)` for list factories
- `mock<Service>()` for module mock setup functions

TypeScript projects: type the factory return value from the source module's type. Never use `any`.

## Step 4 — Rewrite test files (when `fix: true`)

```bash
python3 .agents/skills/unified-mocks/scripts/runner.py \
  --mode fix \
  --project-dir <path-to-project>
```

Replace inline mock literals with factory calls:

**Before:**
```typescript
const mockUser = { id: 'user-1', name: 'Test User', email: 'test@example.com', role: 'user' };
```
**After:**
```typescript
import { createUserMock } from '@/test/mocks/userMock';
const mockUser = createUserMock();
```

**Meaningful variation preserved as override:**
```typescript
// Before
const adminUser = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'admin' };
// After
const adminUser = createUserMock({ id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'admin' });
```

Rules:
- Preserve the variable name in the test file
- Add imports after existing imports, sorted alphabetically
- Run `--testPathPattern <file>` after each rewrite; if the file breaks, revert it and add to manual-review list

## Step 5 — Generate report

```bash
python3 .agents/skills/unified-mocks/scripts/runner.py \
  --mode report \
  --project-dir <path-to-project>
```

Writes `.tdd/unified-mocks-report.md`:

```markdown
## Unified Mocks Report — 2026-05-22

### Summary
- Mock definitions scanned: 87
- Unique mock identities:   14
- Duplicates consolidated:   9
- Inconsistencies flagged:   2
- Factory files created:     4
- Test files rewritten:     11

### Factory files created
| Factory | Files freed |
|---|---|
| src/test/mocks/userMock.ts    | 6 |
| src/test/mocks/orderMock.ts   | 4 |
| src/test/mocks/productMock.ts | 3 |
| src/test/mocks/apiHandlers.ts | 5 |

### Inconsistencies requiring manual review
- `src/services/auth.ts` → `login()` returns `{ token }` in 3 files,
  `{ accessToken }` in 1 file. Suggestion: create a factory and override per-test.
```

## Convenience: run the full pipeline

```bash
python3 .agents/skills/unified-mocks/scripts/runner.py \
  --mode run \
  --project-dir <path-to-project>
```

Runs Steps 1–5 in sequence.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Output structure

```
src/test/mocks/             ← or detected __mocks__/ equivalent
  userMock.ts
  orderMock.ts
  apiHandlers.ts

.tdd/
  mock-inventory.json
  mock-analysis.json
  unified-mocks-report.md
```

## Edge cases

- **Mixed frameworks** (Jest + Sinon): generate framework-agnostic factories (plain objects/functions); keep `jest.mock(…)` calls in test files
- **Complex `jest.mock` factories**: extract the factory body into the mock file; keep the `jest.mock` call in test files pointing to it
- **Circular imports**: place the factory in `test/mocks/` outside `src/` rather than co-located with source
- **Snapshot tests** (`toMatchSnapshot`): not affected — only inline object literal mocks are consolidated
- **Date / time mocks** (`jest.useFakeTimers`, `vi.setSystemTime`): detect and flag but do not consolidate — these are control-flow mocks
- **Large return objects (>20 properties)**: generate the factory with all properties; add `// generated — trim to what tests actually need`
- **`minDuplicates: 1`**: creates a factory for every mock regardless of duplication — useful for enforcing the pattern on a greenfield project

## Success criteria

- Every mock appearing in ≥ `minDuplicates` test files has a corresponding factory function
- Factory functions accept an `overrides` parameter and merge with defaults
- All test files pass after rewriting
- No test file has duplicate inline mock objects for the same entity
- Factory files are typed (TypeScript projects) — no `any` types
- Report lists every factory created and every inconsistency requiring manual review
