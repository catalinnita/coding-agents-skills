# Skill Spec: Bundle Sizes

## Goal

Build the project, analyse the output bundle — JavaScript chunks, CSS files,
images, and other assets — save the results as versioned JSON, and produce
comparison reports over time so size regressions are caught before they reach
production.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "analyse bundle sizes"
- "check bundle size"
- "compare bundle sizes"
- "how big is the bundle"
- "check for size regressions"
- "show bundle size history / trends"

Also invoked by the **performance agent** as Phase 2.

---

## Inputs

Read from `performance.config.json` at the project root. All keys are under
`bundleSizes`. CLI flags override config values.

| Config key | Default | Description |
|---|---|---|
| `buildCommand` | auto-detected | Command to build the project |
| `buildOutputDir` | auto-detected | Directory containing build output (`dist`, `.next`, `out`, etc.) |
| `historyDir` | `".performance/history/bundle"` | Where to store versioned JSON results |
| `outputDir` | `".performance"` | Root output directory for reports |
| `thresholds.totalJs` | `500000` | Max total JS transfer size in bytes |
| `thresholds.totalCss` | `100000` | Max total CSS transfer size in bytes |
| `thresholds.totalAssets` | `1500000` | Max total all-asset transfer size in bytes |
| `thresholds.largestChunk` | `200000` | Max size of any single JS chunk in bytes |
| `thresholds.perFile` | `{}` | Per-filename overrides: `{ "main.js": 150000 }` |
| `include` | `["js", "css", "images", "fonts", "other"]` | Asset categories to measure |
| `exclude` | `[]` | Glob patterns to skip (e.g. `["*.map"]`) |
| `gzip` | `true` | Report gzip-compressed sizes alongside raw sizes |
| `brotli` | `false` | Also report brotli-compressed sizes |

---

## Behavior

### Step 1 — Pre-flight checks

- Detect build command if not configured:

| Signal | Build command | Output dir |
|---|---|---|
| `next.config.*` | `next build` | `.next` |
| `vite.config.*` | `vite build` | `dist` |
| `react-scripts` in `package.json` | `react-scripts build` | `build` |
| `nuxt.config.*` | `nuxt build` | `.nuxt` / `.output` |
| `angular.json` | `ng build` | `dist/<project>` |
| `scripts.build` in `package.json` | value of `scripts.build` | `dist` |

- Confirm the build output directory is writable
- Warn if the project does not have source maps enabled (size analysis is less accurate without them)

### Step 2 — Build the project

Run the detected or configured build command:

```bash
<buildCommand>
```

Capture stdout/stderr. If the build fails, abort and print the last 50 lines of
output with a clear error message. Do not analyse a stale previous build.

### Step 3 — Analyse output assets

Walk `buildOutputDir` recursively, collect every file, categorise and measure:

**Categories:**

| Category | File patterns |
|---|---|
| `js` | `*.js`, `*.mjs`, `*.cjs` (excluding `*.map`) |
| `css` | `*.css` |
| `images` | `*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.webp`, `*.avif`, `*.svg`, `*.ico` |
| `fonts` | `*.woff`, `*.woff2`, `*.ttf`, `*.otf`, `*.eot` |
| `html` | `*.html` |
| `other` | everything else not excluded |

**Per file, record:**
- Relative path from `buildOutputDir`
- Raw size in bytes
- Gzip size (if `gzip: true`): compress in-memory with level 6
- Brotli size (if `brotli: true`): compress in-memory with quality 6
- Category
- Chunk name (extracted from filename patterns like `page-about.abc123.js` → `page-about`)

**Aggregates computed:**
- Total per category (raw + compressed)
- Grand total (raw + compressed)
- Largest single chunk per category
- Top 10 largest files overall
- JS split: initial load vs dynamically imported chunks (detected from Next.js / Vite chunk naming patterns)

### Step 4 — Persist results

Write one JSON file per run:

```
.performance/history/bundle/
  2026-05-22T14-32-00Z.json
```

