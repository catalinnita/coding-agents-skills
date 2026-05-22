---
name: visual-regression
description: >
  Captures screenshots of the current branch and the main/master branch using
  git worktrees, compares them pixel-by-pixel and perceptually (SSIM), and
  produces a self-contained HTML diff report. Use when asked to run visual
  regression, check for visual regressions, compare screenshots with main, or
  visual diff a branch.
compatibility: >
  Requires Python 3.10+, Node.js, and Playwright (installed automatically via
  PEP 723 inline metadata). The target project must be a git repository with a
  build/serve command that can run in a cloned worktree.
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Run a full visual regression pipeline: start both servers (baseline from
`main`/`master` via git worktree, candidate from the current branch), capture
screenshots at multiple viewports, compare pixel-by-pixel and via SSIM, and
write a self-contained HTML report.

## Inputs

| Input | Required | Description |
|---|---|---|
| `routes` | No | URL paths to test. Default: auto-discovered (sitemap → framework routes → link crawl → `/`) |
| `base` | No | Branch or commit to compare against. Default: `main`, fallback `master` |
| `threshold` | No | Max acceptable diff ratio 0–1. Default: `0.01` |
| `viewports` | No | Array of `{width, height, label}`. Default: mobile 375×812, tablet 768×1024, desktop 1440×900 |
| `buildCommand` | No | Build command. Default: auto-detected from project type |
| `serveCommand` | No | Serve command. Default: auto-detected from project type |
| `port` | No | Candidate server port. Default: `3000` |
| `basePort` | No | Baseline server port. Default: `3001` |
| `outputDir` | No | Output directory. Default: `.visual-regression/` |
| `auth` | No | Auth config (cookie / login-form / bearer) |
| `ignore` | No | CSS selectors or regions to mask before comparison |
| `waitFor` | No | Selector or ms delay to wait before each screenshot |
| `fullPage` | No | Capture full scrollable height. Default: `true` |
| `animations` | No | `disable` (default) or `allow` |
| `parallel` | No | Max concurrent screenshot workers. Default: `4` |
| `dryRun` | No | Print plan only, capture nothing. Default: `false` |

## Step 1 — Resolve config and pre-flight checks

Look for config in this order:
1. Explicit `--config` flag
2. `.visual-regression.config.json` in project root
3. Built-in defaults

Run pre-flight checks before doing anything else:

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --config <config-path> \
  --mode preflight \
  --project-dir <path-to-project>
```

Checks performed:
- Working directory is a git repository
- Uncommitted changes present → warn user and ask for confirmation
- Base branch/commit exists (`git rev-parse --verify <base>`)
- `port` and `basePort` are free; auto-increment by 1 if busy, report actual ports
- `playwright` is available (`python3 -m playwright --version`); if not, install: `playwright install chromium`
- `node` is available on PATH
- If multiple `package.json` files detected (monorepo) → ask user which app to test

Exits non-zero with an informative message on any unrecoverable check failure.

## Step 2 — Detect project and discover routes

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --config <config-path> \
  --mode plan \
  --project-dir <path-to-project>
```

**Project detection** — if `buildCommand` / `serveCommand` not in config, infer from:

| Signal | Build | Serve |
|---|---|---|
| `next.config.*` | `next build` | `next start` |
| `vite.config.*` | `vite build` | `vite preview` |
| `react-scripts` in `package.json` | `react-scripts build` | `react-scripts start` |
| `nuxt.config.*` | `nuxt build` | `nuxt start` |
| `angular.json` | `ng build` | `ng serve` |
| `package.json` `scripts.build` present | value of `scripts.build` | value of `scripts.start` or `scripts.dev` |
| `index.html` only | — | `npx serve .` |

**Route discovery** (if `routes` not in config, in order):
1. Fetch `/sitemap.xml` from the running server and parse `<loc>` paths
2. Scan framework route files (`pages/`, `app/`, `src/router/`, `src/app/`) for path strings
3. Crawl links from `/` up to depth 3, same-origin only
4. Fallback: `["/"]`

Filters: skip unresolvable dynamic segments (`:id`, `[slug]` with no known value), deduplicate, cap at 50 unless confirmed.

Writes `<outputDir>/plan.json`:
```json
{
  "routes": ["/", "/about", "/products"],
  "viewports": [{"label": "mobile", "width": 375, "height": 812}, ...],
  "buildCommand": "npm run build",
  "serveCommand": "npm start",
  "totalComparisons": 9
}
```

Show the plan to the user and ask for confirmation before proceeding (or skip if `--yes` flag provided).

## Step 3 — Start baseline server

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --config <config-path> \
  --mode start-baseline \
  --project-dir <path-to-project>
```

1. Remove any stale worktree: `git worktree remove .visual-regression/baseline --force` (ignore errors)
2. Create worktree: `git worktree add .visual-regression/baseline <base>`
3. Install dependencies inside worktree (detect: `npm ci` / `yarn install --frozen-lockfile` / `pnpm install --frozen-lockfile`)
4. Run `buildCommand` if required by the serve mode
5. Start server: `PORT=<basePort> <serveCommand>` — capture PID
6. Poll `http://localhost:<basePort>/` every 500ms until 200 response, timeout 120s
7. Write PID and port to `<outputDir>/servers.json`

## Step 4 — Start candidate server

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --config <config-path> \
  --mode start-candidate \
  --project-dir <path-to-project>
