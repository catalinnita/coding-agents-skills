---
name: css-refactor
type: agent
description: >
  Extracts all hardcoded CSS values into custom properties, immediately
  validates the result with a visual regression test, and — if regressions are
  detected — automatically diagnoses and fixes the cause before delivering a
  unified report of every variable created, every regression found, every
  auto-fix applied, and anything that still needs a human eye. Use when asked
  to extract CSS variables safely, tokenise CSS and validate visually, or
  refactor CSS to custom properties with self-correction.
compatibility: >
  Requires Python 3.10+, Node.js, and Playwright. The project must be a git
  repository with a build/serve command. Skills css-extract-variables,
  visual-regression, and changes-report must be present in .agents/skills/.
skills:
  - css-extract-variables
  - visual-regression
  - changes-report
metadata:
  author: the-morning-bell
  version: "1.0"
---

## Overview

Safely refactor CSS by extracting hardcoded values into custom properties, then
using visual regression to verify nothing looks different. Auto-fixes any
regression it causes — targeting only the specific variable that broke a route —
and produces a single report covering extraction, regressions, fixes, and
change explanations.

## Config

| File | Feeds | Key settings |
|---|---|---|
| `css-extract-variables.config.json` | Phase 2 | `target`, `prefix`, `threshold`, `approximate`, `normalize` |
| `visual-regression.config.json` | Phases 1, 3–5 | `routes`, `viewports`, `threshold`, `serveCommand` |

Agent-level overrides (in either config file or as CLI flags):

| Key | Default | Description |
|---|---|---|
| `maxFixIterations` | `3` | Max auto-fix cycles per failing route |
| `outputDir` | `".css-refactor"` | Where to write the combined report |
| `devLevel` | `"junior"` | Explanation depth for changes-report |
| `dryRun` | `false` | Preview extraction only; skip visual regression |

## Phase 0 — Pre-flight

Before doing anything:

- Confirm the working directory is a git repository
- Check for uncommitted changes: warn and ask for confirmation (they will be
  stashed during visual regression worktree operations and restored at the end)
- Confirm `css-extract-variables`, `visual-regression`, and `changes-report`
  are all present in `.agents/skills/`
- Resolve and surface the merged config from both config files to the user;
  ask for confirmation before proceeding
- Confirm the app's build/serve command is resolvable (required for screenshots)
- If `dryRun: true`: run Phase 2 in dry-run mode, print the extraction preview,
  and stop — do not take any screenshots or write any files

## Phase 1 — Baseline snapshot (pre-extraction)

Capture screenshots of the app **before** any CSS changes. This is the
immutable reference for all regression checks in this run.

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode capture \
  --config visual-regression.config.json \
  --output-dir .css-refactor/baseline-before \
  --project-dir <path-to-project>
```

Store screenshots in `.css-refactor/baseline-before/<viewport>/<route-slug>.png`.
These are never overwritten after this point.

## Phase 2 — Extract CSS variables

```bash
python3 .agents/skills/css-extract-variables/scripts/extractor.py \
  --config css-extract-variables.config.json \
  --mode run \
  --project-dir <path-to-project>
```

Record for the final report:
- Variables created (by type)
- Files modified
- Occurrences replaced
- Variables file path

**If extraction produces zero changes**: report this and stop.

**If extraction produces >50 variables or >30 modified files**: show the
preview and ask for confirmation before continuing.

**If the build/serve command fails after extraction**: treat all routes as
`fail`, enter Phase 4, and diagnose a full revert if needed.

## Phase 3 — First visual regression pass

Compare post-extraction screenshots against the Phase 1 baseline:

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode run \
  --config visual-regression.config.json \
  --baseline-dir .css-refactor/baseline-before \
  --project-dir <path-to-project>
```

Read `.visual-regression/comparisons.json`.

- **All pass** → skip Phase 4, go to Phase 5.
- **Any fail** → enter Phase 4 for each failing pair.
- **Any warn** → note in report; do not auto-fix warn — only `fail` triggers
  the fix loop.

## Phase 4 — Auto-fix loop

Process failing `(route, viewport)` pairs in order of `diffRatio` descending.
For each, run up to `maxFixIterations` fix cycles.

### Step 4a — Diagnose the regression

1. Open the diff image: `.visual-regression/diff/<viewport>/<route-slug>.png`
2. Find the bounding box of the highest concentration of red pixels
3. Use Playwright to inspect computed styles at the changed region:
   - Navigate to the route on the running candidate server
   - `document.elementFromPoint(cx, cy)` at the diff bounding-box centre
   - `getComputedStyle(element)` — compare against pre-extraction CSS values
     from the git diff of the extracted files
4. Classify the root cause:

| Category | What happened | Signal |
|---|---|---|
| `value-approximated` | Color/spacing was snapped to a nearby variable but differs visually | Same shape, slightly wrong shade or size |
| `unit-converted` | `px` → `rem` conversion mismatch (root font size differs from assumed 16px) | Element changed size proportionally |
| `approximation-collapsed` | Two visually distinct values were merged into one variable | Regression appears on multiple unrelated elements |
| `variable-missing` | Selector specificity loss after switching to a variable | Element lost styling entirely |
| `value-scope` | Variable declared in wrong scope | Route-specific regression; others pass |

