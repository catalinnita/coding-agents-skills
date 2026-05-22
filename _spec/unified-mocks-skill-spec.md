# Skill Spec: Unified Mocks

## Goal

Scan the test suite for all mock definitions, identify duplication and
inconsistency, consolidate them into shared mock factory functions, and replace
inline mock literals throughout the codebase with calls to those factories. The
result is a single source of truth for each mocked entity that is easy to
update and extend.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "create unified mocks"
- "consolidate mocks across tests"
- "extract shared mock factories"
- "remove duplicate mocks"
- "make mocks consistent across test files"
- "create a mock factory for X"

Also invoked by the **TDD Orchestrator** agent as part of Phase 2.

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to scan. Default: entire project source |
| `outputDir` | No | Where to write mock factory files. Default: detected `__mocks__/` or `src/test/mocks/` |
| `fix` | No | `true` to rewrite test files to use factories. Default: `false` (report only) |
| `minDuplicates` | No | Min number of duplicate occurrences before consolidating. Default: `2` |
| `ignore` | No | File glob or mock names to skip |

---

## Behavior

### Step 1 — Discover all mocks

Scan every test file (`*.test.ts`, `*.test.js`, `*.spec.ts`, `*.spec.js`) and step-definition files for mock definitions:

**Patterns detected:**

| Pattern | Framework |
|---|---|
| `jest.fn()`, `jest.mock('module')`, `jest.spyOn(obj, 'method')` | Jest |
| `vi.fn()`, `vi.mock('module')`, `vi.spyOn(obj, 'method')` | Vitest |
| `sinon.stub()`, `sinon.spy()`, `sinon.mock()` | Sinon (Mocha) |
| Inline object literals assigned to variables named `mock*` or `fake*` | Framework-agnostic |
| `nock('http://...')` HTTP intercepts | Nock |
| `msw` handler definitions | MSW |

For each mock, record:
- **Identity**: the module path or object being mocked, and the specific method/property
- **Return value(s)**: the hardcoded data the mock returns (including nested objects)
- **Location**: file path + line number
- **Usage count**: how many test files define an identical or near-identical version of this mock

Writes `<outputDir>/../.tdd/mock-inventory.json`.

### Step 2 — Identify duplication and inconsistency

Group mocks by identity (module + method). Within each group:

**Duplication** (same mock defined in ≥ `minDuplicates` files):
- Identical return value: exact duplicate → consolidate
- Similar return value (same shape, different literal values): near-duplicate → consolidate with a factory function that accepts overrides

**Inconsistency** (same module mocked differently across files):
- Different return value shapes: flag as inconsistent — may indicate tests testing different states
- Different mock strategies (`jest.mock` vs `jest.spyOn`): flag and standardise to the project's predominant approach

Writes `<outputDir>/../.tdd/mock-analysis.json` with a duplication score per group.

### Step 3 — Generate mock factory files

For each group that meets the consolidation threshold:

**Factory shape:**

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

**Naming conventions:**
- `create<Entity>Mock(overrides?)` for single-item factories
- `create<Entity>ListMock(count?, overrides?)` for list factories
- `mock<ServiceName>()` for service/module mock setup functions that call `jest.mock` / `vi.mock`

**For API / HTTP mocks (nock / MSW):**

```typescript
// src/test/mocks/apiHandlers.ts

export const userHandlers = [
  http.get('/api/users/:id', ({ params }) =>
    HttpResponse.json(createUserMock({ id: params.id as string }))
  ),
];
```

Place all factory files in `outputDir`, organised by domain (`userMock.ts`, `orderMock.ts`, `apiHandlers.ts`).

### Step 4 — Rewrite test files (when `fix: true`)

Replace inline mock literals in each test file with calls to the factory:

**Before:**
```typescript
const mockUser = { id: 'user-1', name: 'Test User', email: 'test@example.com', role: 'user' };
```

**After:**
```typescript
import { createUserMock } from '@/test/mocks/userMock';
const mockUser = createUserMock();
```

**Before (with variation):**
```typescript
const adminUser = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'admin' };
```

**After:**
```typescript
const adminUser = createUserMock({ id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'admin' });
```

Rules when rewriting:
- Never remove a variation that is meaningful (a test specifically asserting on a non-default value should keep that value as an explicit override)
- Preserve the variable name in the test file
- Add the import statement at the top of the file, after existing imports, sorted alphabetically
- Run the test suite after rewriting; if any test breaks, revert that file and report it

### Step 5 — Generate report

Write `<outputDir>/../.tdd/unified-mocks-report.md`:

```markdown
## Unified Mocks Report — 2026-05-22

### Summary
- Mock definitions scanned: 87
- Unique mock identities: 14
- Duplicates consolidated: 9
- Inconsistencies flagged: 2
- Factory files created: 4
- Test files rewritten: 11 (fix: true)

### Factory files created
- src/test/mocks/userMock.ts     (used in 6 test files)
- src/test/mocks/orderMock.ts    (used in 4 test files)
- src/test/mocks/productMock.ts  (used in 3 test files)
- src/test/mocks/apiHandlers.ts  (used in 5 test files)

### Inconsistencies requiring manual review
- `src/services/auth.ts` mock: 3 files mock `login()` returning `{ token }`,
  1 file returns `{ accessToken }` — these may be intentional; review before merging
```

---

## Output structure

```
src/test/mocks/             ← or detected __mocks__/ equivalent
  userMock.ts
  orderMock.ts
  apiHandlers.ts
  ...

.tdd/
  mock-inventory.json
  mock-analysis.json
  unified-mocks-report.md
```

---

## Edge cases and constraints

- **Mixed frameworks in one project** (Jest + Sinon): generate factories that are framework-agnostic (plain objects / functions); the mock setup wrappers (`jest.mock(…)` calls) stay in test files
- **Mocks with complex setup** (`jest.mock('module', () => ({ … }))` with factory functions): extract the factory function body into the mock file; keep the `jest.mock` call in test files pointing to the extracted factory
- **Type safety**: if the project uses TypeScript, infer the type of the mocked entity from the import and type the factory accordingly; do not use `any`
- **Circular dependencies**: if the mock factory would create a circular import, place it in a `test/mocks/` directory outside `src/` rather than co-located with the source
- **Snapshot mocks**: `toMatchSnapshot()` tests are not affected; only inline object literal mocks are consolidated
- **Date / time mocks** (`jest.useFakeTimers`, `vi.setSystemTime`): detect and flag but do not consolidate — these are control-flow mocks, not data mocks
- **Large return objects** (>20 properties): generate the factory with all properties, add a comment `// generated — trim to what tests actually need`
- **`minDuplicates: 1`**: creates a factory for every mock regardless of duplication — useful for enforcing the pattern on a greenfield project

---

## Success criteria

- Every mock that appears in ≥ `minDuplicates` test files has a corresponding factory function
- Factory functions accept an `overrides` parameter and merge with defaults
- All test files pass after rewriting (when `fix: true`)
- No test file has duplicate inline mock objects for the same entity
- Factory files are typed (TypeScript projects only) — no `any` types
- Report accurately lists every factory created and every inconsistency requiring manual review
