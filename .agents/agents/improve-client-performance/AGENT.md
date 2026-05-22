---
name: improve-client-performance
type: agent
description: >
  Pulls the latest Lighthouse report (or generates one if none exists), fixes
  every auto-fixable audit using the lighthouse-fix skill, runs visual
  regression to verify nothing broke visually, auto-corrects any visual diffs,
  then re-runs Lighthouse and repeats the entire fix-verify-correct cycle until
  both the Lighthouse score is stable and all routes pass visual regression.
  After every fix pass it calls the changes-report skill to document what
  changed. Delivers a consolidated timeline of score progress, visual regression
  status per iteration, all fixes and visual corrections applied, and a final
  list of issues requiring manual attention. Use when asked to improve Lighthouse
  score, fix performance issues automatically, or iteratively improve client
  performance without breaking anything visually.
compatibility: >
  Requires Node.js, Chrome/Chromium, the Lighthouse CLI, and Playwright.
  Skills lighthouse-tests, lighthouse-fix, visual-regression, and changes-report
  must be present in .agents/skills/.
skills:
  - lighthouse-tests
  - lighthouse-fix
  - visual-regression
  - changes-report
metadata:
  author: catalin nita
  version: "1.1"
---

## Overview

A self-improving loop that drives Lighthouse scores as high as auto-fixable code
changes allow, while guaranteeing that no page looks different after any fix.
Each full cycle: fix → visual check → correct diffs → measure → log. The loop
continues until both conditions are satisfied: no more auto-fixable Lighthouse
audits **and** visual regression passes clean.

## Config

Read from `performance.config.json` plus an optional `improveClientPerformance`
section:

| Key | Default | Description |
|---|---|---|
| `maxIterations` | `5` | Max Lighthouse fix-and-measure cycles |
| `maxVisualFixIterations` | `3` | Max visual correction attempts per failing route per iteration |
| `maxAgeMinutes` | `60` | Reuse existing Lighthouse report if younger than N minutes |
| `minScoreDelta` | `1` | Stop if score did not improve by at least this many points |
| `devLevel` | `"junior"` | Explanation depth for changes-report |
| `outputDir` | `".performance/improve"` | Where to write all iteration artefacts |
| `categories` | `["performance"]` | Lighthouse categories to evaluate |

All `lighthouse.*`, `lighthousefix.*`, and `visual-regression.*` keys are
forwarded to the underlying skills unchanged.

## Phase 0 — Pre-flight

- Confirm `performance.config.json` exists; if not, offer to create a default and stop
- Confirm all four skills are in `.agents/skills/`: `lighthouse-tests`,
  `lighthouse-fix`, `visual-regression`, `changes-report`
- Confirm Chrome/Chromium is available (required for both Lighthouse and Playwright)
- Confirm the app's serve command is resolvable
- Read and surface the resolved config; ask for confirmation before proceeding
- Ensure `outputDir` (default `.performance/improve`) is listed in the project's `.gitignore`; append it if missing — never prompt the user about this

## Phase 1 — Get or generate initial Lighthouse report

```bash
python3 .agents/skills/lighthouse-fix/scripts/runner.py \
  --mode locate \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Use an existing raw result if younger than `maxAgeMinutes`; otherwise generate
a fresh one:

```bash
python3 .agents/skills/lighthouse-tests/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Record the **baseline** Lighthouse score and all metrics for the final timeline.

## Phase 1b — Capture visual baseline

Before any code changes, capture a clean screenshot set of the current app
state. This is the immutable reference for all visual regression checks in
this run.

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode capture \
  --config visual-regression.config.json \
  --output-dir .performance/improve/visual-baseline \
  --project-dir <path-to-project>
```

Log:
```
[baseline] Visual baseline captured — 8 routes × 3 viewports = 24 screenshots
```

These screenshots are **never overwritten**. Every subsequent visual regression
check compares against this set.

## Phase 2 — Fix-and-verify loop

Repeat up to `maxIterations` times:

```
iteration = 1

while iteration <= maxIterations:
  Step A — Classify current Lighthouse audits
  Step B — Stop if no auto-fixable audits remain AND no visual diffs
  Step C — Apply lighthouse-fix
  Step D — Run visual regression (compare against Phase 1b baseline)
  Step E — Auto-correct visual diffs (if any)
  Step F — Log all changes with changes-report
  Step G — Re-run Lighthouse
  Step H — Check loop termination conditions
  iteration += 1