Do **not** attempt auto-fix when:
- The diff region covers >50% of the viewport (`structural-change` — flag for human)
- The comparison is marked `unstable` (σ > 20% across iterations)

### Step 4b — Apply the targeted fix

Apply the smallest change that resolves the regression:

| Category | Fix |
|---|---|
| `value-approximated` | Replace the approximated variable value with the exact original value in the variables file |
| `unit-converted` | Revert this specific variable's unit back to `px` |
| `approximation-collapsed` | Split the merged variable into two with the exact original values; update all references |
| `variable-missing` | Adjust selector specificity or add `:where()` wrapper to lower specificity of the extracted rule |
| `value-scope` | Move the variable declaration to a scoped selector or component-level block |

**Rules:**
- Only modify the variables file or the specific CSS occurrence — never touch
  source HTML, component logic, or the baseline screenshots
- One fix per cycle — apply, then re-validate before trying another fix

### Step 4c — Re-validate the fixed route

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode capture-single \
  --route <route> \
  --viewport <viewport> \
  --baseline-dir .css-refactor/baseline-before \
  --project-dir <path-to-project>
```

- **Passes** → mark resolved, move to the next failing route.
- **Still fails** → run another fix cycle (up to `maxFixIterations`).
- **`maxFixIterations` exhausted** → revert the last failed fix attempt,
  mark the route `unresolved`, move on.

## Phase 5 — Final full regression pass

After all fix cycles complete, run one full regression pass to confirm the
entire codebase is clean:

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode run \
  --config visual-regression.config.json \
  --baseline-dir .css-refactor/baseline-before \
  --project-dir <path-to-project>
```

Record final pass / warn / fail counts for the report.

## Phase 6 — Combined report

### Changes documentation

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode run \
  --skills css-extract-variables \
  --output-file .css-refactor/changes.md \
  --project-dir <path-to-project>
```

### Agent summary

Write `.css-refactor/report.md`:

```markdown
# CSS Refactor Report — <date>

## Extraction Summary
- Variables created:     42  (18 colors, 14 spacing, 7 typography, 3 radii)
- Files modified:        23
- Occurrences replaced: 187
- Variables file:        src/styles/variables.css

## Visual Regression
### Before auto-fix  (24 comparisons)
Pass: 18   Warn: 3   Fail: 3

### After auto-fix   (24 comparisons)
Pass: 23   Warn: 1   Fail: 0

## Auto-fixes Applied (3 routes, 5 fixes)
| Route      | Viewport | Category              | Fix applied |
|------------|----------|-----------------------|-------------|
| /products  | desktop  | value-approximated    | --color-gray-100 restored to #ece9e9 |
| /checkout  | mobile   | unit-converted        | --spacing-4 reverted to 16px |
| /about     | tablet   | approximation-collapsed | split --color-border into --color-border-light and --color-border-dark |

## Unresolved (0)
None.

## Warnings (1 — needs human review)
/dashboard  mobile  warn  diffRatio 0.008 (within tolerance) — minor
            anti-aliasing difference, not caused by extraction.

## Full change explanation
See changes.md
```

Also write `.css-refactor/report.html` — self-contained HTML embedding the
visual diff report and extraction summary in one file.

## Skills used

| Skill | Phase | Purpose |
|---|---|---|
| `visual-regression` | 1, 3, 4c, 5 | Baseline capture, regression detection, per-route re-validation, final pass |
| `css-extract-variables` | 2 | Extract hardcoded CSS into custom properties |
| `changes-report` | 6 | Document every change at the configured dev level |

## Decision rules

- Never revert the full extraction — targeted per-variable fixes only
- Never modify the Phase 1 baseline screenshots
- Minimum viable fix — the smallest change that resolves the regression
- After `maxFixIterations`: revert the last broken attempt and mark unresolved
- `warn` routes are not auto-fixed — only `fail` triggers the loop
- Large diff region (>50% of viewport) → `structural-change`, skip auto-fix, flag for human

## Output structure

```
.css-refactor/
  baseline-before/       ← Phase 1 snapshots (immutable)
    mobile/  tablet/  desktop/
  report.md              ← combined agent summary
  report.html            ← self-contained HTML report
  changes.md             ← changes-report output

.visual-regression/      ← written by visual-regression skill
  report.html
  report.json
  diff/
```

## Edge cases

- **Uncommitted changes**: stash before Phase 1, restore after Phase 5; if
  restore fails, list stash contents and warn — never silently lose work
- **Build fails after extraction**: treat all routes as `fail`; diagnose
  whether extraction caused a syntax error in the CSS; revert if confirmed
- **No config files exist**: prompt the user to run both skills in dry-run mode
  first to generate configs, then re-invoke this agent
- **Flaky screenshots** (σ > 20% on any metric): mark `unstable`, skip
  auto-fix, document in report
- **Monorepo**: scope both skills to the same app; never cross package boundaries
- **`dryRun: true`**: Phase 2 extraction preview only; no screenshots, no writes

## Success criteria

- All routes pass final visual regression (or unresolved ones are documented)
- Every auto-fix targets only the specific variable that caused the regression
- The codebase is in a clean, committable state after completion
- The combined report covers extraction, regressions, fixes, and explanations
  in a single place
