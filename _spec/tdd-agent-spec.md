# Agent Spec: TDD Orchestrator

## Goal

An agent that drives a full TDD loop from ticket acceptance criteria or existing
scenario files through to passing, consistent tests. It accepts three inputs
(acceptance criteria, a scenarios file, and the target code), orchestrates the
skills below to generate or validate Cucumber scenarios, implement tests, run
them, and iterate until everything is green.

---

## Trigger conditions

Invoke this agent when the user asks to:
- "implement TDD for this ticket / feature"
- "write tests from the acceptance criteria"
- "make these scenarios pass"
- "run the TDD loop"
- "generate and run tests from this spec"
- "validate my scenarios against the code"

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `acceptanceCriteria` | One of these three required | Free-text AC from a ticket, JIRA description, or plain markdown |
| `scenariosFile` | One of these three required | Path to an existing scenarios file (Cucumber/Gherkin or plain markdown) |
| `targetCode` | One of these three required | File glob or directory of the code under test |
| `testFramework` | No | `jest`, `vitest`, `mocha` — default: auto-detected |
| `fix` | No | `true` to auto-fix failing tests. Default: `true` |
| `maxIterations` | No | Max test-fix cycles before stopping. Default: `5` |
| `outputDir` | No | Where to write generated files. Default: `.tdd/` |

At least one of `acceptanceCriteria` or `scenariosFile` must be provided together with `targetCode`.

---

## Agent Behaviour

### Phase 0 — Pre-flight

Before doing anything:
- Confirm the working directory is a recognisable project
- Detect the test framework (`jest.config.*`, `vitest.config.*`, `mocha.*`, or `scripts.test` in `package.json`)
- Confirm `targetCode` resolves to at least one file
- If both `acceptanceCriteria` and `scenariosFile` are provided, use `scenariosFile` as the canonical source and treat `acceptanceCriteria` as supplementary context

### Phase 1 — Generate or validate Cucumber scenarios

Invoke the **`cucumber-scenarios`** skill:

```
Input:  acceptanceCriteria OR scenariosFile (+ acceptanceCriteria as context)
        targetCode (for coverage validation)
Output: <outputDir>/scenarios.md — Gherkin-syntax scenarios
```

The skill handles two paths:
1. **Scenarios file is already Gherkin** — validate coverage against `targetCode` and fill any gaps
2. **Input is plain text / non-Gherkin** — convert to Gherkin first, then validate

The agent reviews the generated `scenarios.md` and asks the user to confirm before proceeding if any scenarios were added or changed significantly.

### Phase 2 — Standardise testing infrastructure

Run the following skills **in parallel** against the project before writing new tests:

**`test-conventions` skill**
```
Input:  targetCode directory
Output: report of detected conventions; applied changes if divergences found
```

**`global-mocks` skill**
```
Input:  targetCode directory
Output: `<setupFiles>` entries or `__mocks__/` additions; report of what was promoted
```

**`unified-mocks` skill**
```
Input:  targetCode directory + scenario list from Phase 1
Output: mock factory files or updated mocks; report of changes
```

Wait for all three to complete before proceeding. Present a combined summary to the user.

### Phase 3 — Implement tests

For each scenario in `scenarios.md`, generate a test file (or append to an existing one if tests for that module already exist):

- Map each Gherkin `Feature` to the corresponding source module in `targetCode`
- Map each `Scenario` to a `describe` + `it` block using the project's detected test conventions
- Use mock factories from the **`unified-mocks`** output; reference global mocks from the **`global-mocks`** output
- Import and call the actual implementation code (not a stub)
- Write `// TODO: implement` only for `Given`/`When`/`Then` steps that cannot be automatically mapped to API calls in `targetCode`

### Phase 4 — TDD loop

```
for iteration in 1..maxIterations:
  1. Run the test suite
  2. If all tests pass → exit loop (success)
  3. Parse failures:
     a. Type errors / import errors → fix imports, run again
     b. Assertion failures → inspect the implementation in targetCode:
        - If the implementation is missing → write a minimal implementation stub
          and add a TODO comment for the developer to complete
        - If the implementation exists but the test expectation is wrong →
          correct the test to match the intended behaviour (report the change)
     c. Mock errors → regenerate affected mocks via unified-mocks skill
  4. Re-run tests
```

Stop after `maxIterations` regardless of outcome; report remaining failures with
a triage summary.

### Phase 5 — Final report

Write `<outputDir>/report.md`:

```
## TDD Run Report

Feature: <feature name>
Date:    2026-05-22

### Scenarios
- Total:   12
- Covered: 11
- Missing:  1  (listed below)

### Test Results
- Pass:  10
- Fail:   1
- Skip:   1

### Infrastructure changes
- Test conventions applied: 3 files normalised
- Global mocks added: 2 (axios, fs)
- Unified mock factories created: 1 (userMockFactory)

### Failing tests (need developer attention)
- `src/checkout/checkout.test.ts` → `should process payment` — implementation stub only
```

---

## Skills used

| Skill | Phase | Purpose |
|---|---|---|
| `cucumber-scenarios` | 1 | Generate or validate Gherkin scenarios |
| `test-conventions` | 2 | Normalise test structure and assertion style |
| `global-mocks` | 2 | Promote repeated mocks to global setup |
| `unified-mocks` | 2 | Create consistent mock factories |

---

## Decision rules

- **Never delete existing passing tests** — only add or fix
- **Never change implementation logic** to make a test pass; write stubs and flag for the developer
- **Correct tests over correcting implementations** when the test expectation conflicts with clear intent in `acceptanceCriteria`
- **Stop the loop early** if the same test fails identically across two consecutive iterations (infinite loop guard)
- **Ask for confirmation** before writing more than 10 new test files in a single run

---

## Output structure

```
.tdd/
  scenarios.md          ← canonical Gherkin scenarios (Phase 1 output)
  report.md             ← final summary
  generated-tests/      ← new test files (if not placed alongside source)
```

---

## Edge cases and constraints

- **No test framework detected**: ask the user to specify `testFramework` before proceeding
- **Test runner not installed**: attempt `npm install --save-dev <framework>`; ask for confirmation first
- **TypeScript project**: generate `.test.ts` files; use `ts-jest` or `vitest` with native TS support as detected
- **Monorepo**: if multiple `package.json` files exist, confirm which package `targetCode` belongs to and run tests scoped to that package
- **Existing tests in conflict**: if a test file already covers the same scenario with a different implementation, report the conflict and ask which version to keep
- **Acceptance criteria and scenarios contradict each other**: flag the contradiction, list both versions, and ask the user to resolve before continuing
- **`maxIterations` reached**: produce the report with remaining failures clearly marked as "needs developer attention"; do not leave broken test files without explanation

---

## Success criteria

- `scenarios.md` covers all acceptance criteria with valid Gherkin syntax
- All generated tests follow the project's detected testing conventions
- Mocks are unified, no duplicate inline mocks for the same module
- The test suite either passes fully or produces a clear triage report for remaining failures
- No existing passing tests are broken by the run
