---
name: coverage-gaps
description: >
  Runs the test suite with coverage enabled, parses the results, identifies
  every file, function, and branch that is untested or below configured
  thresholds, and produces a prioritised structured gap report that the
  tdd-agent reads to create tests one by one. Use when asked to find coverage
  gaps, show untested code, identify missing tests, or run coverage analysis.
compatibility: >
  Requires Python 3.10+ and Node.js. The project must have Jest or Vitest with
  a coverage provider installed (@vitest/coverage-v8 or equivalent).
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Identify test coverage gaps and produce a prioritised report for tdd-agent.
Runs the project's own test command with coverage enabled, parses the
`coverage-summary.json` output, classifies every gap by severity, and writes
`.tdd/coverage-gaps.json` (consumed by tdd-agent) and
`.tdd/coverage-gaps-report.md` (human-readable).

## Config (coverage-gaps.config.json)

| Key | Default | Description |
|---|---|---|
| `targetCode` | `"src"` | Source directory or glob to measure |
| `testCommand` | auto-detected | Command to run tests with coverage |
| `coverageDir` | `"coverage"` | Directory where the runner writes coverage output |
| `outputDir` | `".tdd"` | Where to write the gap report files |
| `thresholds.file` | `80` | Min file-level line coverage % |
| `thresholds.function` | `80` | Min function coverage % |
| `thresholds.branch` | `70` | Min branch coverage % |
| `thresholds.line` | `80` | Min line coverage % |
| `priority` | `"severity"` | `"severity"` \| `"file"` \| `"uncovered-first"` |
| `exclude` | `[]` | File globs to skip (e.g. `["**/*.d.ts"]`) |
| `includeUntested` | `true` | Include source files with no test file at all |
| `maxGaps` | `null` | Cap the report at N gaps (null = no cap) |

## Step 1 — Pre-flight

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode preflight \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

Auto-detect test command and coverage format if not configured:

| Signal | Test command | Coverage format |
|---|---|---|
| `vitest.config.*` | `vitest run --coverage` | `json`, `lcov` |
| `jest.config.*` | `jest --coverage` | `json`, `lcov` |
| `scripts.test` with vitest/jest | value + `--coverage` | `json` |

Confirm coverage provider is installed:
- Vitest: `@vitest/coverage-v8` or `@vitest/coverage-istanbul`
- Jest: built-in (no extra package needed)

If coverage provider is missing, print the install command and exit.
- Ensure `outputDir` (default `.tdd/`) is listed in the project's `.gitignore`; append it if missing — never prompt the user about this

## Step 2 — Run coverage

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode run \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

Execute `<testCommand>`. If the suite exits non-zero, flag the failure in the
report but continue to Step 3 — partial coverage data is still useful for
identifying gaps.

## Step 3 — Parse coverage data

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode parse \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

Read `<coverageDir>/coverage-summary.json`. For each source file in `targetCode`:
- Present in summary → extract line / function / branch percentages
- Absent from summary and `includeUntested: true` → mark as 0% across all metrics

Also parse `<coverageDir>/lcov.info` if available to extract individual function
names for uncovered entries (the JSON summary gives percentages; lcov gives names).

## Step 4 — Identify and classify gaps

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode identify \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

For each threshold breach, create a gap record:

```json
{
  "id": "gap-001",
  "file": "src/services/auth.ts",
  "type": "function",
  "name": "resetPassword",
  "severity": "critical",
  "currentCoverage": 0,
  "uncoveredLines": [88, 89, 90, 91, 92, 93],
  "uncoveredBranches": ["line 91: if (token.expired)"],
  "suggestedTestDescription": "resetPassword — should throw when token is expired",
  "hasTestFile": false,
  "testFilePath": "src/services/auth.test.ts"
}
```

**Severity rules:**

| Condition | Severity |
|---|---|
| File has no test file at all | `critical` |
| Function coverage = 0% | `critical` |
| Branch coverage = 0% on a conditional | `high` |
| Line coverage < 50% | `high` |
| Line coverage 50%–threshold | `medium` |
| Branch coverage 0%–threshold | `medium` |
| Above threshold but below 100% | `low` |

