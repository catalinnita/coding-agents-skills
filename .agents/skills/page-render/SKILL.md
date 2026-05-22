---
name: page-render
description: >
  Measures server-side rendering time and origin vs CDN request counts for
  configured URLs using HTTP timing and Playwright network interception,
  persists versioned JSON history, and produces a self-contained HTML report
  with render time and request count trends. Use when asked to measure page
  render time, check SSR performance, count origin requests, or show render
  time history.
compatibility: >
  Requires Python 3.10+, Node.js, and Playwright (installed automatically via
  PEP 723 inline metadata). Chromium browser installed via playwright install.
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Measure SSR render time and origin vs CDN request counts with time-series
history. Sends warmed-up HTTP requests to extract TTFB and `Server-Timing`,
uses Playwright to intercept and classify every subresource request, persists
versioned JSON, and produces a self-contained HTML comparison report. Reads all
configuration from the `pageRender` section of `performance.config.json`.

## Config (performance.config.json → `pageRender`)

| Key | Default | Description |
|---|---|---|
| `urls` | `["http://localhost:3000"]` | URLs to measure |
| `iterations` | `5` | Requests per URL (results averaged) |
| `warmupRequests` | `2` | Requests sent before measurement begins |
| `historyDir` | `".performance/history/render"` | Versioned JSON storage |
| `outputDir` | `".performance"` | Root directory for report output |
| `thresholds.renderTime` | `500` | Max SSR render time in ms |
| `thresholds.ttfb` | `200` | Max TTFB in ms |
| `thresholds.originRequests` | `10` | Max origin requests per page load |
| `thresholds.totalRequests` | `50` | Max total requests per page load |
| `headers` | `{}` | Extra request headers (auth tokens, feature flags) |
| `waitForSelector` | `null` | CSS selector to wait for before measuring hydration |
| `serveCommand` | `null` | Command to start the server if not already running |
| `port` | `3000` | Server port |

## Step 1 — Pre-flight

```bash
python3 .agents/skills/page-render/scripts/runner.py \
  --mode preflight \
  --config performance.config.json \
  --project-dir <path-to-project>
```

- If `serveCommand` is set: start the server, poll `http://localhost:<port>/`
  every 500ms until HTTP 2xx, timeout 120s
- Detect framework for render-time interpretation:

| Signal | How render time is read |
|---|---|
| `next.config.*` | `x-nextjs-cache` + `Server-Timing: app;dur=<N>` |
| `nuxt.config.*` | `Server-Timing: nuxt;dur=<N>` |
| Generic SSR | `Server-Timing` if present; else TTFB − 10ms (localhost baseline) |

- Verify Playwright + Chromium: `python3 -m playwright --version`; install if missing: `playwright install chromium`
- Confirm `historyDir` is writable; create if it doesn't exist
- Verify each URL responds with HTTP 2xx; warn and continue for unreachable URLs

## Step 2 — Warm up the server

```bash
python3 .agents/skills/page-render/scripts/runner.py \
  --mode warmup \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Send `warmupRequests` sequential HTTP GETs to each URL with configured headers.
Discard all results. This primes in-process caches (React cache, Next.js fetch
cache, DB connection pools) so measurements reflect steady-state, not cold-start.

## Step 3 — Measure render time and request counts

```bash
python3 .agents/skills/page-render/scripts/runner.py \
  --mode measure \
  --config performance.config.json \
  --project-dir <path-to-project>
```

For each URL, repeat `iterations` times:

**Render time (HTTP timing):**
```
1. T0 = now()
2. HTTP GET <url> with configured headers
3. TTFB = time to first byte
4. Parse Server-Timing header:
     "app;dur=<N>"  → renderTime = N ms
     not present    → renderTime = TTFB − 10ms
5. Record: TTFB, renderTime, HTTP status, response Content-Length
```

**Request counts (Playwright):**
```
1. Launch headless Chromium
2. Inject headers; navigate to <url>; wait for networkidle
3. If waitForSelector set: wait for element
4. Intercept all requests via page.on('request') + page.on('response')
5. Classify each response:
   - origin hit:  no Cache-Control / age=0 / x-cache: MISS / cf-cache-status: MISS
   - CDN hit:     x-cache: HIT / cf-cache-status: HIT / age > 0
   - static:      same-origin JS/CSS/images with long max-age and no origin markers
