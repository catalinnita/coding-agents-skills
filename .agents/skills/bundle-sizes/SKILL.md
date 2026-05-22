---
name: bundle-sizes
description: >
  Builds the project, measures every output asset (JS, CSS, images, fonts) in
  raw and gzip sizes, checks against configured thresholds, persists versioned
  JSON history, and produces a self-contained HTML report with an SVG treemap
  and size trend charts. Use when asked to analyse bundle sizes, check for size
  regressions, or show bundle size history.
compatibility: >
  Requires Python 3.10+ and Node.js. Build toolchain (Next.js, Vite, CRA, etc.)
  must be installed in the project.
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Build the project, measure every output asset, check size thresholds, persist
versioned JSON history, and produce a self-contained HTML report with SVG
treemap and size trend charts. Reads all configuration from the `bundleSizes`
section of `performance.config.json`.

## Config (performance.config.json → `bundleSizes`)

| Key | Default | Description |
|---|---|---|
| `buildCommand` | auto-detected | Command to build the project |
| `buildOutputDir` | auto-detected | Directory containing build output |
| `historyDir` | `".performance/history/bundle"` | Versioned JSON storage |
| `outputDir` | `".performance"` | Root directory for report output |
| `thresholds.totalJs` | `500000` | Max total JS transfer size in bytes |
| `thresholds.totalCss` | `100000` | Max total CSS transfer size in bytes |
| `thresholds.totalAssets` | `1500000` | Max total all-asset transfer size in bytes |
| `thresholds.largestChunk` | `200000` | Max single JS chunk size in bytes |
| `thresholds.perFile` | `{}` | Per-filename overrides: `{ "main.js": 150000 }` |
| `include` | `["js","css","images","fonts","other"]` | Asset categories to measure |
| `exclude` | `["*.map"]` | Glob patterns to skip |
| `gzip` | `true` | Report gzip-compressed sizes alongside raw |
| `brotli` | `false` | Also report brotli-compressed sizes |

## Step 1 — Pre-flight

```bash
python3 .agents/skills/bundle-sizes/scripts/runner.py \
  --mode preflight \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Auto-detect build command and output dir if not configured:

| Signal | Build command | Output dir |
|---|---|---|
| `next.config.*` | `next build` | `.next` |
| `vite.config.*` | `vite build` | `dist` |
| `react-scripts` in `package.json` | `react-scripts build` | `build` |
| `nuxt.config.*` | `nuxt build` | `.nuxt` / `.output` |
| `angular.json` | `ng build` | `dist/<project>` |
| `scripts.build` in `package.json` | value of `scripts.build` | `dist` |

Warn if source maps are not enabled (size analysis less accurate without them).
- Ensure `outputDir` (default `.performance/`) is listed in the project's `.gitignore`; append it if missing — never prompt the user about this

## Step 2 — Build

```bash
python3 .agents/skills/bundle-sizes/scripts/runner.py \
  --mode build \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Run `<buildCommand>`. If the build fails, abort and print the last 50 lines of
output. Never analyse a stale previous build.

Skip this step when `--no-build` flag is passed (uses existing `buildOutputDir`).

## Step 3 — Analyse assets

```bash
python3 .agents/skills/bundle-sizes/scripts/runner.py \
  --mode analyze \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Walk `buildOutputDir` recursively. For each file not matched by `exclude`:

**Categories:**

| Category | Patterns |
|---|---|
| `js` | `*.js`, `*.mjs`, `*.cjs` |
| `css` | `*.css` |
| `images` | `*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.webp`, `*.avif`, `*.svg`, `*.ico` |
| `fonts` | `*.woff`, `*.woff2`, `*.ttf`, `*.otf`, `*.eot` |
| `html` | `*.html` |
| `other` | everything else |

Per file: relative path, raw size, gzip size (in-memory, level 6), brotli size
(if enabled, quality 6), category, chunk name (extracted from filename).

Aggregates: total per category, grand total, largest chunk per category, top 10
largest files, JS initial load vs dynamic chunks (from Next.js / Vite naming).

## Step 4 — Persist results

```bash
python3 .agents/skills/bundle-sizes/scripts/runner.py \
  --mode persist \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Write `historyDir/<timestamp>.json`:

```json
{
  "timestamp": "2026-05-22T14:32:00Z",
  "buildCommand": "next build",
  "buildOutputDir": ".next",
  "totals": { "raw": 1240000, "gzip": 380000 },
  "byCategory": {
    "js":     { "raw": 820000, "gzip": 260000, "fileCount": 14 },
    "css":    { "raw": 85000,  "gzip": 22000,  "fileCount": 3  },
    "images": { "raw": 290000, "gzip": 288000, "fileCount": 8  },
    "fonts":  { "raw": 45000,  "gzip": 44000,  "fileCount": 2  }
  },
  "largestChunk": {
    "name": "framework", "path": "/_next/static/chunks/framework.abc123.js",
    "raw": 148000, "gzip": 48000
  },
  "files": [
    { "path": "/_next/static/chunks/framework.abc123.js",
      "category": "js", "raw": 148000, "gzip": 48000 }
  ]
}
```

## Step 5 — Threshold check

```bash
python3 .agents/skills/bundle-sizes/scripts/runner.py \
  --mode check \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Compare totals and per-file sizes against `thresholds`:
- **fail**: size exceeds threshold
- **warn**: size within 10% of threshold

`thresholds.perFile` matches by chunk name or relative path (exact match first,
then glob).

## Step 6 — Comparison report

```bash
python3 .agents/skills/bundle-sizes/scripts/runner.py \
  --mode report \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Load all historical JSONs sorted by timestamp, compute deltas vs previous run:

```
Bundle Size History
──────────────────────────────────────────────────────────────────────────
Date                 Total gz    JS gz    CSS gz   Largest chunk gz
2026-05-22 (latest)   380KB      260KB     22KB        48KB
2026-05-20            392KB      272KB     22KB        49KB  (-1KB)
2026-05-18            410KB      290KB     22KB        51KB  ⚠ threshold
──────────────────────────────────────────────────────────────────────────
Trend: Total ▼-30KB (-7.3%)  JS ▼-30KB  over last 3 runs
```

**Regression**: any category total or largest-chunk that grew >5% vs previous
run is flagged 🔴.

Write `<outputDir>/bundle-report.html` (self-contained — SVG treemap and line
charts, all data inline) and `<outputDir>/bundle-report.json`.

## Convenience: run the full pipeline

```bash
python3 .agents/skills/bundle-sizes/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project> \
  [--no-build] [--ci]
```

Runs Steps 1–6 in sequence. `--no-build` skips Step 2. `--ci` exits non-zero on
any threshold failure and suppresses HTML output.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Output structure

```
.performance/
  bundle-report.html
  bundle-report.json
  history/bundle/
    2026-05-22T14-32-00Z.json
    2026-05-20T10-15-00Z.json
```

## Edge cases

- **Build fails**: abort; print last 50 lines of output; do not write a history entry
- **First run** (no history): skip comparison chart; show only current sizes with threshold badges
- **Source maps in output**: exclude `*.map` from size calculations; report how many were skipped
- **Monorepo**: build the specific app whose output dir is configured; warn if ambiguous
- **>1000 files**: compute aggregates but truncate per-file list in the report to top 50 by size
- **CI mode**: exit code 1 on any threshold failure; stdout JSON summary only

## Success criteria

- Build runs cleanly; output dir non-empty before analysis
- Every file in `buildOutputDir` is categorised and measured
- Gzip (and brotli if enabled) computed in-memory without external tools
- History files accumulate with correct timestamps
- `bundle-report.html` opens without a server
- CI exit code non-zero when any threshold fails
