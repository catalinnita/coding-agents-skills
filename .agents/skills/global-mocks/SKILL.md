---
name: global-mocks
description: >
  Identifies modules mocked individually in many test files and promotes them
  to global mocks via setupFiles or __mocks__ directories so each test file
  gets them automatically. Removes redundant per-file mock declarations and
  wires up MSW server reset in afterEach. Use when asked to define global
  mocks, promote mocks to global, set up setupFiles, create __mocks__ for a
  module, or stop repeating mocks in every test file.
compatibility: >
  Requires Python 3.10+. Config updates require Jest or Vitest. MSW server
  wiring requires msw >= 1.0 installed in the project.
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Promote repeated per-file mocks to global test setup. Scans test files for
module-level mock declarations, identifies which modules are mocked in enough
files to warrant globalising, creates `__mocks__/` files or `setupFiles`
entries, removes the now-redundant per-file declarations, and wires up state
reset in `afterEach` so mocks don't leak between tests.

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to scan. Default: entire project |
| `fix` | No | Create global mock files and update config. Default: `false` (report only) |
| `threshold` | No | Min test files mocking the same module before promotion. Default: `3` |
| `ignore` | No | Module paths to never promote |
| `outputDir` | No | Where to write `__mocks__` files. Default: project root `__mocks__/` for node_modules; co-located for project modules |

## Step 1 — Inventory per-file mocks

```bash
python3 .agents/skills/global-mocks/scripts/runner.py \
  --mode discover \
  --project-dir <path-to-project>
```

Scan every test file for module-level mock declarations:

**Detected patterns:**

| Pattern | Framework |
|---|---|
| `jest.mock('module')` / `jest.mock('module', () => (…))` | Jest |
| `vi.mock('module')` / `vi.mock('module', () => (…))` | Vitest |
| `jest.mock('../relative/path')` | Jest — relative module |
| `nock.cleanAll()` + `nock('http://…')` in `beforeEach` | Nock |
| `server.use(…)` with MSW handlers in `beforeEach` / `beforeAll` | MSW |

Per mock, record: module specifier, factory content, file path + line, scope (top-level vs inside a hook).

Writes `.tdd/global-mocks-inventory.json`.

## Step 2 — Identify promotion candidates

```bash
python3 .agents/skills/global-mocks/scripts/runner.py \
  --mode analyze \
  --project-dir <path-to-project>
```

A module is a **promotion candidate** when:
- Mocked in ≥ `threshold` test files, **and**
- Its factory does not reference per-test variables (outer `describe` scope, unique IDs, per-test overrides)

**Not promoted:**
- Factories referencing per-test variables
- Modules mocked with different shapes across files (flag instead)
- Modules in `ignore`
- Modules already in `setupFiles` or `__mocks__/`

Classify each candidate as:
- **node_modules package** (`axios`, `fs`, `next/router`) → root `__mocks__/`
- **project module** (`../../lib/logger`) → `__mocks__/` adjacent to the source file

## Step 3 — Create global mock files (when `fix: true`)

```bash
python3 .agents/skills/global-mocks/scripts/runner.py \
  --mode generate \
  --project-dir <path-to-project>
```

**node_modules mock** — `<root>/__mocks__/<package>.ts`:
```typescript
// __mocks__/axios.ts
import { vi } from 'vitest';

const mockAxios = {
  get:     vi.fn().mockResolvedValue({ data: {} }),
  post:    vi.fn().mockResolvedValue({ data: {} }),
  put:     vi.fn().mockResolvedValue({ data: {} }),
  delete:  vi.fn().mockResolvedValue({ data: {} }),
  create:  vi.fn().mockReturnThis(),
  defaults: { headers: { common: {} } },
};

export default mockAxios;
```

**project module mock** — `<source-dir>/__mocks__/<module>.ts`:
```typescript
// src/lib/__mocks__/logger.ts
import { vi } from 'vitest';

export const logger = {
  info:  vi.fn(),
  warn:  vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
```

**MSW handler consolidation** — `src/test/setup/server.ts`:
```typescript
import { setupServer } from 'msw/node';
import { userHandlers } from '../mocks/apiHandlers';
import { orderHandlers } from '../mocks/orderHandlers';

export const server = setupServer(...userHandlers, ...orderHandlers);
```

**Naming rules:**
- Match the original module name exactly (Jest and Vitest resolve `__mocks__` by name)
- TypeScript projects: `.ts` extension; JavaScript: `.js`
- Export names must match the real module's named exports
- Scoped packages (`@scope/pkg`) → `__mocks__/@scope/pkg.ts`

