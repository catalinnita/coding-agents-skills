# Agent Spec: CSS Refactor

## Goal

Extract all hardcoded CSS values into custom properties, immediately validate
the result with a visual regression test, and — if any regressions are detected
— automatically diagnose and fix the cause before delivering a single unified
report of every variable created, every regression found, every auto-fix
applied, and anything that still needs a human eye.

The agent leaves the codebase in a state where:
1. CSS values are tokenised into custom properties
2. No page looks visually different from before the refactor
3. Every change is documented at the configured developer level

---

## Trigger conditions

Invoke this agent when the user asks to:
- "extract CSS variables and check for regressions"
- "tokenise CSS and validate visually"
- "refactor CSS to custom properties safely"
- "run CSS extraction with visual validation"
- "extract CSS vars and self-correct if anything breaks"

---

## Inputs

All configuration comes from two config files at the project root. The agent
reads both before starting and merges them with built-in defaults.

| Config file | Feeds | Key settings |
|---|---|---|
| `css-extract-variables.config.json` | Phase 2 | `target`, `prefix`, `threshold`, `approximate`, `normalize` |
| `visual-regression.config.json` | Phase 3–4 | `routes`, `viewports`, `threshold`, `base`, `serveCommand` |

**Agent-specific overrides** (set in either config or as CLI flags):

| Key | Default | Description |
|---|---|---|
| `maxFixIterations` | `3` | Max auto-fix cycles per failing route before giving up |
| `outputDir` | `.css-refactor/` | Where to write the combined report |
| `devLevel` | `"junior"` | Explanation depth in the changes report (`absolute-beginner` \| `junior` \| `senior`) |
| `dryRun` | `false` | Preview extraction without writing files; runs visual regression against `dryRun` diff |

---

## Behavior

### Phase 0 — Pre-flight

Before doing anything:

- Confirm the working directory is a git repository
- Confirm no uncommitted changes exist (the visual regression skill uses git
  worktrees; uncommitted changes will be stashed and restored); warn and ask for
  confirmation if changes are present
- Confirm both skills are present in `.agents/skills/`:
  - `css-extract-variables`
  - `visual-regression`
  - `changes-report`
- Confirm the build/serve command for the app can be resolved (needed for
  visual regression screenshots)
- Read and surface the resolved config from both config files to the user;
  ask for confirmation before proceeding

### Phase 1 — Baseline snapshot

Before extracting any variables, capture a clean visual baseline of the
**current branch** at its current state. This snapshot becomes the reference
that all subsequent regression checks compare against — so the baseline is
"before extraction" not "main":

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode capture \
  --config visual-regression.config.json \
  --output-dir .css-refactor/baseline-before/ \
  --project-dir <path-to-project>
```

Store these screenshots as the fixed baseline for Phases 3 and 4. Do not use
the `main`/`master` branch as baseline — the refactor may be happening on a
branch that already diverges from main in other ways.

### Phase 2 — Extract CSS variables

Run the `css-extract-variables` skill:

```bash
python3 .agents/skills/css-extract-variables/scripts/extractor.py \
  --config css-extract-variables.config.json \
  --mode run \
  --project-dir <path-to-project>
```

Record the extraction output for the final report:
- Number of variables created (by type: colors, spacing, typography, etc.)
- Number of files modified
- Number of value occurrences replaced
- The generated variables file path (e.g. `src/styles/variables.css`)

If extraction produces zero changes, report this and stop — nothing to validate.

### Phase 3 — First visual regression pass

Compare the post-extraction state against the Phase 1 baseline:

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode run \
  --config visual-regression.config.json \
  --baseline-dir .css-refactor/baseline-before/ \
  --candidate-dir .css-refactor/candidate/ \
  --project-dir <path-to-project>
```

Collect per-route, per-viewport results from `.visual-regression/comparisons.json`.

**If all comparisons pass** → skip Phase 4, go directly to Phase 5.

