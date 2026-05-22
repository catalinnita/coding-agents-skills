---
name: code-cleanup
type: agent
description: >
  Runs a sequential, test-gated cleanup pipeline across the codebase: CSS
  variable extraction with visual validation (css-refactor agent), TypeScript
  type cleanup (type-cleaner), configuration extraction (config-extractor),
  accessibility fixes (accessibility), SEO fixes (seo), and security hardening
  (security). After every step it runs the full test suite; if tests break it
  attempts to fix them, and if it cannot it reverts that step's changes and
  moves on. After each step it logs what changed using changes-report. Delivers
  one consolidated report of everything that was cleaned up, every test outcome,
  and anything that was skipped or needs manual attention. Use when asked to
  clean up the codebase, run a full code cleanup, or apply all automated
  improvements.
compatibility: >
  Requires Node.js and the project's test runner (Jest or Vitest). Agent
  css-refactor and skills type-cleaner, config-extractor, accessibility, seo,
  security, and changes-report must be present in .agents/.
skills:
  - type-cleaner
  - config-extractor
  - accessibility
  - seo
  - security
  - changes-report
agents:
  - css-refactor
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

A sequential, test-gated codebase cleanup pipeline. Each step applies one
focused set of automated improvements, immediately verifies the test suite
still passes, documents what changed, then moves to the next step. If a step
breaks tests and cannot self-correct, it is cleanly reverted so the pipeline
continues rather than stalling.

## Config

Read from `code-cleanup.config.json` at the project root, or from a
`codeCleanup` section in an existing shared config:

| Key | Default | Description |
|---|---|---|
| `steps` | `["css-refactor","type-cleaner","config-extractor","accessibility","seo","security"]` | Which steps to run and in what order |
| `devLevel` | `"junior"` | Explanation depth for changes-report after each step |
| `outputDir` | `".cleanup"` | Where to write step logs and the final report |
| `dryRun` | `false` | Audit every step without writing any files; skip test runs |
| `confirm` | `false` | Ask for confirmation before applying each step |
| `maxTestFixAttempts` | `2` | How many times to attempt fixing broken tests before reverting |
| `testCommand` | auto-detected | Override the test command (e.g. `vitest run` or `jest --ci`) |

Each step also reads its own skill/agent config file when present
(`css-extract-variables.config.json`, `.security.config.json`, etc.).

---

## Phase 0 — Pre-flight

Before running any step:

- Confirm the working directory is a git repository (required for safe reverts)
- Confirm there are no uncommitted changes; if there are, warn and ask for
  confirmation — the pipeline uses `git stash` / `git checkout` to revert
  failed steps, which requires a clean working tree baseline
- Detect the test framework and confirm the test suite can be run:
  - Try `jest.config.*`, `vitest.config.*`, `scripts.test` in `package.json`
  - Run a dry test invocation to verify it exits cleanly before starting
  - If no test suite exists: warn and proceed anyway; skip all test checks
- Confirm all required skills and agents are present in `.agents/`
- Resolve config, apply defaults, surface the final step list to the user
- Create `outputDir`
- Ensure `outputDir` is listed in the project's `.gitignore`; append it if missing — never prompt the user about this

---

## Per-step pattern

Every step in the pipeline follows the same five-stage pattern:

```
1. Run the step (skill or agent with fix: true)
2. Check tests
3. If tests fail → attempt to fix; if still failing → revert step
4. Log changes with changes-report
5. Commit the step (optional, if confirm: false and tests pass)
```

The test check is non-negotiable: a step's changes are only kept if the full
test suite passes (or if no test suite exists).

---

## Step 1 — CSS Refactor

Invoke the **`css-refactor`** agent. This agent handles its own visual
regression internally — it extracts CSS variables, validates visually, and
auto-corrects any regressions before returning.

```bash
# css-refactor agent runs:
#   1. css-extract-variables skill
#   2. visual-regression (built-in, self-correcting)
#   3. changes-report (internal)
# It returns only when visual regression passes clean.
```

Log:
```
[step 1/6] css-refactor agent — running...
           Variables extracted: 42  Files modified: 23
           Visual regression: 24/24 pass
           ✓ css-refactor complete
```