**`suggestedTestDescription` generation:**
- 0% function: `"<functionName> — should <verb derived from function name>"`
- Uncovered error branch: `"<functionName> — should handle <branch condition>"`
- Entire file untested: `"<filename> — basic smoke test for all exported functions"`

Sort by severity then by uncovered line count descending. Apply `exclude` globs.
Cap at `maxGaps` after sorting.

## Step 5 — Write gap report

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode report \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

**`.tdd/coverage-gaps.json`** — consumed by tdd-agent:

```json
{
  "generatedAt": "2026-05-22T14:32:00Z",
  "suiteStatus": "passed",
  "totals": { "lines": 74, "functions": 68, "branches": 58 },
  "thresholds": { "file": 80, "function": 80, "branch": 70, "line": 80 },
  "gaps": [ ... ],
  "summary": { "total": 34, "critical": 8, "high": 12, "medium": 10, "low": 4 }
}
```

**`.tdd/coverage-gaps-report.md`** — human-readable:

```markdown
# Coverage Gap Report — 2026-05-22 14:32

## Overall Coverage
| Metric    | Current | Threshold | Status   |
|-----------|---------|-----------|----------|
| Lines     | 74%     | 80%       | ⚠ BELOW  |
| Functions | 68%     | 80%       | ⚠ BELOW  |
| Branches  | 58%     | 70%       | ⚠ BELOW  |

## Gaps (34 total — 8 critical, 12 high, 10 medium, 4 low)

### 🔴 Critical — gap-001
**File:** src/services/auth.ts
**Function:** `resetPassword`
**Coverage:** 0%  (lines 88–93 untouched)
**Suggested test:** "resetPassword — should throw when token is expired"
**Test file:** src/services/auth.test.ts *(needs creating)*
```

## Convenience: run the full pipeline

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode run-all \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

Runs Steps 1–5 in sequence.

## How tdd-agent consumes this output

tdd-agent reads `.tdd/coverage-gaps.json` and processes gaps **one at a time**,
ordered by severity:

```
for each gap in coverage-gaps.json:
  1. Read gap.file and gap.suggestedTestDescription
  2. Open the source file — examine the uncovered function/branch
  3. Write one focused test in gap.testFilePath
  4. Run only that test file to verify it passes
  5. If it passes → resolve gap, move to the next one
  6. If it fails → enter the TDD fix loop (up to maxIterations) for this gap
  7. Move to the next gap regardless of outcome; report unresolved gaps
```

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Output structure

```
.tdd/
  coverage-gaps.json           ← structured gap list (tdd-agent input)
  coverage-gaps-report.md      ← human-readable summary

coverage/                      ← written by the test runner, read by this skill
  coverage-summary.json
  lcov.info
```

## Edge cases

- **No coverage output after test run**: coverage provider likely not installed;
  print the exact install command (`npm install -D @vitest/coverage-v8`) and exit
- **All tests fail**: partial coverage data may exist; produce whatever gaps are
  available and prominently flag the suite failure at the top of both reports
- **File in `targetCode` not imported by any test**: mark as 0% / `hasTestFile: false` — highest priority gaps
- **Generated or vendored files**: always apply `exclude` to `*.d.ts`,
  `node_modules/**`, `dist/**`, `build/**` regardless of config
- **Monorepo**: scope to the package whose `targetCode` is configured; never
  aggregate coverage across multiple packages
- **`maxGaps` hit**: add a note: "Showing top N gaps. Re-run after resolving
  these to surface the next batch."
- **Large codebase (>500 source files)**: full JSON always written; markdown
  report capped at top 50 gaps with note

## Success criteria

- Coverage runs without modifying any source files
- Every source file in `targetCode` appears in the gap report (covered or gap),
  including files with zero tests
- Each gap has a `suggestedTestDescription` specific enough for tdd-agent to
  write a meaningful test without additional context
- `.tdd/coverage-gaps.json` is valid JSON with correct severity classifications
- Function with 0% coverage is always `critical`
- Report reflects only the current codebase state — no stale data from prior runs