```

---

### Step A — Classify current audits

```bash
python3 .agents/skills/lighthouse-fix/scripts/runner.py \
  --mode classify \
  --project-dir <path-to-project>
```

Classify all audits in the latest Lighthouse JSON as: auto-fixable /
config-fixable / manual.

```
[iter 1] Lighthouse: 5 auto-fixable, 2 config-fixable, 3 manual
```

---

### Step B — Stop conditions check

Exit the loop **immediately** if **both** are true:
1. The auto-fixable audit list is empty (no more Lighthouse fixes to apply)
2. The latest visual regression has 0 failing routes (or no visual regression
   has run yet and Step A shows nothing to fix)

If only one is resolved but not the other, continue the loop.

```
[iter 3] Lighthouse: 0 auto-fixable. Visual regression: 0 failures. Loop complete.
```

---

### Step C — Apply lighthouse-fix

```bash
python3 .agents/skills/lighthouse-fix/scripts/runner.py \
  --mode fix \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Record fixes applied, audit IDs resolved, files changed, and estimated savings.
Write `<outputDir>/iteration-<N>-lh-fixes.json`.

If zero fixes are applied despite a non-empty auto-fixable list: proceed
directly to Step D (the visual regression check still matters).

---

### Step D — Visual regression check

Compare the post-fix app against the Phase 1b baseline:

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode run \
  --config visual-regression.config.json \
  --baseline-dir .performance/improve/visual-baseline \
  --project-dir <path-to-project>
```

Log the per-route result:

```
[iter 1] Visual regression: 22 pass, 1 warn, 1 fail
         FAIL  /checkout  desktop  diffRatio 0.048  SSIM 0.91
         WARN  /products  mobile   diffRatio 0.008  SSIM 0.98
```

- **All pass** → skip Step E, continue to Step F
- **Any fail** → enter Step E for each failing route
- **Warn only** → log; do not auto-correct warns; note in the report

---

### Step E — Auto-correct visual diffs

For each **failing** `(route, viewport)` pair, run up to `maxVisualFixIterations`
correction cycles. Process failures in order of `diffRatio` descending.

#### Step E1 — Diagnose the regression

1. Open the diff image: `.visual-regression/diff/<viewport>/<route-slug>.png`
2. Find the bounding box of the highest red-pixel concentration
3. Use Playwright to inspect computed styles at the diff region:
   - `document.elementFromPoint(cx, cy)` at the diff bounding-box centre
   - `getComputedStyle(element)` — compare against values before this
     iteration's lighthouse-fix changes (read the git diff of modified files)
4. Classify the root cause:

| Category | Signal | Cause |
|---|---|---|
| `value-changed` | Same element, slightly different colour or size | A CSS value was altered by a lighthouse-fix (e.g. image dimensions added changed layout) |
| `element-missing` | Region is empty or blank | A `defer`-ed script that was previously render-blocking now loads later, leaving a flash |
| `layout-shift` | Content moved position | `width`/`height` added to an image changed surrounding element flow |
| `webp-fallback` | Image not rendered | WebP `<picture>` conversion has a browser/viewport rendering difference |
| `font-swap` | Text reflows during load | `font-display: swap` caused a layout shift in the screenshot |

Do **not** attempt auto-correction when:
- The diff region covers >50% of the viewport (`structural-change`) — flag for human
- The route was already `warn` before this fix pass began (pre-existing diff)

#### Step E2 — Apply the targeted correction

| Category | Correction |
|---|---|
| `layout-shift` (from image sizing) | Add `aspect-ratio: <w>/<h>` to the image's CSS selector to preserve space |
| `webp-fallback` | Restore the original `<img>` for the specific failing viewport breakpoint; keep WebP for passing viewports |
| `font-swap` | Add `size-adjust` and `ascent-override` to the `@font-face` to match the fallback metrics; or revert `font-display: swap` for this specific font face |
| `element-missing` / `value-changed` | Inspect the lighthouse-fix change and revert only the specific CSS property that caused the regression |

Only modify the minimal set of CSS/HTML lines that address the visual diff.
Never revert an entire audit's changes — only fix the specific property.

#### Step E3 — Re-validate the corrected route

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --mode capture-single \
  --route <route> \
  --viewport <viewport> \
  --baseline-dir .performance/improve/visual-baseline \
  --project-dir <path-to-project>
```