**Test check:**

```bash
<testCommand>
```

- **Pass** → record result, continue to Step 2
- **Fail** → enter test-fix loop (see Test Fix Loop below)
- **Revert if unfixable:**
  ```bash
  git checkout -- .
  git clean -fd
  ```
  Log the revert and skip to Step 2 without the changes.

**Changes report:**

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode run \
  --skills css-extract-variables \
  --output-file .cleanup/step-1-css-refactor.md \
  --project-dir <path-to-project>
```

---

## Step 2 — Type Cleaner

```bash
python3 .agents/skills/type-cleaner/scripts/runner.py \
  --mode run \
  --fix true \
  --project-dir <path-to-project>
```

Applies TypeScript type improvements: merges duplicate declarations, removes
redundant types, extracts repeated inline shapes, normalises `interface` vs
`type`, removes unused imports and types, and flags `any` usage.

Log:
```
[step 2/6] type-cleaner — running...
           Fixes applied: 34  Files modified: 12
           ✓ type-cleaner complete
```

**Test check** → same pattern as Step 1.

**Changes report:**

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode run \
  --skills type-cleaner \
  --output-file .cleanup/step-2-type-cleaner.md \
  --project-dir <path-to-project>
```

---

## Step 3 — Config Extractor

```bash
python3 .agents/skills/config-extractor/scripts/runner.py \
  --mode run \
  --fix true \
  --project-dir <path-to-project>
```

Extracts hardcoded environment-specific values (URLs, keys, feature flags,
magic numbers) into a centralised config file or environment variable
references.

Log:
```
[step 3/6] config-extractor — running...
           Values extracted: 18  Files modified: 7
           ✓ config-extractor complete
```

**Test check** → same pattern.

**Changes report:**

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode run \
  --skills config-extractor \
  --output-file .cleanup/step-3-config-extractor.md \
  --project-dir <path-to-project>
```

---

## Step 4 — Accessibility

```bash
python3 .agents/skills/accessibility/scripts/runner.py \
  --mode run \
  --fix true \
  --project-dir <path-to-project>
```

Fixes WCAG 2.1 Level AA violations: adds missing `alt` attributes, `lang` on
`<html>`, `font-display: swap`, resets invalid `tabindex`, adds missing form
labels, restores `:focus-visible` styles.

Log:
```
[step 4/6] accessibility — running...
           Violations found: 28  Auto-fixed: 19  Manual review: 9
           Files modified: 8
           ✓ accessibility complete
```

**Test check** → same pattern.

**Changes report:**

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode run \
  --skills accessibility \
  --output-file .cleanup/step-4-accessibility.md \
  --project-dir <path-to-project>
```

---

## Step 5 — SEO

```bash
python3 .agents/skills/seo/scripts/runner.py \
  --mode run \
  --fix true \
  --project-dir <path-to-project>
```

Fixes SEO issues: inserts missing `<meta charset>`, `<meta name="viewport">`,
makes `og:image` URLs absolute, adds `rel="noopener noreferrer"`, adds
`loading="lazy"`, adds `defer` to blocking scripts.

Log:
```
[step 5/6] seo — running...
           Issues found: 21  Auto-fixed: 14  Manual review: 7
           Files modified: 6
           ✓ seo complete
```

**Test check** → same pattern.

**Changes report:**

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode run \
  --skills seo \
  --output-file .cleanup/step-5-seo.md \
  --project-dir <path-to-project>
```

---

## Step 6 — Security

```bash
python3 .agents/skills/security/scripts/runner.py \
  --mode run \
  --fix true \
  --project-dir <path-to-project>
```

Applies security hardening: adds missing cookie flags (`HttpOnly`, `Secure`,
`SameSite`), replaces `Math.random()` with `crypto.randomBytes`, adds SRI to
CDN scripts, wires in security headers middleware, bumps patch-level CVEs.

Log:
```
[step 6/6] security — running...
           Issues found: 15  Auto-fixed: 8  Manual review: 7
           Files modified: 5
           ✓ security complete
```

**Test check** → same pattern.

**Changes report:**

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode run \
  --skills security \
  --output-file .cleanup/step-6-security.md \
  --project-dir <path-to-project>
```