Shape:

```json
{
  "timestamp": "2026-05-22T14:32:00Z",
  "buildCommand": "next build",
  "buildOutputDir": ".next",
  "totals": {
    "raw": 1240000,
    "gzip": 380000
  },
  "byCategory": {
    "js": { "raw": 820000, "gzip": 260000, "fileCount": 14 },
    "css": { "raw": 85000, "gzip": 22000, "fileCount": 3 },
    "images": { "raw": 290000, "gzip": 288000, "fileCount": 8 },
    "fonts": { "raw": 45000, "gzip": 44000, "fileCount": 2 }
  },
  "largestChunk": {
    "name": "framework",
    "path": "/_next/static/chunks/framework.abc123.js",
    "raw": 148000,
    "gzip": 48000
  },
  "files": [
    { "path": "/_next/static/chunks/framework.abc123.js", "category": "js", "raw": 148000, "gzip": 48000 },
    ...
  ]
}
```

### Step 5 — Threshold check

Compare totals and per-file sizes against `thresholds`. Produce a **fail** entry
for any size exceeding its threshold, a **warn** for within 10% of the threshold.

Per-file overrides in `thresholds.perFile` match against the chunk name or
relative file path (exact match first, then glob).

### Step 6 — Comparison report

Load all historical JSON files from `historyDir` sorted by timestamp. For each
run, compute the delta from the previous run.

```
Bundle Size History
────────────────────────────────────────────────────────────────────────────
Date                 Total (gz)    JS (gz)    CSS (gz)   Largest chunk (gz)
2026-05-22 (latest)    380KB        260KB       22KB        48KB
2026-05-20             392KB        272KB       22KB        49KB  (-1KB)
2026-05-18             410KB        290KB       22KB        51KB  ⚠ exceeded threshold
────────────────────────────────────────────────────────────────────────────
Trend: Total ▼-30KB (-7.3%)  JS ▼-30KB  over last 3 runs
```

**Regression detection**: flag any category total or largest-chunk size that
grew by more than 5% compared to the previous run as a regression (🔴).

### Step 7 — Generate HTML report

Write `<outputDir>/bundle-report.html` — self-contained HTML:

- Summary table: current sizes vs thresholds, pass/warn/fail badges
- Treemap visualisation of the bundle (SVG, no external dependencies): rectangles proportional to file size, colour-coded by category
- Size history chart (SVG line chart) per category
- Top 10 largest files table with delta from previous run
- Regression banner at the top if any category grew by more than 5%

Also write `<outputDir>/bundle-report.json` with the machine-readable data.

---

## Output structure

```
.performance/
  bundle-report.html        ← open this
  bundle-report.json
  history/
    bundle/
      2026-05-22T14-32-00Z.json
      2026-05-20T10-15-00Z.json
```

---

## Edge cases

- **Build fails**: abort; print last 50 lines of build output; do not write a history entry for a failed build
- **First run** (no history): skip comparison chart; show only current sizes with threshold badges
- **Source maps included in output**: exclude `*.map` files from size calculations; note how many map files were skipped
- **Framework output with nested dirs** (Next.js `.next/static`): walk the full tree; preserve relative paths from `buildOutputDir`
- **Monorepo**: if multiple `package.json` files exist, build the specific app whose output dir is configured; warn if `buildOutputDir` is ambiguous
- **Large number of files** (>1000): compute aggregates but truncate the per-file list in the report to the top 50 by size
- **CI mode** (`--ci` flag): exit code 1 if any threshold fails; stdout JSON summary only

---

## Success criteria

- Build runs cleanly and output dir is non-empty before analysis starts
- Every file in `buildOutputDir` is categorised and measured
- Gzip and brotli sizes are computed in-memory (no external tools required)
- Historical JSON files accumulate with correct timestamps
- Comparison report shows deltas and trend direction for all categories
- `bundle-report.html` is self-contained and opens without a server
- Exit code is non-zero in CI mode when any threshold fails
