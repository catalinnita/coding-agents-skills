---
name: component-refactor
type: agent
description: >
  Orchestrates a safe component extraction and test/UI validation pipeline:
  runs extract-components to find and extract repetitive JSX into reusable
  components, invokes tdd-agent to update tests and validate the refactored
  code, then uses visual-regression to confirm no UI regressions were
  introduced. Use when asked to extract components safely, refactor React code
  into components with test coverage, or refactor JSX and validate the result
  end-to-end.
compatibility: >
  Requires Node.js 18+, Python 3.10+, and Playwright. The project must be a
  git repository with a build/serve command. Skills extract-components and
  visual-regression, and agent tdd-agent must be present in .agents/.
skills:
  - extract-components
  - visual-regression
agents:
  - tdd-agent
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Safely refactor a React codebase by extracting repetitive JSX patterns into
reusable components, then validating both tests and UI in sequence. Orchestrates
three specialist tools: `extract-components` for the structural refactor,
`tdd-agent` for test coverage of the new components, and `visual-regression`
to guarantee nothing looks different in the browser.

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to scan. Default: `src/` |
| `minOccurrences` | No | Minimum repetitions for extraction. Default: `3` |
| `minDepth` | No | Minimum JSX subtree depth to consider. Default: `2` |
| `outputDir` | No | Where to write new component files. Default: `src/components/` |
| `testFramework` | No | `jest` or `vitest`. Default: auto-detected |
| `routes` | No | URL paths for visual regression. Default: auto-discovered |
| `viewports` | No | Array of `{width, height, label}`. Default: mobile + desktop |
| `threshold` | No | Max acceptable visual diff ratio 0–1. Default: `0.01` |
| `maxFixIterations` | No | Max auto-fix cycles per failing visual check. Default: `3` |
| `dryRun` | No | Preview extraction without writing files. Default: `false` |
| `skipTests` | No | Skip the tdd-agent phase. Default: `false` |
| `skipVisual` | No | Skip the visual-regression phase. Default: `false` |

## Phase 0 — Pre-flight

Before doing anything:

- Confirm the working directory is a git repository
- Check for uncommitted changes: warn the user and ask for confirmation (visual
  regression uses git worktrees; uncommitted changes will be stashed)
- Confirm all required skills and agents are present in `.agents/`
- Detect the test framework from `jest.config.*`, `vitest.config.*`, or
  `scripts.test` in `package.json`; ask the user if neither is found
- Confirm the app's build/serve command is resolvable (required for screenshots)
- If `dryRun: true`: run Phase 1 in dry-run mode, print the extraction preview,
  and stop — no file writes, no tests, no screenshots
- Ensure `.component-refactor/` is listed in the project's `.gitignore`; append
  it if missing — never prompt the user about this

## Phase 1 — Baseline visual snapshot

Capture screenshots **before** any code changes so regressions can be detected
precisely.

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode capture \
  --config visual-regression.config.json \
  --output-dir .component-refactor/baseline-before \
  --project-dir <path-to-project>
```

Store screenshots in `.component-refactor/baseline-before/<viewport>/<route-slug>.png`.
These are never overwritten after this point.

Skip this phase if `skipVisual: true`.

## Phase 2 — Extract components

Run the extraction in interactive mode so the user approves each proposal before
files are written.

```bash
node .agents/skills/extract-components/scripts/extractor.js \
  --mode run \
  --target <target> \
  --min-occurrences <minOccurrences> \
  --min-depth <minDepth> \
  --output-dir <outputDir> \
  --interactive true
```

Record for the final report:
- Patterns found and their scores
- Patterns selected by the user
- Component names, prop signatures, and output file paths
- Call sites rewritten per component
- Lines removed from source files

**If extraction produces zero patterns**: report this and stop.

**If TypeScript errors are introduced** (from `tsc --noEmit` run by the skill):
print the errors, offer to revert the affected files, and stop the agent — never
leave the codebase in a type-broken state.

## Phase 3 — Update and validate tests

Invoke `tdd-agent` to cover the newly created components and validate that
existing tests still pass after the call-site rewrites.

For each extracted component, derive acceptance criteria from the extraction
plan:
- Component name, prop names, and prop types
- Number of occurrences replaced and which files they were in
- Any children slots detected

```
acceptanceCriteria = """
  Component: <ComponentName>
  Props: <prop list from extraction plan>
  Renders the same JSX subtree as the original occurrences for any valid prop combination.
  Replacing all <N> call sites must leave the application functionally identical.
"""
targetCode = "<outputDir>/<ComponentName>.tsx + all rewritten source files"
```

Run tdd-agent with the derived inputs:

```
tdd-agent(
  acceptanceCriteria = <derived from extraction plan>,
  targetCode         = <new component + rewritten files>,
  testFramework      = <testFramework>,
  outputDir          = ".component-refactor/tdd"
)
```

**Rules:**
- Never delete existing passing tests
- If tdd-agent reports failing tests that cannot be auto-fixed within
  `maxIterations`, mark them as "needs developer attention" and continue
  to Phase 4 — do not abort the agent

Skip this phase if `skipTests: true`.

## Phase 4 — Visual regression

Compare current screenshots against the Phase 1 baseline to detect any
unintended visual change caused by the extraction.

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode run \
  --config visual-regression.config.json \
  --baseline-dir .component-refactor/baseline-before \
  --project-dir <path-to-project>
```

