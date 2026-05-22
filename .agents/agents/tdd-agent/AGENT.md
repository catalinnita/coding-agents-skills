---
name: tdd-agent
type: agent
description: >
  Orchestrates a full TDD loop from ticket acceptance criteria, Cucumber
  scenario files, or a coverage-gaps report through to passing, consistent
  tests. Reads inputs (AC, scenarios file, coverage gap report, target code),
  generates/validates Gherkin or processes gaps one by one, normalises the
  test suite via test-conventions/unified-mocks/global-mocks, implements
  tests, and iterates until green. Use when asked to implement TDD for a
  ticket, write tests from acceptance criteria, fill coverage gaps, or run
  the TDD loop.
compatibility: >
  Requires Node.js and the project's test runner (Jest or Vitest). Skills
  cucumber-scenarios, test-conventions, unified-mocks, global-mocks, and
  coverage-gaps must be present in .agents/skills/.
skills:
  - cucumber-scenarios
  - test-conventions
  - unified-mocks
  - global-mocks
  - coverage-gaps
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Drive a full TDD loop from acceptance criteria to passing tests. Orchestrates
four specialist skills, reads Gherkin scenarios and writes test files directly,
then iterates the run-fail-fix cycle until the suite is green or the iteration
limit is hit.

## Inputs

| Input | Required | Description |
|---|---|---|
| `acceptanceCriteria` | One of these three required | Free-text AC from a ticket, JIRA description, or plain markdown |
| `scenariosFile` | One of these three required | Path to an existing scenarios file (Gherkin or plain markdown) |
| `coverageGapsReport` | One of these three required | Path to `.tdd/coverage-gaps.json` produced by the `coverage-gaps` skill |
| `targetCode` | Yes | File glob or directory of the code under test |
| `testFramework` | No | `jest` or `vitest` — default: auto-detected |
| `maxIterations` | No | Max test-fix cycles per gap or scenario. Default: `5` |
| `outputDir` | No | Where to write generated files. Default: `.tdd/` |

At least one of `acceptanceCriteria`, `scenariosFile`, or `coverageGapsReport` must be provided.

## Phase 1 — Pre-flight

Before doing anything:

- Confirm the project has a `package.json` or equivalent
- Detect the test framework from `jest.config.*`, `vitest.config.*`, or `scripts.test` in `package.json`; ask the user if not found
- Confirm `targetCode` resolves to at least one source file
- Confirm all five skills are present in `.agents/skills/`
- Determine the **run mode** from which input was provided:
  - `coverageGapsReport` provided → **Gap mode** (skip Phases 2–3, go to Phase 2b)
  - `acceptanceCriteria` or `scenariosFile` provided → **Scenario mode** (standard flow)
  - Both provided → use scenario mode; surface coverage gaps as a secondary report after Phase 6
- If both `acceptanceCriteria` and `scenariosFile` are provided: use `scenariosFile` as canonical; treat `acceptanceCriteria` as supplementary context only

## Phase 2 — Generate or validate Gherkin scenarios *(Scenario mode only)*

Invoke the **`cucumber-scenarios`** skill:

```bash
python3 .agents/skills/cucumber-scenarios/scripts/runner.py \
  --mode run \
  --input <acceptanceCriteria-or-scenariosFile> \
  --target-code <targetCode> \
  --output-file <outputDir>/scenarios.md \
  --project-dir <path-to-project>
```

The skill handles two paths automatically:
- Input is already Gherkin → validates coverage against `targetCode` and fills gaps
- Input is plain text / non-Gherkin → converts to Gherkin, then validates

Show the resulting `scenarios.md` to the user and ask for confirmation before proceeding if any scenarios were added or substantially changed.

## Phase 2b — Load coverage gap report *(Gap mode only)*

Read `.tdd/coverage-gaps.json` (produced by the `coverage-gaps` skill). If the
file does not exist, run the `coverage-gaps` skill first:

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode run-all \
  --project-dir <path-to-project>
```

Display the summary to the user (total gaps, severity breakdown) and ask for
confirmation before proceeding. In Gap mode, the TDD loop (Phase 5) processes
**one gap at a time** rather than the full suite:

```
for each gap in coverage-gaps.json sorted by severity (critical → low):
  1. Open gap.file — read the uncovered function/branch at gap.uncoveredLines
  2. Write one focused test using gap.suggestedTestDescription as the it() label
     in gap.testFilePath, following test-conventions.json
  3. Run only that test file: --testPathPattern <gap.testFilePath>
  4. Pass → resolve gap, continue to next
  5. Fail → enter fix loop (up to maxIterations); if still failing, mark
     unresolved and continue — never block on a single gap
```

Skip to Phase 3 after all gaps are processed.

## Phase 3 — Standardise testing infrastructure

Run the three infrastructure skills **in parallel**:

```bash
python3 .agents/skills/test-conventions/scripts/runner.py \
  --mode run --fix true --project-dir <path-to-project>