```

1. Run `buildCommand` in project root if required
2. Start server: `PORT=<port> <serveCommand>` — capture PID
3. Poll `http://localhost:<port>/` until ready, timeout 120s
4. Append PID and port to `<outputDir>/servers.json`

## Step 5 — Capture screenshots

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --config <config-path> \
  --mode capture \
  --project-dir <path-to-project>
```

For each `(route, viewport)` combination, capture both servers in parallel (up to `parallel` workers).

**Per-page procedure:**
1. Navigate to `http://localhost:<port><route>`
2. Wait for network idle (no requests for 500ms)
3. Wait for `document.fonts.ready`
4. If `animations: disable` → inject `* { animation-duration: 0s !important; transition-duration: 0s !important; }`
5. Apply `waitFor`: if a CSS selector → wait for element to appear; if a number → sleep N ms
6. Apply `ignore` masks: for each matching selector, paint its bounding box `#FF00FF` on both images
7. Scroll to page bottom and back to trigger lazy-loaded content
8. Capture screenshot: `fullPage: true` by default
9. Save to `<outputDir>/candidate/<viewport-label>/<route-slug>.png`
10. Repeat for baseline → `<outputDir>/baseline/<viewport-label>/<route-slug>.png`

**Route slug:** `/products/list` → `products__list`, `/` → `index`

**Auth:** if `auth` config is present, authenticate once per browser context before the screenshot loop:
- `cookie` → inject cookies directly
- `bearer` → set `Authorization` header on all requests
- `login-form` → navigate to `loginRoute`, fill and submit form, wait for `successSelector`

**On error:** if navigation fails (4xx / 5xx / timeout after 3 retries), record as `error` and continue.

Writes `<outputDir>/captures.json` with status per (route, viewport).

## Step 6 — Compare screenshots

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --config <config-path> \
  --mode compare
```

For each candidate/baseline pair:

1. **Pixel diff**: compare RGBA arrays, produce `<outputDir>/diff/<viewport>/<slug>.png` with changed pixels highlighted in red (`#FF0000AA`)
2. **SSIM**: compute structural similarity on greyscale 800px-wide versions
3. **Classify**:
   - `pass` — `diffRatio ≤ threshold` AND `ssim ≥ 0.99`
   - `warn` — `diffRatio ≤ threshold × 3` OR `ssim ≥ 0.97`
   - `fail` — otherwise
4. If image dimensions differ → record `size-change` (always `warn`), resize smaller to larger before comparison

Writes `<outputDir>/comparisons.json`.

## Step 7 — Generate report

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --config <config-path> \
  --mode report
```

Writes `<outputDir>/report.html` — a **self-contained** HTML file (no CDN, no external URLs):
- All CSS inline
- All screenshots embedded as base64 data URIs
- Summary header: branch names, commit hashes, date, counts (pass / warn / fail)
- Failing comparisons shown first, expanded by default
- Per-row: route, viewport, status badge, diffRatio %, SSIM score, side-by-side baseline / candidate / diff images
- Click any image to enlarge (pure CSS lightbox)

Also writes `<outputDir>/report.json` with full machine-readable results.

Opens `report.html` in the default browser automatically (unless `--no-open`).

## Step 8 — Teardown

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --config <config-path> \
  --mode teardown \
  --project-dir <path-to-project>
```

1. Kill server processes from `servers.json` (SIGTERM, then SIGKILL after 5s)
2. Remove git worktree: `git worktree remove .visual-regression/baseline --force`
3. Remove `servers.json`

Teardown runs automatically at the end of `--mode run`, and also on SIGINT/SIGTERM during any mode.

## Convenience: run the full pipeline

```bash
python3 .agents/skills/visual-regression/scripts/runner.py \
  --config <config-path> \
  --mode run \
  --project-dir <path-to-project> \
  [--yes]  # skip confirmation prompts
```

Runs Steps 1–8 in sequence. Teardown is guaranteed via `try/finally`.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Output structure

```
.visual-regression/
  plan.json
  servers.json
  captures.json
  comparisons.json
  report.html       ← open this
  report.json
  baseline/
    mobile/   desktop/   tablet/
      index.png
      products__list.png
  candidate/
    (same structure)
  diff/
    (same structure — red-highlighted changed pixels)
```

## Edge cases

- **Server startup timeout (120s)**: abort, print last 50 lines of server stderr, run teardown
- **Flaky routes**: retry up to 3 times; mark as `error` if all fail — never abort the full run
- **Ports in use**: auto-increment by 1; report actual ports used
- **Stale worktree**: always remove before creating; never fail if removal fails
- **Monorepo**: ask user which app before proceeding
- **Uncommitted changes**: warn and confirm before stashing; stash is restored in teardown
- **Dimension mismatch**: resize the smaller image to match the larger before pixel comparison; always classified `warn`
- **Large run (> 100 comparisons)**: warn and ask for confirmation
- **`localhost` vs `127.0.0.1`**: always use `localhost`
- **HTTPS / self-signed certs**: launch browser with `--ignore-certificate-errors`
- **Animations**: disabled by CSS injection by default; enable with `animations: allow`
- **Lazy images**: scroll to bottom before screenshot to trigger loading
- **Fonts not loaded**: wait for `document.fonts.ready` before capturing

## Success criteria

- Both servers start and serve all routes without error
- Every `(route, viewport)` pair has a screenshot for both candidate and baseline
- `report.html` and `report.json` are written and valid
- Failing comparisons are surfaced at the top of the report
- No working-tree files are modified; git worktree is cleaned up on exit, even on error
- Dry-run produces no screenshots, no servers — only `plan.json`