**If any comparisons fail or warn** → enter Phase 4 for each failing route.

### Phase 4 — Auto-fix loop

For each failing `(route, viewport)` pair, run up to `maxFixIterations` fix
cycles. Process failures in order of `diffRatio` descending (most broken first).

#### Per-failure fix cycle

**Step 4a — Diagnose the regression**

1. Open the diff image for the failing pair:
   `.visual-regression/diff/<viewport>/<route-slug>.png`

2. Identify the bounding box of the changed region in the diff image (highest
   concentration of red pixels)

3. Use Playwright to inspect which CSS properties changed in that region:
   - Navigate to the route on the candidate server
   - Find the element at the diff bounding-box coordinates via `document.elementFromPoint`
   - Call `getComputedStyle()` on that element and its ancestors
   - Compare the computed values against the same selectors in the pre-extraction
     baseline CSS (read the git diff of the CSS files)

4. Identify the root cause category:

| Category | Symptoms | Example |
|---|---|---|
| `value-approximated` | Color or spacing is slightly off — same shape, wrong shade/size | `#e9e9e9` was merged with `#f0f0f0` |
| `unit-converted` | Element changed size — correct proportions, wrong scale | `16px` → `1rem` but root font size differs |
| `variable-missing` | Element lost styling entirely | Selector specificity issue after variable switch |
| `value-scope` | Element correct on some pages, broken on others | Variable defined in wrong scope (`:root` vs component) |
| `approximation-collapsed` | Two visually distinct values were merged into one variable | Two grays that look the same in isolation but differ in context |

**Step 4b — Apply targeted fix**

Apply the minimal fix that resolves the regression for this element without
reverting more than necessary:

| Category | Fix strategy |
|---|---|
| `value-approximated` | Replace the approximated variable value with the exact original value in the variables file |
| `unit-converted` | Revert the unit conversion for this specific variable (keep `px` if `rem` caused the regression) |
| `variable-missing` | Add an explicit `!important` or adjust selector specificity in the extraction output |
| `value-scope` | Move the variable declaration to the correct scope (component-level `:local` or specific selector) |
| `approximation-collapsed` | Split the merged variable into two distinct variables with the exact original values |

**Never:**
- Revert the entire extraction — only fix the specific variable or occurrence
  that caused the regression
- Modify the visual regression baseline — the baseline is the source of truth
- Change source HTML or component logic — only modify CSS/SCSS variable files

**Step 4c — Re-validate the fixed route**

Re-run visual regression for only the fixed route and viewport:

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode capture-single \
  --route <route> \
  --viewport <viewport> \
  --project-dir <path-to-project>
```

Compare against the Phase 1 baseline. If the route now passes → resolve and
move to the next failing route. If it still fails → run another fix cycle (up
to `maxFixIterations`).

**After `maxFixIterations` with no resolution:** mark the route as
`unresolved` in the report, document the last attempted fix and its diff ratio,
and move on. Do not leave the code in a partially-fixed state — revert the
last failed fix attempt before moving to the next route.

### Phase 5 — Final full visual regression

After all auto-fix cycles complete, run one final full visual regression pass
across all routes and viewports to confirm the complete codebase is clean:

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode run \
  --config visual-regression.config.json \
  --baseline-dir .css-refactor/baseline-before/ \
  --project-dir <path-to-project>
```

Record the final pass/warn/fail counts.

### Phase 6 — Combined report

Generate a single unified report covering the full refactor lifecycle.

Invoke the `changes-report` skill scoped to this agent's output:

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode run \
  --config changes-report.config.json \
  --skills css-extract-variables \
  --output-file .css-refactor/changes.md \
  --project-dir <path-to-project>
```

Then write the agent's own summary to `.css-refactor/report.md`:

```markdown
# CSS Refactor Report — 2026-05-22 14:32

