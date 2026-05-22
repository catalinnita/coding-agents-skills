# Skill Spec: Global Mocks

## Goal

Identify modules that are mocked individually inside many test files and promote
them to global mocks — using the test framework's `setupFiles`, `__mocks__`
directory, or equivalent — so each test file gets the mock automatically without
needing to declare it, and a single place controls the default behaviour.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "define global mocks"
- "set up global mocks"
- "promote mocks to global"
- "stop repeating mocks in every test file"
- "add mocks to setupFiles"
- "create `__mocks__` for X"

Also invoked by the **TDD Orchestrator** agent as part of Phase 2.

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to scan. Default: entire project |
| `fix` | No | `true` to create global mock files and update config. Default: `false` (report only) |
| `threshold` | No | Min number of test files mocking the same module before it is promoted. Default: `3` |
| `ignore` | No | Module paths to never promote (e.g. modules that need per-test behaviour) |
| `outputDir` | No | Where to write `__mocks__` files. Default: project root `__mocks__/` (node_modules mocks) or co-located with source (module mocks) |

---

## Behavior

### Step 1 — Inventory per-file mocks

Scan every test file for module-level mock declarations:

**Detected patterns:**

| Pattern | Framework |
|---|---|
| `jest.mock('module-name')` | Jest — auto-mock |
| `jest.mock('module-name', () => ({ … }))` | Jest — manual factory |
| `vi.mock('module-name')` | Vitest — auto-mock |
| `vi.mock('module-name', () => ({ … }))` | Vitest — manual factory |
| `jest.mock('../relative/path')` | Jest — relative module |
| `nock.cleanAll()` + `nock('http://…')` in `beforeEach` | Nock HTTP intercepts |
| `server.use(…)` with MSW handlers in `beforeEach` / `beforeAll` | MSW |

For each detected mock, record:
- **Module specifier**: exact string passed to `jest.mock` / `vi.mock`
- **Factory content**: the return value / implementation (if a factory is provided)
- **Location**: test file path + line number
- **Scope**: top-level (auto-applied) vs inside `beforeEach` (re-applied per test)

Writes `.tdd/global-mocks-inventory.json`.

### Step 2 — Identify promotion candidates

Group mocks by module specifier. A module is a **promotion candidate** when:
- It is mocked (with identical or near-identical factory) in ≥ `threshold` test files, AND
- Its factory does not contain test-specific data (variables from the outer `describe` scope, unique IDs, per-test overrides)

**Not promoted:**
- Mocks with factories that reference per-test variables
- Mocks where different test files deliberately return different shapes from the same module
- Modules listed in `ignore`
- Modules that are already globally mocked (present in `setupFiles` or `__mocks__/`)

For each candidate, record whether it is:
- A **node_modules package** (e.g. `axios`, `fs`, `next/router`) — goes in root `__mocks__/`
- A **project module** (e.g. `../../lib/logger`) — goes in a `__mocks__/` adjacent to the source file

### Step 3 — Create global mock files (when `fix: true`)

**For node_modules packages** — create `<root>/__mocks__/<package-name>.ts`:

```typescript
// __mocks__/axios.ts
import { vi } from 'vitest';

const mockAxios = {
  get: vi.fn().mockResolvedValue({ data: {} }),
  post: vi.fn().mockResolvedValue({ data: {} }),
  put: vi.fn().mockResolvedValue({ data: {} }),
  delete: vi.fn().mockResolvedValue({ data: {} }),
  create: vi.fn().mockReturnThis(),
  defaults: { headers: { common: {} } },
};

export default mockAxios;
```

**For project modules** — create `<source-dir>/__mocks__/<module-name>.ts`:

```typescript
// src/lib/__mocks__/logger.ts
import { vi } from 'vitest';

export const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
```

**For MSW** — consolidate handlers into a global server setup file:

```typescript
// src/test/setup/server.ts
import { setupServer } from 'msw/node';
import { userHandlers } from '../mocks/apiHandlers';
import { orderHandlers } from '../mocks/orderHandlers';

export const server = setupServer(...userHandlers, ...orderHandlers);
```

**Naming rules:**
- Match the original module name exactly (Jest and Vitest resolve `__mocks__` by name)
- TypeScript projects: `.ts` extension; JavaScript projects: `.js`
- Export names must match the real module's named exports

### Step 4 — Update test framework config

Add or update `setupFiles` / `setupFilesAfterFramework` in the test framework config to activate the global mocks:

**Vitest (`vitest.config.ts`):**
```typescript
export default defineConfig({
  test: {
    setupFiles: ['./src/test/setup/vitest.setup.ts'],
  },
});
```

**Jest (`jest.config.ts`):**
```typescript
module.exports = {
  setupFilesAfterFramework: ['<rootDir>/src/test/setup/jest.setup.ts'],
};
```

Create the setup file if it doesn't exist:

```typescript
// src/test/setup/vitest.setup.ts
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server';   // MSW — only if used

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

If the config already has `setupFiles`, append to the array rather than replacing.

### Step 5 — Remove per-file mock declarations

For each test file that mocked a now-global module, remove the redundant declaration:

**Before:**
```typescript
vi.mock('axios');   // ← now global, remove this

describe('UserService', () => { … });
```

**After:**
```typescript
describe('UserService', () => { … });
```

For factories that were per-file but are now global, keep only the parts that are test-specific as local `mockReturnValueOnce` / `mockImplementationOnce` overrides:

**Before:**
```typescript
vi.mock('axios', () => ({ default: { get: vi.fn().mockResolvedValue({ data: users }) } }));
```

**After (global mock handles default; test overrides the return value):**
```typescript
import axios from 'axios';
// axios is globally mocked — just override the return value for this test
vi.mocked(axios.get).mockResolvedValueOnce({ data: users });
```

Run tests after each file is modified. If a file breaks, revert only that file.

### Step 6 — Generate report

Write `.tdd/global-mocks-report.md`:

```markdown
## Global Mocks Report — 2026-05-22

### Summary
- Test files scanned: 34
- Unique mocked modules: 18
- Promoted to global:   6
- Skipped (per-test variation): 4
- Already global: 2
- Below threshold (<3 files): 6

### Global mocks created
| Module | Type | Files freed | Mock file |
|---|---|---|---|
| `axios` | node_module | 8 | `__mocks__/axios.ts` |
| `next/router` | node_module | 5 | `__mocks__/next/router.ts` |
| `src/lib/logger` | project | 4 | `src/lib/__mocks__/logger.ts` |
| `src/lib/analytics` | project | 3 | `src/lib/__mocks__/analytics.ts` |
| MSW handlers | msw | 6 | `src/test/setup/server.ts` |

### Skipped — per-test variation (needs manual decision)
- `src/services/featureFlags.ts` — mocked with 3 different return values across
  test files; cannot safely choose a default. Suggestion: create a factory
  function and mock per-test with `mockReturnValueOnce`.

### Config updated
- `vitest.config.ts` — setupFiles updated
- `src/test/setup/vitest.setup.ts` — created
```

---

## Output structure

```
__mocks__/                        ← node_modules global mocks
  axios.ts
  next/
    router.ts

src/
  lib/
    __mocks__/                    ← project module global mocks
      logger.ts
      analytics.ts
  test/
    setup/
      vitest.setup.ts             ← or jest.setup.ts
      server.ts                   ← MSW server (if used)

.tdd/
  global-mocks-inventory.json
  global-mocks-report.md
```

---

## Edge cases and constraints

- **`__mocks__` directory placement**: Jest and Vitest resolve node_module mocks from root `__mocks__/`; project module mocks from a `__mocks__/` adjacent to the source file — enforce this distinction, never mix
- **`automock: true`**: if the project already uses `automock`, skip manual mock files for auto-mocked modules and only handle modules that need a custom factory
- **Scoped packages** (`@scope/package`): create the mock at `__mocks__/@scope/package.ts` — the directory path must mirror the scope structure
- **Dynamic mock factories** (factory function reads environment variables or imports other modules): do not promote — flag for manual review
- **Mock reset strategy**: the generated setup file always calls `resetHandlers()` / `clearAllMocks()` in `afterEach` so global mocks don't leak state between tests; document this in the setup file
- **Conflicting global + local mock**: if a test file has both a now-global mock and a local override for the same module, the local override wins (standard Jest/Vitest resolution); the skill only removes top-level `vi.mock()` calls, not inline overrides
- **Non-test files importing `__mocks__`**: the `__mocks__` directory is only resolved during tests; never import from it in production code — flag any such import found during scanning

---

## Success criteria

- Every module mocked in ≥ `threshold` test files has a corresponding global mock file
- `setupFiles` config is updated and the setup file is valid and importable
- All test files that previously mocked promoted modules have those declarations removed
- No test that passed before breaks after promotion
- Mock state does not leak between tests (reset in `afterEach`)
- The report lists every promoted module, every skip with reason, and every config change made
