---
name: lighthouse-tests
description: >
  Runs Lighthouse CLI audits against configured URLs, averages results across
  multiple iterations, persists versioned JSON history, and produces a
  self-contained HTML comparison report covering Core Web Vitals, asset sizes,
  and score trends over time. Use when asked to run lighthouse tests, check core
  web vitals, check performance scores, or show lighthouse history.
compatibility: >
  Requires Python 3.10+, Node.js, and the Lighthouse CLI (installed
  automatically if missing). Requires Chrome or Chromium on PATH or via
  CHROME_PATH.
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Run Lighthouse audits, persist versioned JSON results, and produce time-series
HTML comparison reports. Reads all configuration from the `lighthouse` section
of `performance.config.json`.

## Config (performance.config.json → `lighthouse`)

| Key | Default | Description |
|---|---|---|
| `urls` | `["http://localhost:3000"]` | URLs to audit |
| `viewport.width` | `1440` | Viewport width in px |
| `viewport.height` | `900` | Viewport height in px |
| `viewport.mobile` | `false` | Emulate mobile device |
| `throttling` | `"simulated3G"` | `"simulated3G"` \| `"none"` \| `"devtools"` |
| `categories` | `["performance"]` | Lighthouse categories to run |
| `iterations` | `3` | Runs per URL (results averaged) |
| `historyDir` | `".performance/history/lighthouse"` | Versioned JSON storage |
| `thresholds.performance` | `90` | Min overall score (0–100) |
| `thresholds.lcp` | `2500` | Max LCP in ms |
| `thresholds.fcp` | `1800` | Max FCP in ms |
| `thresholds.ttfb` | `800` | Max TTFB in ms |
| `thresholds.cls` | `0.1` | Max CLS score |
| `thresholds.fid` | `100` | Max FID in ms |
| `thresholds.inp` | `200` | Max INP in ms |
| `extraFlags` | `[]` | Additional raw Lighthouse CLI flags |
| `outputDir` | `".performance"` | Root directory for report output |

## Step 1 — Pre-flight

```bash
python3 .agents/skills/lighthouse-tests/scripts/runner.py \
  --mode preflight \
  --config performance.config.json \
  --project-dir <path-to-project>
```

- Confirm Lighthouse CLI: `npx lighthouse --version`; if missing, install: `npm install -g lighthouse`
- Confirm Chrome: try `CHROME_PATH`, then `google-chrome`, `chromium`, `chromium-browser`; fail with a helpful message if none found
- For each URL: verify HTTP 2xx response; warn and continue for unreachable URLs
- Create `historyDir` if it doesn't exist
- Ensure `outputDir` (default `.performance/`) is listed in the project's `.gitignore`; append it if missing — never prompt the user about this

## Step 2 — Run audits

```bash
python3 .agents/skills/lighthouse-tests/scripts/runner.py \
  --mode audit \
  --config performance.config.json \
  --project-dir <path-to-project>
```

For each URL × `iterations`, run:

```bash
lighthouse <url> \
  --output json \
  --output-path stdout \
  --chrome-flags="--headless --no-sandbox" \
  --emulated-form-factor=<desktop|mobile> \
  --throttling-method=<simulate|devtools|provided> \
  --only-categories=<categories> \
  <extraFlags>
```

Average these metrics across iterations: `score`, `lcp`, `fcp`, `ttfb`, `cls`,
`fid`, `inp`, `speedIndex`, `totalBlockingTime`, `totalTransferSize`,
`totalJsSize`, `totalCssSize`, `unusedJsBytes`, `unusedCssBytes`, `requestCount`.

Keep the worst-case values as a separate entry for regression detection.

## Step 3 — Persist results

```bash
python3 .agents/skills/lighthouse-tests/scripts/runner.py \
  --mode persist \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Write one JSON file per URL per run under `historyDir/<url-slug>/<timestamp>.json`.
Also save raw per-iteration outputs to `<timestamp>.raw/run-<n>.json`.

**URL slug**: replace `://`, `/`, `.`, `:` with `-`; strip leading `-`.

Persisted JSON shape:

```json
{
  "url": "http://localhost:3000/checkout",
  "timestamp": "2026-05-22T14:32:00Z",
  "lighthouseVersion": "11.4.0",
  "iterations": 3,
  "metrics": {
    "score": 94, "lcp": 1820, "fcp": 980, "ttfb": 210,
    "cls": 0.03, "fid": 12, "inp": 88,
    "speedIndex": 1540, "totalBlockingTime": 120
  },
  "assets": {
    "totalTransferSize": 412000, "totalJsSize": 280000,
    "totalCssSize": 42000, "unusedJsBytes": 54000,
    "unusedCssBytes": 11000, "requestCount": 24
  }
}
```

## Step 4 — Threshold check

```bash
python3 .agents/skills/lighthouse-tests/scripts/runner.py \
  --mode check \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Compare averaged metrics against `thresholds`. Produce:
- **fail**: metric exceeds threshold
- **warn**: metric is within 10% of threshold

## Step 5 — Comparison report

```bash
python3 .agents/skills/lighthouse-tests/scripts/runner.py \
  --mode report \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Load all historical JSONs from `historyDir`, sort newest-first. For each URL:

```
URL: http://localhost:3000/checkout
──────────────────────────────────────────────────────────────────────
Date                  Score  LCP    FCP    TTFB   CLS   TBT   JS gz
2026-05-22 (latest)    94   1.82s  0.98s  210ms  0.03  120ms  260KB
2026-05-20             91   2.10s  1.12s  240ms  0.05  180ms  274KB
2026-05-18             88   2.44s  1.28s  310ms  0.07  240ms  290KB  ⚠
──────────────────────────────────────────────────────────────────────
Trend: Score ▲+6  LCP ▲improved  JS ▼-30KB
```

**Regression detection**: flag any metric that worsened by >10% vs the previous
run as a regression (🔴). Flag improvements with ▲.

Write `<outputDir>/lighthouse-report.html` (self-contained, no external deps —
all charts SVG, all data inline) and `<outputDir>/lighthouse-report.json`.

## Convenience: run the full pipeline

```bash
python3 .agents/skills/lighthouse-tests/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Runs Steps 1–5 in sequence. Add `--ci` to exit non-zero on any threshold failure
and suppress HTML output.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Output structure

```
.performance/
  lighthouse-report.html
  lighthouse-report.json
  history/lighthouse/
    <url-slug>/
      2026-05-22T14-32-00Z.json
      2026-05-22T14-32-00Z.raw/
        run-1.json  run-2.json  run-3.json
```

## Edge cases

- **URL unreachable**: warn and skip; do not abort the full run
- **First run** (no history): skip comparison chart; show only current results with threshold badges
- **Chrome not found**: fail with a message listing all locations tried
- **Flaky metric** (σ > 20% of mean across iterations): flag result as unstable in the report
- **Authenticated pages**: support `cookies` / `extraHeaders` array in config
- **CI mode**: exit code 1 on any threshold failure; stdout JSON summary only

## Success criteria

- Lighthouse runs for every configured URL
- Results persisted as versioned JSON with correct timestamp slugs
- Comparison report covers all available history runs
- Regressions are visually distinct (🔴) in the report
- `lighthouse-report.html` opens without a server
- CI exit code non-zero when any threshold fails