## Step 4 — Update test framework config

```bash
python3 .agents/skills/global-mocks/scripts/runner.py \
  --mode update-config \
  --project-dir <path-to-project>
```

Add or update `setupFiles` in the test framework config:

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
import { server } from './server';  // only if MSW is used

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());  // prevent handler leak between tests
afterAll(() => server.close());
```

If `setupFiles` already exists in the config, append to the array — never replace.

## Step 5 — Remove redundant per-file declarations

```bash
python3 .agents/skills/global-mocks/scripts/runner.py \
  --mode clean \
  --project-dir <path-to-project>
```

Remove the top-level `vi.mock()` / `jest.mock()` call for each promoted module from every test file that declared it. Keep local `mockReturnValueOnce` / `mockImplementationOnce` overrides — they are test-specific and still needed:

**Before:**
```typescript
vi.mock('axios');  // ← now global, remove

describe('UserService', () => { … });
```
**After:**
```typescript
describe('UserService', () => { … });
```

**Before (factory was per-file):**
```typescript
vi.mock('axios', () => ({ default: { get: vi.fn().mockResolvedValue({ data: users }) } }));
```
**After (global handles default; test only overrides the return value):**
```typescript
import axios from 'axios';
vi.mocked(axios.get).mockResolvedValueOnce({ data: users });
```

Run `--testPathPattern <file>` after each change. If a file breaks, revert only that file.

## Step 6 — Generate report

```bash
python3 .agents/skills/global-mocks/scripts/runner.py \
  --mode report \
  --project-dir <path-to-project>
```

Writes `.tdd/global-mocks-report.md`:

```markdown
## Global Mocks Report — 2026-05-22

### Summary
- Test files scanned:       34
- Unique mocked modules:    18
- Promoted to global:        6
- Below threshold (<3):      6
- Per-test variation (skip): 4
- Already global:            2

### Global mocks created
| Module | Type | Files freed | Mock file |
|---|---|---|---|
| `axios` | node_module | 8 | `__mocks__/axios.ts` |
| `next/router` | node_module | 5 | `__mocks__/next/router.ts` |
| `src/lib/logger` | project | 4 | `src/lib/__mocks__/logger.ts` |
| MSW handlers | msw | 6 | `src/test/setup/server.ts` |

### Config updated
- `vitest.config.ts` — setupFiles updated
- `src/test/setup/vitest.setup.ts` — created

### Skipped — per-test variation
- `src/services/featureFlags.ts` — 3 different return values across files;
  cannot safely choose a default. Suggestion: use a factory with mockReturnValueOnce.
```

## Convenience: run the full pipeline

```bash
python3 .agents/skills/global-mocks/scripts/runner.py \
  --mode run \
  --project-dir <path-to-project>
```

Runs Steps 1–6 in sequence.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Output structure

```
__mocks__/                        ← node_modules global mocks
  axios.ts
  next/
    router.ts

src/lib/__mocks__/                ← project module global mocks
  logger.ts

src/test/setup/
  vitest.setup.ts                 ← or jest.setup.ts
  server.ts                       ← MSW server (if used)

.tdd/
  global-mocks-inventory.json
  global-mocks-report.md
```

## Edge cases

- **`__mocks__` placement**: node_modules mocks go in root `__mocks__/`; project module mocks go in a `__mocks__/` adjacent to the source file — never mix
- **`automock: true`**: skip manual mock files for auto-mocked modules; only handle modules needing a custom factory
- **Scoped packages** (`@scope/pkg`): create at `__mocks__/@scope/pkg.ts` — directory path must mirror the scope structure
- **Dynamic factories** (factory reads env vars or imports other modules): do not promote — flag for manual review
- **Mock reset**: setup file always calls `resetHandlers()` / `clearAllMocks()` in `afterEach` to prevent state leak; document this in the setup file
- **Conflicting global + local mock**: local `vi.mock()` overrides the global for that test file — the skill only removes top-level calls, not inline overrides
- **Non-test files importing `__mocks__`**: flag any such import found; `__mocks__/` is only resolved during tests and must never be imported in production code

## Success criteria

- Every module mocked in ≥ `threshold` test files has a global mock file
- `setupFiles` config is updated and the setup file is valid and importable
- All test files that previously declared a now-global mock have those declarations removed
- No test that passed before breaks after promotion
- Mock state does not leak between tests (`resetHandlers` / `clearAllMocks` in `afterEach`)
- Report lists every promoted module, every skip with reason, and every config change made