---

## Test Fix Loop

Used after every step when the test suite fails.

```
attempt = 1
while attempt <= maxTestFixAttempts:

  1. Parse the test output to identify which test files are failing
  2. For each failing test:
     a. Read the test file and the source file it exercises
     b. Determine whether the failure is caused by the step's changes:
        - Import path changed (config-extractor moved a value)
        - Type signature changed (type-cleaner altered an interface)
        - Attribute added/removed (accessibility or seo changed HTML)
        - API changed (security replaced Math.random or cookie APIs)
     c. Apply the minimal fix to the TEST file (not the source) to align
        with the new reality introduced by the step
        - Update import paths
        - Update type assertions
        - Update expected attribute values in render assertions
        - Update mock return values for replaced APIs
  3. Re-run the test suite
  4. If all pass → exit the loop (fixed)
  5. If still failing → increment attempt

  attempt += 1
```

**If `maxTestFixAttempts` exhausted and tests still fail:**
```bash
git checkout -- .
git clean -fd
```
Log:
```
[step N] Tests still failing after <maxTestFixAttempts> fix attempts.
         Reverting step N changes.
         Skipping to step N+1.
```

The revert is a hard reset to the state before the step began. The step is
recorded as `reverted` in the final report.

**Critically: only fix the test files, never the source changes.** If fixing
a test requires undoing what the step did to source, that is a revert, not a
fix.

---

## Phase 7 — Consolidated report

Write `<outputDir>/report.md`:

```markdown
# Code Cleanup Report — 2026-05-22 14:32

## Summary

| Step | Skill / Agent | Fixes | Tests | Changes log |
|------|---------------|-------|-------|-------------|
| 1 | css-refactor | 42 vars, 23 files | ✓ pass | step-1-css-refactor.md |
| 2 | type-cleaner | 34 fixes, 12 files | ✓ pass | step-2-type-cleaner.md |
| 3 | config-extractor | 18 extractions, 7 files | ✓ pass (1 test fix) | step-3-config-extractor.md |
| 4 | accessibility | 19/28 fixed, 8 files | ✓ pass | step-4-accessibility.md |
| 5 | seo | 14/21 fixed, 6 files | ✓ pass | step-5-seo.md |
| 6 | security | 8/15 fixed, 5 files | ✓ pass | step-6-security.md |

**Total files modified: 46**
**Total fixes applied: 135**
**Steps reverted: 0**

---

## What still needs manual attention

### type-cleaner (step 2)
- 3 `any` types flagged — require developer judgment to type correctly
- 1 circular type dependency — needs architectural review

### accessibility (step 4)
- 9 violations need human input (colour contrast decisions, missing captions)

### seo (step 5)
- 7 issues need copywriting (titles, descriptions, structured data)

### security (step 6)
- 7 high-severity issues need developer attention:
  - SQL injection pattern in src/api/search.ts:42
  - CORS `origin: '*'` in src/middleware/cors.ts:18
  - Committed secret in git history (provide git filter-repo command)

---

## Detailed change logs

See individual step files in .cleanup/ for level-appropriate explanations:
- step-1-css-refactor.md
- step-2-type-cleaner.md
- step-3-config-extractor.md
- step-4-accessibility.md
- step-5-seo.md
- step-6-security.md
```

Also write `<outputDir>/report.json`:

```json
{
  "startedAt": "2026-05-22T14:32:00Z",
  "completedAt": "2026-05-22T15:18:00Z",
  "steps": [
    {
      "order": 1, "name": "css-refactor", "type": "agent",
      "status": "applied", "fixesApplied": 42, "filesModified": 23,
      "testResult": "pass", "testFixesApplied": 0,
      "log": "step-1-css-refactor.md"
    },
    {
      "order": 2, "name": "type-cleaner", "type": "skill",
      "status": "applied", "fixesApplied": 34, "filesModified": 12,
      "testResult": "pass", "testFixesApplied": 0,
      "log": "step-2-type-cleaner.md"
    },
    {
      "order": 3, "name": "config-extractor", "type": "skill",
      "status": "applied", "fixesApplied": 18, "filesModified": 7,
      "testResult": "pass", "testFixesApplied": 1,
      "log": "step-3-config-extractor.md"
    },
    {
      "order": 4, "name": "accessibility", "type": "skill",
      "status": "applied", "fixesApplied": 19, "filesModified": 8,
      "testResult": "pass", "testFixesApplied": 0,
      "log": "step-4-accessibility.md"
    },
    {
      "order": 5, "name": "seo", "type": "skill",
      "status": "applied", "fixesApplied": 14, "filesModified": 6,
      "testResult": "pass", "testFixesApplied": 0,
      "log": "step-5-seo.md"
    },
    {
      "order": 6, "name": "security", "type": "skill",
      "status": "applied", "fixesApplied": 8, "filesModified": 5,
      "testResult": "pass", "testFixesApplied": 0,
      "log": "step-6-security.md"
    }
  ],
  "totalFilesModified": 46,
  "totalFixesApplied": 135,
  "stepsReverted": 0
}
```

## Skills and agents used

| Step | Name | Type | Purpose |
|------|------|------|---------|
| 1 | `css-refactor` | Agent | Extract CSS variables + visual regression |
| 2 | `type-cleaner` | Skill | Deduplicate and normalise TypeScript types |
| 3 | `config-extractor` | Skill | Extract hardcoded values into config |
| 4 | `accessibility` | Skill | Fix WCAG 2.1 violations |
| 5 | `seo` | Skill | Fix SEO issues |
| 6 | `security` | Skill | Apply security hardening |
| All | `changes-report` | Skill | Document every change at `devLevel` depth |

## Decision rules

- **Steps run sequentially, never in parallel** — each step's changes are the
  starting point for the next
- **Never skip the test check** — a step's changes are only kept if the suite
  passes (or no suite exists)
- **Fix tests, not source** — the test fix loop adjusts test expectations to
  match the new source reality; it never undoes what the step changed
- **Revert cleanly** — if a step cannot be made to pass tests, `git checkout`
  restores the exact state before that step; later steps still run on the
  clean state
- **`changes-report` runs even for reverted steps** — log `[reverted]` in
  the step file so the audit trail is complete
- **`confirm: true` pauses before each step** — shows the diff preview from
  `--dry-run` and waits for explicit approval before applying

## Output structure

```
code-cleanup.config.json         ← config (project root)

.cleanup/
  report.md                      ← consolidated summary (open this)
  report.json                    ← machine-readable results
  step-1-css-refactor.md         ← changes-report output per step
  step-2-type-cleaner.md
  step-3-config-extractor.md
  step-4-accessibility.md
  step-5-seo.md
  step-6-security.md
```

## Edge cases

- **No test suite**: warn at Phase 0; run all steps without test checks;
  note in the report that test gating was skipped
- **Uncommitted changes at start**: warn prominently; the pipeline needs a
  clean git state to revert safely; offer to stash and restore, or abort
- **`dryRun: true`**: run every step in audit-only mode; print what would
  change; skip all test runs and writes; produce `report.md` with estimated
  changes only
- **`confirm: true`**: before each step, show the dry-run output and a file
  count; wait for explicit `y`/`n`; `n` skips that step entirely (not reverted,
  just not run)
- **A step produces zero changes**: log `[step N] No changes — skipped test
  run`; move to the next step
- **css-refactor agent fails** (e.g. visual baseline cannot be captured): skip
  step 1, log the error, continue from step 2 on the unchanged codebase
- **Test suite itself is broken before the pipeline starts**: abort in Phase 0;
  the pipeline requires a green baseline to detect regressions it causes
- **Monorepo**: scope each skill to the same `target` directory; never cross
  package boundaries unless explicitly configured
- **Step order customised via `steps` config**: honour the configured order;
  validate that all named steps are known skills or agents before starting

## Success criteria

- Every step either ends with a passing test suite or is reverted to a clean state
- No source change from any step is left in place if it caused a test failure
  that could not be auto-corrected
- Every change applied has a corresponding entry in the step's `changes.md`
- The consolidated report accurately reflects: fixes applied, test outcomes,
  test fixes made, steps reverted, and manual-attention items
- The codebase is in a clean, committable state after the pipeline completes