6. Count: totalRequests, originRequests, cdnRequests, staticRequests
```

Average across iterations: `renderTime`, `ttfb`, `responseSize`,
`originRequests`, `cdnRequests`, `totalRequests`.
Keep worst-case (slowest `renderTime`, highest `originRequests`) separately.

## Step 4 — Persist results

```bash
python3 .agents/skills/page-render/scripts/runner.py \
  --mode persist \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Write `historyDir/<url-slug>/<timestamp>.json`:

```json
{
  "url": "http://localhost:3000/checkout",
  "timestamp": "2026-05-22T14:32:00Z",
  "iterations": 5,
  "warmupRequests": 2,
  "averaged": {
    "renderTime": 148, "ttfb": 158, "responseSize": 28400,
    "originRequests": 3, "cdnRequests": 18, "totalRequests": 21
  },
  "worstCase": {
    "renderTime": 210, "ttfb": 220,
    "originRequests": 5, "totalRequests": 24
  },
  "framework": "nextjs",
  "serverTimingPresent": true
}
```

## Step 5 — Threshold check

```bash
python3 .agents/skills/page-render/scripts/runner.py \
  --mode check \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Compare averaged metrics against `thresholds`:
- **fail**: metric exceeds threshold
- **warn**: metric within 10% of threshold

Report worst-case values alongside averages so outliers are visible.

## Step 6 — Comparison report

```bash
python3 .agents/skills/page-render/scripts/runner.py \
  --mode report \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Load all historical JSONs from `historyDir`, sort newest-first:

```
URL: http://localhost:3000/checkout
──────────────────────────────────────────────────────────────────────
Date                  Render time  TTFB   Origin reqs  Total reqs
2026-05-22 (latest)      148ms    158ms       3            21
2026-05-20               162ms    172ms       3            21
2026-05-18               240ms    250ms       7            28   🔴
──────────────────────────────────────────────────────────────────────
Trend: Render ▼improved  Origin reqs ▼-4 since worst run
```

**Regression**: any metric worsening >10% vs previous run flagged 🔴. Improvements flagged ▲.

Write `<outputDir>/render-report.html` (self-contained — SVG line charts and
request breakdown pie chart, all data inline) and `<outputDir>/render-report.json`.

## Step 7 — Teardown

```bash
python3 .agents/skills/page-render/scripts/runner.py \
  --mode teardown \
  --project-dir <path-to-project>
```

If `serveCommand` was started in Step 1, stop the server process (SIGTERM, then
SIGKILL after 5s). Teardown runs automatically at the end of `--mode run` and
on SIGINT/SIGTERM during any mode.

## Convenience: run the full pipeline

```bash
python3 .agents/skills/page-render/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project> \
  [--ci]
```

Runs Steps 1–7 in sequence. Teardown is guaranteed via `try/finally`. `--ci`
exits non-zero on any threshold failure and suppresses HTML output.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Output structure

```
.performance/
  render-report.html
  render-report.json
  history/render/
    <url-slug>/
      2026-05-22T14-32-00Z.json
      2026-05-20T10-15-00Z.json
```

## Edge cases

- **URL unreachable and no `serveCommand`**: abort with a clear error; suggest configuring `serveCommand`
- **Server startup timeout (120s)**: abort; print last 50 lines of server stderr; run teardown
- **No `Server-Timing` header**: fall back to TTFB − 10ms; note in report that render time is estimated
- **HTTPS with self-signed cert**: launch Playwright with `--ignore-certificate-errors`
- **Authenticated pages**: inject credentials via `headers`; support `cookies` array for cookie-based auth
- **CDN header variants**: detect by checking `x-cache`, `cf-cache-status`, `x-amz-cf-id`, `fastly-restarts`, `age`; classify as CDN-served if any match
- **First run** (no history): skip comparison chart; show only current results with threshold badges
- **Flaky results** (σ > 20% of mean): flag result as unstable in the report
- **CI mode**: exit code 1 on any threshold failure; stdout JSON summary only

## Success criteria

- Render time and TTFB measured for every URL across all iterations
- Origin vs CDN request counts correctly classified
- Warmup requests sent before measurement and excluded from results
- History files accumulate with correct timestamps and URL slugs
- `render-report.html` opens without a server
- Server started by `serveCommand` cleanly stopped after measurement, even on error
- CI exit code non-zero when any threshold fails
