# Skill Spec: Lighthouse Tests

## Goal

Run Lighthouse audits against one or more URLs using the Lighthouse CLI, save
results as versioned JSON files, and produce comparison reports over time that
surface regressions in Core Web Vitals, asset sizes, and other key metrics.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "run lighthouse tests"
- "run a lighthouse audit"
- "check core web vitals"
- "compare lighthouse results"
- "check performance scores"
- "show lighthouse history / trends"

Also invoked by the **performance agent** as Phase 1.

---

## Inputs

Read from `performance.config.json` at the project root. All keys are under
`lighthouse`. CLI flags override config values.

| Config key | Default | Description |
|---|---|---|
| `urls` | `["http://localhost:3000"]` | URLs to audit |
| `viewport.width` | `1440` | Viewport width in px |
| `viewport.height` | `900` | Viewport height in px |
| `viewport.mobile` | `false` | Emulate mobile device |
| `throttling` | `"simulated3G"` | `"simulated3G"` \| `"none"` \| `"devtools"` |
| `categories` | `["performance"]` | Lighthouse categories to run |
| `iterations` | `3` | Number of runs per URL (results are averaged) |
| `historyDir` | `".performance/history/lighthouse"` | Where to store versioned JSON results |
| `thresholds.performance` | `90` | Min overall performance score (0–100) |
| `thresholds.lcp` | `2500` | Max Largest Contentful Paint in ms |
| `thresholds.fid` | `100` | Max First Input Delay in ms |
| `thresholds.cls` | `0.1` | Max Cumulative Layout Shift score |
| `thresholds.fcp` | `1800` | Max First Contentful Paint in ms |
| `thresholds.ttfb` | `800` | Max Time to First Byte in ms |
| `thresholds.inp` | `200` | Max Interaction to Next Paint in ms |
| `extraFlags` | `[]` | Additional raw flags passed to the Lighthouse CLI |
| `outputDir` | `".performance"` | Root output directory for reports |

---

## Behavior

### Step 1 — Pre-flight checks

- Confirm Lighthouse CLI is installed: `npx lighthouse --version`; install if missing: `npm install -g lighthouse`
- Confirm Chrome / Chromium is available on PATH or via `CHROME_PATH`
- For each URL, verify it responds with HTTP 2xx; warn and continue for unreachable URLs
- Confirm `historyDir` is writable; create it if it doesn't exist

### Step 2 — Run Lighthouse audits

For each URL × iteration, run:

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

- Run `iterations` times per URL; record each result individually
- Average numeric metrics across iterations: `lcp`, `fcp`, `ttfb`, `cls`, `fid`, `inp`, overall score, `totalByteWeight`, `unusedJsBytes`, `unusedCssBytes`
- Keep the worst-case result as a separate entry for regression detection

### Step 3 — Persist results

Write one JSON file per URL per run:

```
.performance/history/lighthouse/
  <url-slug>/
    2026-05-22T14-32-00Z.json    ← averaged metrics for this run
    2026-05-22T14-32-00Z.raw/   ← one file per iteration (full Lighthouse output)
      run-1.json
      run-2.json
      run-3.json
```

**URL slug**: replace `://`, `/`, `.`, `:` with `-`; strip leading `-`.
`http://localhost:3000/checkout` → `localhost-3000-checkout`

Each persisted JSON has this shape:

```json
{
  "url": "http://localhost:3000/checkout",
  "timestamp": "2026-05-22T14:32:00Z",
  "lighthouse_version": "11.4.0",
  "iterations": 3,
  "metrics": {
    "score": 94,
    "lcp": 1820,
    "fcp": 980,
    "ttfb": 210,
    "cls": 0.03,
    "fid": 12,
    "inp": 88,
    "speedIndex": 1540,
    "totalBlockingTime": 120
  },
  "assets": {
    "totalTransferSize": 412000,
    "totalJsSize": 280000,
    "totalCssSize": 42000,
    "imageSize": 68000,
    "unusedJsBytes": 54000,
    "unusedCssBytes": 11000,
    "requestCount": 24
  }
}
```

### Step 4 — Threshold check

Compare averaged metrics against `thresholds` from config. For each metric that
fails a threshold, produce a **fail** entry; for metrics within 10% of their
threshold, produce a **warn** entry.

### Step 5 — Comparison report

Load historical JSON files from `historyDir` and build a time-series report.

For each URL, show metrics across all saved runs sorted newest-first:

```
URL: http://localhost:3000/checkout
────────────────────────────────────────────────────────────────────────
Date                  Score  LCP    FCP    TTFB  CLS   TBT   JS (total)
2026-05-22  (latest)    94  1.82s  0.98s  210ms  0.03  120ms   280KB
2026-05-20              91  2.10s  1.12s  240ms  0.05  180ms   294KB
2026-05-18              88  2.44s  1.28s  310ms  0.07  240ms   310KB  ⚠ below threshold
────────────────────────────────────────────────────────────────────────
Trend:  Score ▲+6  LCP ▲improved  JS ▼-30KB
```

**Regression detection**: flag any metric that worsened by more than 10% compared
to the previous run as a regression (🔴). Flag improvements with ▲.

### Step 6 — Generate HTML report

Write `<outputDir>/lighthouse-report.html` — self-contained HTML:

- Summary table: all URLs, current scores, pass/warn/fail badges per threshold
- Per-URL section: metric time-series chart (SVG, no external dependencies), asset breakdown, top opportunities from the latest Lighthouse run
- Regression banner at the top if any metric regressed since the previous run

Also write `<outputDir>/lighthouse-report.json` with the machine-readable comparison data.

---

## Output structure

```
.performance/
  lighthouse-report.html        ← open this
  lighthouse-report.json
  history/
    lighthouse/
      <url-slug>/
        <timestamp>.json
        <timestamp>.raw/
          run-1.json  run-2.json  run-3.json
```

---

## Edge cases

- **URL unreachable**: log a warning and skip that URL; do not abort the full run
- **First run** (no history): skip the comparison chart; show only current results with threshold badges
- **Chrome not found**: try `CHROME_PATH`, then `google-chrome`, `chromium`, `chromium-browser` in order; fail with a helpful message if none found
- **Flaky metric across iterations**: if the standard deviation of a metric across iterations exceeds 20% of the mean, flag the result as unstable and note it in the report
- **Authenticated pages**: support a `cookies` or `extraHeaders` array in config to inject session credentials before auditing
- **CI mode** (`--ci` flag): exit with code 1 if any threshold is failed; stdout only contains the JSON summary

---

## Success criteria

- Lighthouse runs for every configured URL
- Results are persisted as versioned JSON with correct timestamp slugs
- Comparison report shows time-series data for all available history
- Regressions are visually distinct in the report
- `lighthouse-report.html` is self-contained and opens without a server
- Exit code is non-zero in CI mode when any threshold fails
