# Skill Spec: Page Render

## Goal

Measure server-side rendering time and origin request counts for each
configured URL, save the results as versioned JSON, and produce comparison
reports over time so SSR regressions are caught before they reach production.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "measure page render time"
- "check SSR performance"
- "how fast does the server render X"
- "how many origin requests does this page make"
- "compare render times"
- "show render time history"

Also invoked by the **performance agent** as Phase 3.

---

## Inputs

Read from `performance.config.json` at the project root. All keys are under
`pageRender`. CLI flags override config values.

| Config key | Default | Description |
|---|---|---|
| `urls` | `["http://localhost:3000"]` | URLs to measure |
| `iterations` | `5` | Number of requests per URL (results are averaged) |
| `historyDir` | `".performance/history/render"` | Where to store versioned JSON results |
| `outputDir` | `".performance"` | Root output directory for reports |
| `thresholds.renderTime` | `500` | Max server render time in ms (TTFB minus network overhead) |
| `thresholds.ttfb` | `200` | Max Time to First Byte in ms |
| `thresholds.originRequests` | `10` | Max number of requests that hit the origin per page load |
| `thresholds.totalRequests` | `50` | Max total requests (including CDN-cached) per page load |
| `headers` | `{}` | Extra request headers (e.g. auth tokens, feature flags) |
| `waitForSelector` | `null` | CSS selector to wait for before measuring client-side hydration (optional) |
| `serveCommand` | `null` | Command to start the server before measuring (if not already running) |
| `port` | `3000` | Port the server listens on |
| `warmupRequests` | `2` | Number of requests sent before measurement begins (warms server caches) |

---

## Behavior

### Step 1 — Pre-flight checks

- If `serveCommand` is set, start the server and poll `http://localhost:<port>/` until it responds (500ms interval, 120s timeout)
- For each URL, verify it responds with HTTP 2xx; warn and continue for unreachable URLs
- Confirm `historyDir` is writable; create it if it doesn't exist
- Detect the framework to determine how to interpret render time:

| Signal | How render time is measured |
|---|---|
| `next.config.*` | `x-nextjs-cache` response header; `Server-Timing` header if present |
| `nuxt.config.*` | `Server-Timing` header |
| Generic SSR | TTFB minus an estimated network round-trip baseline (10ms for localhost) |

### Step 2 — Warm up the server

Send `warmupRequests` requests to each URL sequentially and discard the results.
This primes in-process caches (React cache, Next.js fetch cache, DB connection
pools) so measurement reflects steady-state performance, not cold-start.

### Step 3 — Measure render time and request counts

For each URL, run `iterations` measurements. Per measurement:

**Render time (server-side):**
```
1. Record timestamp T0
2. HTTP GET <url> with configured headers
3. Record TTFB (time from request start to first byte received)
4. Extract Server-Timing header if present:
   - "app;dur=<N>" → render time = N ms
   - Fall back to: renderTime = TTFB - 10ms (localhost network overhead)
5. Record HTTP status, response size (Content-Length or measured)
```

**Request counts (origin vs CDN):**
```
1. Use Playwright in headless mode to load the full page (including subresources)
2. Intercept all network requests via page.on('request')
3. Classify each request:
   - origin hit: no Cache-Control / no CDN headers / cache-miss headers (x-cache: MISS, cf-cache-status: MISS, etc.)
   - CDN hit:    x-cache: HIT, cf-cache-status: HIT, age > 0, etc.
   - static:     same-origin requests for JS/CSS/images served with long max-age
4. Record: totalRequests, originRequests, cdnRequests, staticRequests
```

Average numeric metrics across `iterations`:
- `renderTime`, `ttfb`, `responseSize`, `originRequests`, `cdnRequests`, `totalRequests`

Keep the worst-case (slowest `renderTime`, highest `originRequests`) as a separate entry.

### Step 4 — Persist results

Write one JSON file per URL per run:

```
.performance/history/render/
  <url-slug>/
    2026-05-22T14-32-00Z.json
```

Shape:

```json
{
  "url": "http://localhost:3000/checkout",
  "timestamp": "2026-05-22T14:32:00Z",
  "iterations": 5,
  "warmupRequests": 2,
  "averaged": {
    "renderTime": 148,
    "ttfb": 158,
    "responseSize": 28400,
    "originRequests": 3,
    "cdnRequests": 18,
    "totalRequests": 21
  },
  "worstCase": {
    "renderTime": 210,
    "ttfb": 220,
    "originRequests": 5,
    "totalRequests": 24
  },
  "framework": "nextjs",
  "serverTimingPresent": true
}
```

### Step 5 — Threshold check

Compare averaged metrics against `thresholds`. Produce a **fail** for any
metric exceeding its threshold, a **warn** for within 10% of the threshold.

Report the worst-case values alongside the averages so outliers are visible.

### Step 6 — Comparison report

Load historical JSON files from `historyDir`, sorted by timestamp newest-first.
For each URL, show metrics across all saved runs:

```
URL: http://localhost:3000/checkout
────────────────────────────────────────────────────────────────────────
Date                  Render time  TTFB   Origin reqs  Total reqs
2026-05-22 (latest)      148ms    158ms       3            21
2026-05-20               162ms    172ms       3            21   (+1ms)
2026-05-18               240ms    250ms       7            28   🔴 regressed
────────────────────────────────────────────────────────────────────────
Trend: Render ▼improved  Origin requests ▼-4 since worst run
```

**Regression detection**: flag any metric that worsened by more than 10% compared
to the previous run (🔴). Flag improvements with ▲.

### Step 7 — Generate HTML report

Write `<outputDir>/render-report.html` — self-contained HTML:

- Summary table: all URLs, averaged metrics, worst-case metrics, pass/warn/fail badges per threshold
- Per-URL section: render time and request count time-series charts (SVG)
- Request breakdown pie chart: origin vs CDN vs static (SVG, no external dependencies)
- Regression banner at the top if any metric regressed since the previous run

Also write `<outputDir>/render-report.json` with the machine-readable data.

### Step 8 — Teardown

If `serveCommand` was started in Step 1, stop the server process.

---

## Output structure

```
.performance/
  render-report.html        ← open this
  render-report.json
  history/
    render/
      <url-slug>/
        2026-05-22T14-32-00Z.json
        2026-05-20T10-15-00Z.json
```

---

## Edge cases

- **Server not running and no `serveCommand`**: if the URL is unreachable and no `serveCommand` is configured, abort with a clear error message listing the URL and suggesting how to configure `serveCommand`
- **Server startup timeout (120s)**: abort; print the last 50 lines of server stderr
- **No `Server-Timing` header**: fall back to TTFB minus 10ms baseline; note in the report that the render time is estimated
- **HTTPS with self-signed cert**: launch Playwright with `--ignore-certificate-errors`
- **Authenticated pages**: inject credentials via the `headers` config key; for cookie-based auth, also support a `cookies` array
- **CDN headers vary by provider**: detect by checking multiple known CDN header patterns (`x-cache`, `cf-cache-status`, `x-amz-cf-id`, `fastly-restarts`, etc.); classify as CDN-served if any match
- **First run** (no history): skip comparison chart; show only current results with threshold badges
- **Flaky results** (standard deviation > 20% of mean): flag the result as unstable in the report
- **CI mode** (`--ci` flag): exit code 1 if any threshold fails; stdout JSON summary only

---

## Success criteria

- Render time and TTFB are measured for every configured URL across all iterations
- Origin vs CDN request counts are correctly classified
- Warmup requests are sent before measurement and excluded from results
- Historical JSON files accumulate with correct timestamps and URL slugs
- Comparison report shows time-series data for all available history
- Regressions are visually distinct in the report
- `render-report.html` is self-contained and opens without a server
- Server started by `serveCommand` is cleanly stopped after measurement