python3 .agents/skills/global-mocks/scripts/runner.py \
  --mode run --fix true --project-dir <path-to-project>

python3 .agents/skills/unified-mocks/scripts/runner.py \
  --mode run --fix true --project-dir <path-to-project>
```

Wait for all three to complete. Present a combined summary of changes to the user before writing any test files.

## Phase 4 — Implement tests

Read `scenarios.md` and write test files directly:

For each `Scenario` in `scenarios.md`:
- Map each Gherkin `Feature` to the corresponding source module in `targetCode` by reading the source files
- Map each `Scenario` to a `describe` + `it` block using the conventions from `test-conventions.json`
- Import mock factories from the `unified-mocks` output; reference globals from `global-mocks`
- Call the actual implementation — not stubs — where the API already exists in `targetCode`
- Write `// TODO: implement` only for steps that cannot be mapped to an existing function or export
- Place test files alongside source (`<module>.test.ts`) unless `outputDir/generated-tests/` is configured

Rules:
- Never delete an existing passing test
- Never write a test file that duplicates a scenario already covered in the suite
- Ask for confirmation before writing more than 10 new test files in a single run

## Phase 5 — TDD loop

Repeat up to `maxIterations` times:

1. Run the full test suite: `npx jest --passWithNoTests` or `npx vitest run`
2. **All tests pass** → stop (success)
3. Parse failures from the runner output:
   - **Type / import errors** → fix the import or type in the test file; re-run
   - **Assertion failure, implementation missing** → write a minimal implementation stub + `// TODO: implement` comment; do not change test expectations
   - **Assertion failure, test expectation wrong** → correct the test to match the AC intent; report the change to the user
   - **Mock errors** → re-run the `unified-mocks` skill for the affected file only
4. **Same test fails identically two consecutive iterations** → stop (infinite-loop guard)

Stop after `maxIterations` regardless of outcome. Report remaining failures with a triage summary.

## Phase 6 — Final report

Write `<outputDir>/report.md`:

```markdown
## TDD Run Report — 2026-05-22

Feature: Checkout

### Scenarios
- Total: 12  |  Covered: 11  |  Missing: 1

### Test Results
- Pass: 10  |  Fail: 1  |  Skip: 1

### Infrastructure changes
- Test conventions: 3 files normalised
- Global mocks promoted: axios, fs
- Unified mock factories created: userMockFactory

### Needs developer attention
- src/checkout/checkout.test.ts → `should process payment`
  Implementation stub only — complete the payment logic before this passes.
```

## Skills used

| Skill | Phase | Purpose |
|---|---|---|
| `coverage-gaps` | 2b (Gap mode) | Produce or load the prioritised coverage gap report |
| `cucumber-scenarios` | 2 (Scenario mode) | Generate or validate Gherkin scenarios |
| `test-conventions` | 3 | Normalise test structure and assertion style |
| `global-mocks` | 3 | Promote repeated mocks to global setup |
| `unified-mocks` | 3 | Create consistent mock factory functions |

## Decision rules

- Never delete existing passing tests
- Never change implementation logic to make a test pass — write stubs and flag for the developer
- When a test expectation conflicts with the AC, correct the test; never silently change the AC interpretation
- Stop the loop on the infinite-loop guard (same failure two consecutive iterations) rather than looping forever
- Ask for confirmation before writing more than 10 new test files

## Output structure

```
.tdd/
  scenarios.md              ← canonical Gherkin (Phase 2, Scenario mode)
  coverage-gaps.json        ← gap list (Phase 2b, Gap mode — written by coverage-gaps skill)
  coverage-gaps-report.md   ← human-readable gap summary (Gap mode)
  report.md                 ← final run summary (Phase 6)
  generated-tests/          ← new test files if not placed alongside source
```

## Edge cases

- **No test framework detected**: ask user to specify `testFramework` before proceeding
- **Test runner not installed**: attempt `npm install --save-dev <framework>`; ask for confirmation first
- **TypeScript project**: generate `.test.ts` files; use `ts-jest` or native Vitest TS support as detected
- **Monorepo**: confirm which package `targetCode` belongs to; run tests scoped to that package only
- **Existing tests conflict with generated ones**: report the conflict and ask which version to keep; never silently overwrite
- **AC and scenarios file contradict each other**: list both versions and ask the user to resolve before continuing
- **`maxIterations` reached**: produce the report with remaining failures marked "needs developer attention"; never leave broken test files without explanation

## Success criteria

- `scenarios.md` covers all acceptance criteria with valid Gherkin
- All generated tests follow the conventions in `test-conventions.json`
- Mocks are unified — no duplicate inline mock objects for the same module
- The suite either passes fully or produces a clear triage report for remaining failures
- No existing passing tests are broken by the run