- **Passes** → mark resolved, move to the next failing route
- **Still fails** → run another correction cycle (up to `maxVisualFixIterations`)
- **Exhausted** → revert the last failed correction attempt; mark the route
  `unresolved-visual`; move on — do not leave the code in a broken state

Log after all corrections:

```
[iter 1] Visual corrections applied: 2
         /checkout desktop: layout-shift fixed — added aspect-ratio to hero image
         /products mobile:  warn only, skipped
         Unresolved visual: 0
```

---

### Step F — Log all changes with changes-report

After lighthouse-fix AND visual corrections, document everything that changed
in this iteration:

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode run \
  --skills lighthouse-fix \
  --output-file <outputDir>/iteration-<N>-changes.md \
  --project-dir <path-to-project>
```

The changes log covers both the lighthouse-fix changes and the visual
corrections applied in Step E, at `devLevel` depth. One file per iteration.

---

### Step G — Re-run Lighthouse

```bash
python3 .agents/skills/lighthouse-tests/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Log score delta:

```
[iter 1] Lighthouse:  Score 68 → 79  (+11)
                      LCP   3.2s → 2.1s  ▲
                      TBT   480ms → 180ms  ▲
                      CLS   0.18 → 0.18  —
         Visual:      22 pass  0 fail  1 warn
```

---

### Step H — Loop termination conditions

| Condition | Action |
|---|---|
| No auto-fixable audits AND 0 visual failures | Stop — fully resolved |
| `lighthouse-fix` applied 0 changes AND 0 visual failures | Stop — nothing left to change |
| Lighthouse score delta < `minScoreDelta` AND 0 visual failures | Stop — score plateau |
| Same Lighthouse audit IDs fail two consecutive iterations | Infinite-loop guard — stop |
| `maxIterations` reached | Stop — report current state |
| Score regression after a fix pass | Revert that iteration's changes; stop |

Log the termination reason before Phase 3.

## Phase 3 — Consolidated report

Write `<outputDir>/report.md`:

```markdown
# Improve Client Performance — 2026-05-22 14:32

## Score & Visual Timeline

| Iter | Score | LCP   | TBT   | CLS  | LH Fixes | VR Pass | VR Fail | VR Corrections |
|------|-------|-------|-------|------|----------|---------|---------|----------------|
| Base |  68   | 3.2s  | 480ms | 0.18 | —        | 24      | —       | —              |
| 1    |  79   | 2.1s  | 180ms | 0.18 | 6        | 23      | 1       | 1              |
| 2    |  84   | 1.9s  | 120ms | 0.03 | 3        | 24      | 0       | 0              |

**Final Lighthouse score: 84  (+16)**
**Final visual regression: 24/24 pass**
**Loop stopped: no auto-fixable audits, no visual failures**

---

## Changes by iteration

### Iteration 1 — 6 Lighthouse fixes, 1 visual correction
See iteration-1-changes.md for full explanations.

Lighthouse fixes:
- render-blocking-resources: added `defer` to 3 scripts → ~680ms TBT saved
- uses-rel-preconnect: added preconnect for fonts.googleapis.com
- font-display: added `font-display: swap` to 4 @font-face rules
- preload-lcp-image: added preload for /hero.jpg

Visual correction:
- /checkout desktop: layout-shift — added aspect-ratio:2/1 to .hero-image
  (cause: width/height added to img changed surrounding flow)

### Iteration 2 — 3 Lighthouse fixes, 0 visual corrections
See iteration-2-changes.md.

Lighthouse fixes:
- unsized-images: added width/height to 2 images → CLS 0.18 → 0.03
- uses-webp-images: converted hero.jpg to WebP, saved 142KB
- uses-passive-event-listeners: added { passive: true } to scroll handlers

---

## Remaining issues (manual attention required)

### Lighthouse — manual
- unused-javascript: 54KB in /static/chunks/checkout.js → use next/dynamic
- dom-size: 1,842 elements → virtualise long lists

### Visual — unresolved
None.

---

## Config guidance
See .performance/improve/config-guidance.md
```

Also write `<outputDir>/report.json`:

```json
{
  "startedAt": "2026-05-22T14:32:00Z",
  "completedAt": "2026-05-22T14:58:00Z",
  "baselineScore": 68,
  "finalScore": 84,
  "scoreDelta": 16,
  "finalVisualStatus": "pass",
  "iterations": 2,
  "totalLighthouseFixes": 9,
  "totalVisualCorrections": 1,
  "terminationReason": "no-auto-fixable-audits-and-no-visual-failures",
  "remainingManualIssues": 2,
  "unresolvedVisualRoutes": 0,
  "iterationLogs": [
    {
      "iteration": 1,
      "lighthouseScore": 79,
      "lighthouseFixes": 6,
      "visualPass": 23, "visualFail": 1, "visualCorrections": 1,
      "log": "iteration-1-changes.md"
    },
    {
      "iteration": 2,
      "lighthouseScore": 84,
      "lighthouseFixes": 3,
      "visualPass": 24, "visualFail": 0, "visualCorrections": 0,
      "log": "iteration-2-changes.md"
    }
  ]
}
```

## Skills used

| Skill | Phase | Purpose |
|---|---|---|
| `lighthouse-tests` | 1, 2G | Generate or refresh Lighthouse measurements |
| `lighthouse-fix` | 2A, 2C | Classify audits; apply auto-fixable code changes |
| `visual-regression` | 1b, 2D, 2E3 | Capture baseline; detect diffs; re-validate after corrections |
| `changes-report` | 2F | Document every code change at `devLevel` depth after each iteration |

## Decision rules

- **Both conditions must be met to stop**: no auto-fixable Lighthouse audits
  remaining **and** no visual regression failures — one alone is not enough
- **Visual baseline is captured once and never overwritten** — it always represents
  the state before any fix in this run
- **`warn` visual routes are not auto-corrected** — noted in the report; only
  `fail` routes trigger Step E
- **Minimum viable visual correction** — revert only the specific CSS property
  that caused the diff; never revert an entire lighthouse-fix audit's changes
- **After `maxVisualFixIterations` failures on one route**: revert the last
  broken attempt; mark `unresolved-visual`; move on — never block the whole
  loop on one route
- **Score regression → immediate stop and revert** — a fix pass that lowers the
  Lighthouse score is reverted (git checkout of changed files) and logged; the
  loop ends rather than trying again
- **`changes-report` captures both lighthouse and visual corrections** — one log
  per iteration covering all changes made in that cycle

## Output structure

```
.performance/improve/
  visual-baseline/              ← Phase 1b snapshots (immutable)
    mobile/  tablet/  desktop/
  report.md                     ← consolidated timeline (open this)
  report.json                   ← machine-readable summary
  config-guidance.md            ← copy-paste config snippets
  iteration-1-lh-fixes.json     ← raw Lighthouse fix records
  iteration-1-changes.md        ← dev-level explanation of all changes
  iteration-2-lh-fixes.json
  iteration-2-changes.md
  ...

.performance/                   ← updated by each lighthouse-tests run
  lighthouse-report.html
  lighthouse-report.json
  history/lighthouse/...

.visual-regression/             ← updated by each visual-regression run
  report.html
  report.json
  diff/
```

## Edge cases

- **First run, no config**: offer to create `performance.config.json` and stop
- **App not running**: abort in Phase 1 with a clear message
- **Visual baseline fails to capture**: if the baseline capture errors on any
  route, abort — cannot run visual regression without a clean baseline
- **`maxIterations` reached**: write the consolidated report; label remaining
  issues as iteration-cap limited, not impossible
- **Score regression**: revert that iteration's changes; stop and report
- **Flaky Lighthouse results** (score fluctuates >5 points on identical code):
  flag instability; do not interpret noise as improvement or regression
- **Visual diff region >50% of viewport**: classify as `structural-change`;
  skip auto-correction; flag for human
- **Pre-existing visual diffs** (baseline already differed from `main`):
  Phase 1b captures the pre-fix state, so pre-existing diffs are not flagged —
  only diffs *introduced* by lighthouse-fix changes appear in Step D
- **Uncommitted changes at start**: warn the user; suggest committing first so
  each iteration produces a clean, reviewable diff

## Success criteria

- Lighthouse score improves on each iteration that applies at least one fix
- All routes pass visual regression at the end of the run (or unresolved routes
  are clearly documented with the specific diff that could not be corrected)
- Every code change — lighthouse fix or visual correction — has a corresponding
  entry in the iteration's `changes.md`
- The loop terminates cleanly; always produces a final report
- No lighthouse-fix change from a previous iteration is re-applied in a later one
- The visual baseline is never modified during the run
