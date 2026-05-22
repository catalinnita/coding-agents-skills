---
name: performance-report
type: agent
description: >
  Measures and reports on performance metrics — bundle sizes, Lighthouse Core
  Web Vitals, and SSR render times — from a single performance.config.json.
  Produces versioned HTML and JSON reports with trend history and threshold
  badges. Does not apply any fixes; for acting on the results use the
  lighthouse-fix skill. Use when asked to measure performance, generate a
  performance report, check scores, or audit bundle and render times.
compatibility: >
  Requires Node.js and the project's build toolchain. Skills lighthouse-tests,
  bundle-sizes, and page-render must be present in .agents/skills/.
skills:
  - bundle-sizes
  - lighthouse-tests
  - page-render
metadata:
  author: catalin nita
  version: "1.1"
---

## Overview

Run the three performance measurement skills, accumulate versioned history, and
merge all results into a single `performance-report.html`. Read-only: measures
and reports only, never modifies source files. To act on the findings, pipe the
Lighthouse results into the `lighthouse-fix` skill.

## Config

All configuration lives in `performance.config.json` at the project root.

Optional CLI overrides:

| Flag | Effect |
|---|---|
| `--only bundle\|lighthouse\|render` | Run only the named measurement(s) |
| `--ci` | Exit non-zero if any threshold is missed; stdout only, no HTML |
| `--no-build` | Skip the build step in `bundle-sizes` (use existing output dir) |

## Phase 0 — Pre-flight

- Confirm `performance.config.json` exists; if not, offer to write a default and
  stop — never fall back to hardcoded defaults silently
- Validate the config: required keys present, all numeric thresholds > 0, URLs
  non-empty
- Determine which measurements are enabled:
  - `bundle-sizes`: enabled if `buildCommand` is configured or auto-detected
  - `lighthouse-tests`: enabled if `lighthouse.urls` is non-empty
  - `page-render`: enabled if `pageRender.urls` is non-empty
- Warn about any disabled measurement and explain why

## Phase 1 — Bundle Sizes

Run first — the build must succeed before the live-app measurements begin.

```bash
python3 .agents/skills/bundle-sizes/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project> \
  [--no-build] [--ci]
```

If the build fails: abort the entire run. Print the build error clearly.

Consumes: `.performance/bundle-report.json`

## Phase 2 — Lighthouse Tests and Page Render (parallel)

```bash
python3 .agents/skills/lighthouse-tests/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project> \
  [--ci]

python3 .agents/skills/page-render/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project> \
  [--ci]
```

Wait for both to complete.

Consumes:
- `.performance/lighthouse-report.json`
- `.performance/render-report.json`

## Phase 3 — Combined report

Merge the three JSON reports into a single summary.

`<outputDir>/performance-report.html` — self-contained HTML:

```
Performance Report — 2026-05-22 14:32

┌──────────────────────────────────────────────────────────┐
│  PASS  Bundle Sizes    JS 260KB gz · CSS 22KB gz         │
│  PASS  Lighthouse      Score 94/100 · LCP 1.82s          │
│  WARN  Page Render     Render 148ms · Origin requests: 3 │
└──────────────────────────────────────────────────────────┘

To fix Lighthouse issues: run the lighthouse-fix skill.
```

**Sections:**

1. **Executive summary** — PASS / WARN / FAIL per measurement with the most
   important metric from each
2. **Regressions** — metrics that worsened since the previous run (🔴); shown
   only when history exists
3. **Bundle Sizes** — totals by category, largest chunks, SVG treemap, size
   history chart
4. **Lighthouse** — Core Web Vitals table, asset sizes, score history chart;
   links to `lighthouse-fix` for each failing audit
5. **Page Render** — render time, TTFB, origin vs CDN breakdown, history chart
6. **Thresholds** — every configured threshold vs current value, colour-coded

`<outputDir>/performance-report.json`:

```json
{
  "timestamp": "2026-05-22T14:32:00Z",
  "status": "warn",
  "skills": {
    "bundleSizes":     { "status": "pass", "reportFile": "bundle-report.json" },
    "lighthouseTests": { "status": "pass", "reportFile": "lighthouse-report.json" },
    "pageRender":      { "status": "warn", "reportFile": "render-report.json" }
  },
  "nextStep": "Run lighthouse-fix to address failing Lighthouse audits."
}
```

Top-level `status` = worst of the three (`fail` > `warn` > `pass`).

## Phase 4 — CI exit code (when `--ci`)

Exit `0` if all thresholds pass. Exit `1` if any threshold fails.

Stdout (machine-parseable, no colour codes):

```
PASS  bundle-sizes    totalJs 260KB < threshold 500KB
PASS  lighthouse      score 94 >= threshold 90
WARN  page-render     originRequests 3 within 10% of threshold 10
```

## Skills used

| Skill | Phase | Purpose |
|---|---|---|
| `bundle-sizes` | 1 | Build the project; measure output asset sizes |
| `lighthouse-tests` | 2 (parallel) | Audit Core Web Vitals and performance scores |
| `page-render` | 2 (parallel) | Measure SSR render time and origin request counts |

## What this agent does NOT do

- It does not modify source files, config, or build scripts
- It does not fix failing Lighthouse audits — run `lighthouse-fix` for that
- It does not compress images, add `defer`, or change CSS — those are `lighthouse-fix` responsibilities

## Decision rules

- Always run `bundle-sizes` first; abort on build failure
- `lighthouse-tests` and `page-render` run in parallel
- If `--only` is set, skip the combined report if fewer than two measurements ran
- Combined `status` = worst individual status
- CI mode: stdout must be machine-parseable; no spinners

## Output structure

```
performance.config.json           ← shared config (project root)

.performance/
  performance-report.html         ← combined report (open this)
  performance-report.json         ← machine-readable summary
  bundle-report.html
  bundle-report.json
  lighthouse-report.html
  lighthouse-report.json
  render-report.html
  render-report.json
  history/
    bundle/<timestamp>.json
    lighthouse/<url-slug>/<timestamp>.json
    render/<url-slug>/<timestamp>.json
```

## Edge cases

- **`performance.config.json` missing**: offer to write a default and stop
- **All URLs unreachable**: abort after Phase 0; do not write partial reports
- **One measurement disabled**: run the rest; note which was skipped and why
- **`--only` skips `bundle-sizes`**: Lighthouse and Page Render may measure a
  stale build — warn the user explicitly
- **`page-render` server lifecycle**: handled entirely by the `page-render`
  skill; this agent does not start or stop servers

## Success criteria

- All enabled measurement reports written to `outputDir`
- No source files modified
- Combined report accurately reflects the worst status across all measurements
- History accumulates across runs for trend charts
- `performance-report.html` is self-contained and opens without a server
- CI exit code correctly reflects pass/fail
