# Skill Spec: Coverage Gaps

## Goal

Run the project's test suite with coverage enabled, parse the results, identify
every file, function, and branch that is untested or below configured thresholds,
and produce a prioritised, structured gap report that the **tdd-agent** can read
to create tests one by one — starting from the highest-priority gaps.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "find coverage gaps"
- "what code is untested"
- "show me missing tests"
- "generate a coverage report"
- "identify test gaps"
- "which functions have no tests"
- "run coverage analysis"

Also invoked by the **tdd-agent** as an optional pre-step when no
`acceptanceCriteria` or `scenariosFile` is provided — it uses the gap report
as the source of what to test next.

---

## Inputs

Read from `coverage-gaps.config.json` at the project root, or from the
`coverageGaps` section of a shared project config.

| Config key | Default | Description |
|---|---|---|
| `targetCode` | `"src"` | Directory or glob of source files to measure |
| `testCommand` | auto-detected | Command to run tests with coverage (e.g. `vitest run --coverage`) |
| `coverageDir` | `"coverage"` | Directory where the test runner writes its coverage output |
| `outputDir` | `".tdd"` | Where to write the gap report files |
| `thresholds.file` | `80` | Min file-level line coverage % before flagging as a gap |
| `thresholds.function` | `80` | Min function coverage % before flagging |
| `thresholds.branch` | `70` | Min branch coverage % before flagging |
| `thresholds.line` | `80` | Min line coverage % before flagging |
| `priority` | `"severity"` | How to sort gaps: `"severity"` \| `"file"` \| `"uncovered-first"` |
| `exclude` | `[]` | File globs to skip (e.g. `["**/*.d.ts", "**/index.ts"]`) |
| `includeUntested` | `true` | Include source files with no test file at all |
| `maxGaps` | `null` | Cap the report at N gaps (null = no cap) |

---

## Behavior

### Step 1 — Pre-flight

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode preflight \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

- Detect test framework and coverage tool:

| Signal | Test command | Coverage format |
|---|---|---|
| `vitest.config.*` with `coverage` | `vitest run --coverage` | `json`, `lcov` |
| `jest.config.*` | `jest --coverage` | `json`, `lcov` |
| `scripts.test` in `package.json` | value + `--coverage` if jest/vitest | `json` |

- Confirm `@vitest/coverage-v8` or `@vitest/coverage-istanbul` is installed (for Vitest); `jest --coverage` needs no extra package
- Confirm `targetCode` resolves to at least one `.ts` / `.js` / `.tsx` file
- Create `outputDir` if it doesn't exist

### Step 2 — Run coverage

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode run \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

Execute the detected test command with coverage flags, capturing stdout/stderr.
If the suite fails (non-zero exit), continue to Step 3 anyway — partial coverage
data is still useful. Flag the suite failure in the report.

### Step 3 — Parse coverage data

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode parse \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

Read `<coverageDir>/coverage-summary.json` (jest/vitest JSON summary format):

```json
{
  "total": { "lines": {"pct": 74}, "functions": {"pct": 68}, ... },
  "src/services/auth.ts": {
    "lines":     {"total": 42, "covered": 28, "pct": 66.67},
    "functions": {"total": 8,  "covered": 4,  "pct": 50},
    "branches":  {"total": 12, "covered": 5,  "pct": 41.67},
    "statements":{"total": 45, "covered": 30, "pct": 66.67}
  },
  ...
}
```

For each source file in `targetCode`:
- If it appears in the coverage summary → extract line/function/branch percentages
- If it does **not** appear in the summary and `includeUntested: true` → mark as
  `coverage: 0%` across all metrics (file has no tests at all)

Also parse `<coverageDir>/lcov.info` if available to extract per-function names
(the JSON summary gives percentages but not which specific functions are uncovered).

### Step 4 — Identify gaps

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode identify \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

For each file, produce gap records for every threshold breach:

**Gap record shape:**
```json
{
  "id": "gap-001",
  "file": "src/services/auth.ts",
  "type": "function",
  "name": "resetPassword",
  "currentCoverage": 0,
  "threshold": 80,
  "severity": "critical",
  "uncoveredLines": [88, 89, 90, 91, 92, 93],
  "uncoveredBranches": ["line 91: if (token.expired)"],
  "suggestedTestDescription": "resetPassword — should throw when token is expired",
  "hasTestFile": false,
  "testFilePath": "src/services/auth.test.ts"
}
```

**Severity classification:**

| Condition | Severity |
|---|---|
| File has no test file at all | `critical` |
| Function coverage = 0% | `critical` |
| Branch coverage = 0% on a conditional | `high` |
| Line coverage < 50% | `high` |
| Line coverage 50–threshold | `medium` |
| Branch coverage 0–threshold | `medium` |
| Above threshold but below 100% | `low` |