## Extraction Summary
- Variables created:       42  (18 colors, 14 spacing, 7 typography, 3 radii)
- Files modified:          23
- Occurrences replaced:   187
- Variables file:          src/styles/variables.css

## Visual Regression Results
### Before auto-fix:   8 routes × 3 viewports = 24 comparisons
- Pass:    18   Warn: 3   Fail: 3

### After auto-fix:    24 comparisons
- Pass:    23   Warn: 1   Fail: 0

## Auto-fixes Applied (3 routes, 5 fixes)
| Route | Viewport | Category | Fix |
|---|---|---|---|
| /products | desktop | value-approximated | `--color-gray-100` restored from `#f0f0f0` to `#ece9e9` |
| /checkout | mobile | unit-converted | `--spacing-4` reverted from `1rem` to `16px` |
| /about | tablet | approximation-collapsed | Split `--color-border` into `--color-border-light` (#e0e0e0) and `--color-border-dark` (#c8c8c8) |

## Unresolved Regressions (0)
None — all regressions were resolved automatically.

## Changes Documentation
See changes.md for full explanations at junior level.
```

Also write `.css-refactor/report.html` — self-contained HTML combining the
visual regression diff report and the extraction changes in a single file.

---

## Skills used

| Skill | Phase | Purpose |
|---|---|---|
| `visual-regression` | 1, 3, 4, 5 | Baseline snapshot, regression detection, per-route re-validation |
| `css-extract-variables` | 2 | Extract hardcoded CSS values into custom properties |
| `changes-report` | 6 | Document every change at the configured developer level |

---

## Decision rules

- **Never revert the full extraction** — targeted per-variable fixes only
- **Never modify the baseline** — the Phase 1 snapshot is immutable
- **Minimum viable fix** — apply the smallest change that resolves the regression
- **Stop auto-fixing after `maxFixIterations`** — revert the last broken attempt, mark as unresolved, and move on
- **Routes with `warn` status are not auto-fixed** — they are noted in the report for human review; only `fail` status triggers auto-fix
- **Ask before writing** if the extraction produces more than 50 variables or modifies more than 30 files — large refactors deserve human confirmation

---

## Output structure

```
.css-refactor/
  baseline-before/      ← Phase 1 screenshots (pre-extraction)
    mobile/  tablet/  desktop/
  candidate/            ← Phase 3/5 screenshots (post-extraction)
    mobile/  tablet/  desktop/
  report.md             ← combined agent summary
  report.html           ← self-contained HTML report
  changes.md            ← changes-report skill output (level-appropriate)

.visual-regression/     ← written by visual-regression skill
  report.html
  report.json
  diff/
```

---

## Edge cases

- **Uncommitted changes at start**: stash them, run the agent, restore the stash in Phase 5 teardown; if the restore fails, warn the user and list the stash contents
- **First run with no config files**: prompt the user to run `css-extract-variables` and `visual-regression` in dry-run mode first to generate configs, then re-invoke the agent
- **Extraction changes break the build**: if the serve command fails after extraction, treat all routes as `fail` and trigger Phase 4 for a full revert-and-diagnose pass
- **Diff region too large (>50% of viewport)**: mark as `structural-change` — likely a layout regression, not a value mismatch; do not attempt auto-fix; surface for human review
- **Flaky screenshots** (σ > 20% across iterations): mark as `unstable`, skip auto-fix, note in report that the route needs manual verification
- **`dryRun: true`**: run Phase 1 and 2 (extraction preview only), show the list of variables that would be created and files that would change; do not run visual regression or write any files
- **Monorepo**: scope both skills to the specific app configured in both config files; do not cross app boundaries

---

## Success criteria

- All routes pass visual regression after the refactor (or unresolved routes are clearly documented)
- Every variable created maps to at least one replaced occurrence in source files
- No auto-fix reverts more than a single variable's value or scope
- The combined report accurately reflects: variables extracted, regressions found, fixes applied, and what remains for humans
- The codebase is in a clean, committable state after the agent completes