- **All pass** → proceed to Phase 5.
- **Any fail** → enter the auto-fix loop below.
- **Any warn** → note in report; do not auto-fix `warn` — only `fail` triggers
  the loop.

### Auto-fix loop (per failing route, up to `maxFixIterations`)

Component-extraction regressions are almost always caused by a prop not being
forwarded correctly or a hardcoded className being dropped. For each failing
`(route, viewport)` pair:

1. Open the diff image and identify the changed region
2. Inspect computed styles at the diff bounding box via Playwright
3. Compare against the original subtree from `git diff`
4. Classify and apply the minimum fix:

| Category | What happened | Fix |
|---|---|---|
| `prop-missing` | A varying value was hardcoded instead of forwarded as a prop | Add the missing prop and forward it in the component |
| `className-dropped` | A fixed className was accidentally omitted in the component template | Re-add the missing className to the component |
| `children-slot` | A children slot was not rendered in the correct position | Ensure `{children}` is in the right place |
| `import-missing` | An import needed by the rewritten call site is absent | Add the import to the affected file |

After each fix, re-validate the specific route:

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode capture-single \
  --route <route> \
  --viewport <viewport> \
  --baseline-dir .component-refactor/baseline-before \
  --project-dir <path-to-project>
```

- **Passes** → mark resolved, move to next failing route.
- **Still fails** → run another fix cycle (up to `maxFixIterations`).
- **`maxFixIterations` exhausted** → revert the last broken fix attempt, mark
  route `unresolved`, move on.

After all fix cycles, run one final full regression pass:

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode run \
  --config visual-regression.config.json \
  --baseline-dir .component-refactor/baseline-before \
  --project-dir <path-to-project>
```

Skip this phase if `skipVisual: true`.

## Phase 5 — Final report

Write `.component-refactor/report.md`:

```markdown
# Component Refactor Report — <date>

## Extraction Summary
Components extracted: 3

  FormField (src/components/FormField.tsx)
    5 occurrences replaced  →  TransactionModal.tsx
    Props: label: string, children: ReactNode
    Lines removed: 48  (net −38 after import)

  StatRow (src/components/StatRow.tsx)
    3 occurrences replaced  →  Dashboard.tsx (2), Summary.tsx (1)
    Props: label: string, value: string | number
    Lines removed: 21  (net −16 after import)

TypeScript: ✓ no errors

## Test Results
Scenarios generated:  8
Tests passing:        8
Tests failing:        0
Needs developer attention:  0

## Visual Regression   (24 comparisons)
Pass:  24   Warn:  0   Fail:  0

## Auto-fixes Applied
None.

## Unresolved
None.
```

Also write `.component-refactor/report.html` — a self-contained HTML file
embedding the extraction summary, test report, and visual diff report in one
place.

## Skills and agents used

| Tool | Phase | Purpose |
|---|---|---|
| `visual-regression` | 1 | Baseline capture before any changes |
| `extract-components` | 2 | Find patterns, propose components, rewrite call sites |
| `tdd-agent` | 3 | Generate tests for new components, validate call-site rewrites |
| `visual-regression` | 4 | Detect UI regressions; auto-fix loop for failures |

## Decision rules

- Never write any files if `dryRun: true`
- Never modify the Phase 1 baseline screenshots
- Never delete existing passing tests
- Never leave the codebase with TypeScript errors
- Minimum viable visual fix — smallest change that resolves the regression
- After `maxFixIterations` exhausted: revert the last broken attempt and mark
  `unresolved` — never leave broken code without explanation
- `warn` routes are documented but not auto-fixed — only `fail` triggers the
  loop
- If any phase fails catastrophically (build broken, all routes failing):
  revert all extraction changes via `git checkout` and report what went wrong

## Output structure

```
.component-refactor/
  baseline-before/         ← Phase 1 snapshots (immutable)
    mobile/   desktop/
      index.png
      <route-slug>.png
  tdd/                     ← tdd-agent output
    scenarios.md
    report.md
  report.md                ← combined agent summary
  report.html              ← self-contained HTML report

.visual-regression/        ← written by visual-regression skill (Phase 4)
  report.html
  report.json
  diff/
```

## Edge cases

- **No patterns found**: report zero patterns and stop after Phase 2 plan step
- **User rejects all patterns in interactive mode**: stop cleanly; no files
  written; no tests or screenshots needed
- **TypeScript errors after extraction**: offer to revert the affected files;
  never proceed to Phase 3 with a broken build
- **Build fails after extraction**: treat all routes as `fail`; diagnose whether
  the extraction introduced a syntax error; revert if confirmed
- **Uncommitted changes**: stash before Phase 1, restore after Phase 4; if
  restore fails, list stash contents and warn — never silently lose work
- **Flaky screenshots** (σ > 20% on any metric): mark `unstable`, skip
  auto-fix, document in report
- **Monorepo**: confirm which app to test before proceeding; never cross package
  boundaries in extraction or visual regression
- **`skipTests: true`**: jump from Phase 2 directly to Phase 4
- **`skipVisual: true`**: run Phases 0–3 only (no screenshots taken or compared)
- **Both `skipTests` and `skipVisual`**: run Phase 2 only (pure extraction run)

## Success criteria

- Every extracted component compiles with no TypeScript errors
- All original source files pass `tsc --noEmit` after rewriting
- All generated tests follow the project's test conventions
- All routes pass final visual regression (or unresolved ones are documented)
- No existing passing tests are broken
- The combined report covers extraction, tests, and visual validation in one
  place
- The codebase is in a clean, committable state when the agent exits