**Priority sorting** (when `priority: "severity"`):
1. `critical` gaps first
2. `high` gaps
3. Files with test file but zero coverage for specific functions
4. `medium` gaps
5. `low` gaps

Within the same severity, sort by number of uncovered lines descending (most
uncovered code first).

**`suggestedTestDescription` generation rules:**
- Function with 0% coverage: `"<functionName> — should <verb based on function name>"`
- Branch not taken (e.g. error path): `"<functionName> — should handle <branch condition>"`
- Whole file uncovered: `"<filename> — basic smoke test for all exported functions"`

Apply `exclude` globs and cap at `maxGaps` after sorting.

### Step 5 — Write gap report

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode report \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

**`.tdd/coverage-gaps.json`** — structured, consumed by tdd-agent:

```json
{
  "generatedAt": "2026-05-22T14:32:00Z",
  "suiteStatus": "passed",
  "totals": {
    "lines": 74, "functions": 68, "branches": 58, "statements": 72
  },
  "thresholds": { "file": 80, "function": 80, "branch": 70, "line": 80 },
  "gaps": [
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
    },
    ...
  ],
  "summary": {
    "total": 34,
    "critical": 8,
    "high": 12,
    "medium": 10,
    "low": 4
  }
}
```

**`.tdd/coverage-gaps-report.md`** — human-readable:

```markdown
# Coverage Gap Report — 2026-05-22 14:32

## Overall Coverage
| Metric | Current | Threshold | Status |
|---|---|---|---|
| Lines | 74% | 80% | ⚠ BELOW |
| Functions | 68% | 80% | ⚠ BELOW |
| Branches | 58% | 70% | ⚠ BELOW |

## Gaps (34 total — 8 critical, 12 high, 10 medium, 4 low)

### 🔴 Critical — gap-001
**File:** src/services/auth.ts
**Function:** `resetPassword`
**Coverage:** 0% (lines 88–93 untouched)
**Suggested test:** "resetPassword — should throw when token is expired"
**Test file:** src/services/auth.test.ts (needs creating)

---

### 🔴 Critical — gap-002
...
```

## Convenience: run the full pipeline

```bash
python3 .agents/skills/coverage-gaps/scripts/runner.py \
  --mode run-all \
  --config coverage-gaps.config.json \
  --project-dir <path-to-project>
```

Runs Steps 1–5 in sequence.

---

## How tdd-agent consumes the gap report

When tdd-agent receives `.tdd/coverage-gaps.json` as its input (instead of or
in addition to acceptance criteria), it processes gaps **one at a time**:

```
for gap in coverage-gaps.json sorted by severity:
  1. Read gap.suggestedTestDescription and gap.uncoveredLines
  2. Open gap.file — read the function/branch that is uncovered
  3. Write one test case in gap.testFilePath using test-conventions
  4. Run only that test file: --testPathPattern <testFilePath>
  5. If test passes → mark gap as resolved, move to next gap
  6. If test fails → enter the TDD fix loop (max maxIterations) for this gap
  7. After resolving or exhausting iterations → move to next gap
```

This one-at-a-time approach ensures each gap is resolved before moving on, and
produces a stable, incremental commit history.

---

## Output structure

```
.tdd/
  coverage-gaps.json           ← structured gap list (consumed by tdd-agent)
  coverage-gaps-report.md      ← human-readable summary

coverage/                      ← written by the test runner (not this skill)
  coverage-summary.json
  lcov.info
```

---

## Edge cases

- **No coverage output found**: if `<coverageDir>/coverage-summary.json` does not
  exist after the test run, check if the coverage provider is installed; print
  setup instructions and exit
- **All tests fail**: the coverage data may be partial or absent; report the suite
  failure prominently but still produce whatever gap data is available
- **File in `targetCode` but not imported by any test**: mark as 0% coverage
  and `hasTestFile: false` — these are the highest priority gaps
- **Generated or vendored files**: apply `exclude` globs aggressively; never flag
  `*.d.ts`, `node_modules/**`, or `dist/**` as gaps
- **Monorepo**: if multiple `package.json` files exist, run coverage for the
  specific package configured by `targetCode`; do not aggregate across packages
- **Very large codebase** (>500 source files): generate the full JSON but cap
  the markdown report at the top 50 gaps; note the cap in the summary
- **`maxGaps` hit**: add a note to the report: "Showing top N gaps. Re-run after
  resolving these to surface the next batch."

---

## Success criteria

- Coverage runs without modifying any source files
- Every source file in `targetCode` appears in the gap report (either as covered
  or as a gap), including files with no test file
- Each gap has a `suggestedTestDescription` that is specific enough for tdd-agent
  to write a meaningful test without additional context
- `.tdd/coverage-gaps.json` is valid JSON parseable by tdd-agent
- Severity classification is consistent: function with 0% is always `critical`
- The report only reflects the current state of the codebase — no stale data
  from a previous coverage run
