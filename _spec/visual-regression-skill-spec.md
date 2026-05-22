# Skill Spec: Visual Regression — Branch vs Main

## Goal

Capture full-page and component-level screenshots of the current local branch, compare them pixel-by-pixel and perceptually against the same routes on the `main` (or `master`) branch, and produce a diff report that makes regressions immediately visible.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "run visual regression"
- "check for visual regressions"
- "compare screenshots with main"
- "visual diff my branch"
- "screenshot diff before/after"

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `routes` | No | List of URL paths to test (default: auto-discovered — see Discovery) |
| `base` | No | Branch or commit to compare against (default: `main`, fallback `master`) |
| `threshold` | No | Max acceptable pixel difference ratio 0–1 (default: `0.01` = 1%) |
| `viewports` | No | List of `{width, height, label}` objects (default: see Viewports) |
| `buildCommand` | No | Command to build the app (default: auto-detected) |
| `serveCommand` | No | Command to start the dev server (default: auto-detected) |
| `port` | No | Port for the candidate (current branch) server (default: `3000`) |
| `basePort` | No | Port for the baseline (main) server (default: `3001`) |
| `outputDir` | No | Where to write screenshots and report (default: `.visual-regression/`) |
| `auth` | No | Authentication config — see Authentication section |
| `ignore` | No | CSS selectors or regions to mask before comparison |
| `waitFor` | No | CSS selector or ms delay to wait before screenshotting each page |
| `fullPage` | No | Capture full scrollable page height (default: `true`) |
| `animations` | No | `disable` (default) \| `allow` |
| `parallel` | No | Max concurrent screenshot workers (default: `4`) |
| `dryRun` | No | Discover routes and print plan, capture no screenshots (default: `false`) |

---

## Behavior

### 1. Pre-flight checks

Before doing anything:
- Confirm the working directory is a git repository
- Check for uncommitted changes; if any exist, warn the user and ask for confirmation before continuing (stashing will discard working-tree changes temporarily)
- Verify the base branch or commit exists: `git rev-parse --verify <base>`
- Confirm at least one of `buildCommand` / `serveCommand` can be resolved
- Check that required tools are installed: `node`, `npx`, `playwright` or `puppeteer` (whichever is available)
- Check that ports `port` and `basePort` are not already in use

### 2. Detect project type and commands

If `buildCommand` / `serveCommand` are not provided, detect from the project:

| Signal | Build command | Serve command |
|---|---|---|
| `next.config.*` | `next build` | `next start` (prod) or `next dev` (dev) |
| `vite.config.*` | `vite build` | `vite preview` or `vite dev` |
| `react-scripts` in `package.json` | `react-scripts build` | `react-scripts start` |
| `nuxt.config.*` | `nuxt build` | `nuxt start` |
| `angular.json` | `ng build` | `ng serve` |
| `package.json` with `scripts.build` | value of `scripts.build` | value of `scripts.start` or `scripts.dev` |
| `Makefile` with `serve` target | — | `make serve` |
| Static files only (`index.html`) | — | `npx serve .` |

If auto-detection fails, ask the user to provide `serveCommand`.

### 3. Route discovery

If `routes` is not provided, discover testable routes automatically:

**Sources (tried in order):**
1. Sitemap at `/sitemap.xml` — parse `<loc>` entries, extract paths
2. Framework-specific route files:
   - Next.js: `pages/`, `app/` directories — derive paths from filenames (strip `index`, convert `[param]` to `:param`)
   - React Router / Vue Router / Angular: scan for route config files (`routes.ts`, `router/index.*`) and extract string path values
3. Links crawl: load the root `/` and recursively follow `<a href>` links that are same-origin, up to depth 3
4. Fall back to `["/"]` (root only)

Apply filters:
- Exclude paths containing dynamic segments that cannot be resolved (e.g. `:id` without a known value)
- Exclude paths in `ignore` config that are full route paths
- Deduplicate
- Cap at 50 routes unless the user confirms a larger run

Report the discovered routes to the user before continuing.

### 4. Start baseline server (main branch)

Use a **git worktree** to avoid modifying the working tree:

```bash
git worktree add .visual-regression/baseline <base>
```

Inside the worktree:
1. Install dependencies: `npm ci` (or `yarn install --frozen-lockfile` / `pnpm install --frozen-lockfile` — detect from lockfile)
2. Run `buildCommand` if required by the serve mode
3. Start the server on `basePort`:

```bash
PORT=<basePort> <serveCommand> &
```

Wait for the server to be ready: poll `http://localhost:<basePort>/` with 500ms interval, timeout after 120s.

### 5. Start candidate server (current branch)

In the main working directory:
1. Run `buildCommand` if required
2. Start the server on `port`:

```bash
PORT=<port> <serveCommand> &
```

Wait for ready with the same polling strategy.

### 6. Screenshot capture

For each `(route, viewport)` combination, capture screenshots of both servers using Playwright (preferred) or Puppeteer.

**Per-page procedure:**

```
1. Navigate to http://localhost:<port><route>
2. Wait for network idle (no requests for 500ms)
3. Apply waitFor: if selector, wait for element; if number, sleep N ms
4. Disable animations (inject CSS: * { animation: none !important; transition: none !important; })
5. Mask ignore regions: paint each selector's bounding box with a solid colour
6. Scroll to bottom and back (forces lazy-loaded images to load)
7. Capture full-page screenshot → candidate/<label>/<route-slug>.png
8. Repeat for baseline server → baseline/<label>/<route-slug>.png
```

**Route slug:** replace `/` with `__`, strip leading `__`, e.g. `/products/list` → `products__list`.

**Concurrency:** process `parallel` route+viewport combinations simultaneously.

**On error:** if navigation fails (4xx, 5xx, timeout), record the failure and continue; do not abort the full run.

### 7. Image comparison

For each candidate/baseline screenshot pair:

1. **Pixel diff** using `pixelmatch`:
   - Compare RGBA pixel arrays
   - Produce a diff image where changed pixels are highlighted in red
   - Record: `totalPixels`, `diffPixels`, `diffRatio`

2. **Perceptual diff** using SSIM (Structural Similarity Index):
   - Downscale to 800px width before computing
   - Record: `ssim` score (1.0 = identical, 0.0 = completely different)

3. **Classification:**
   - `pass` — `diffRatio <= threshold` AND `ssim >= 0.99`
   - `warn` — `diffRatio <= threshold * 3` OR `ssim >= 0.97` (visual change but within tolerance band)
   - `fail` — `diffRatio > threshold * 3` OR `ssim < 0.97`

4. If image dimensions differ between candidate and baseline:
   - Record as `size-change` (always `warn`)
   - Resize smaller to larger before pixel comparison

### 8. Generate report

Write to `<outputDir>/report.html` — a self-contained HTML file (no external dependencies) with:

**Summary header:**
```
Branch:    feature/my-branch  (abc1234)
Baseline:  main               (def5678)
Date:      2026-05-21 14:32

Routes tested:    24
Viewports:         3
Total comparisons: 72

✅ pass   61
⚠️  warn    7
❌ fail    4
```

**Per-comparison table** with:
- Route path
- Viewport label
- Status badge (pass / warn / fail)
- `diffRatio` and `ssim` score
- Expandable side-by-side row: baseline | candidate | diff image

**Fail/warn section at the top** — failing comparisons are shown first, with full-size diff images expanded by default.

Also write `<outputDir>/report.json` with the full machine-readable results.

### 9. Teardown

- Kill both servers (by PID recorded at startup)
- Remove the git worktree: `git worktree remove .visual-regression/baseline --force`
- Print final summary to stdout

---

## Viewports

Default viewports tested unless overridden:

| Label | Width | Height |
|---|---|---|
| `mobile` | 375 | 812 |
| `tablet` | 768 | 1024 |
| `desktop` | 1440 | 900 |

---

## Authentication

If routes require authentication, provide an `auth` config:

```json
{
  "auth": {
    "type": "cookie",
    "cookies": [{ "name": "session", "value": "abc123", "domain": "localhost" }]
  }
}
```

or

```json
{
  "auth": {
    "type": "login-form",
    "loginRoute": "/login",
    "usernameSelector": "#email",
    "passwordSelector": "#password",
    "submitSelector": "button[type=submit]",
    "username": "test@example.com",
    "password": "secret",
    "successSelector": ".dashboard"
  }
}
```

or

```json
{
  "auth": {
    "type": "bearer",
    "token": "eyJhbGci..."
  }
}
```

Authentication is performed once per browser context before the screenshot loop. For `login-form`, the session cookie is saved and reused for all subsequent pages.

---

## Ignore regions

Mask dynamic content that would produce false positives:

```json
{
  "ignore": [
    ".timestamp",
    "#live-chat-widget",
    { "selector": ".ad-banner" },
    { "route": "/dashboard", "selector": ".user-avatar" },
    { "route": "/dashboard", "region": { "x": 0, "y": 0, "width": 60, "height": 60 } }
  ]
}
```

Ignored regions are painted with a solid fill (`#FF00FF`) on both candidate and baseline before comparison, so they always match.

---

## Output structure

```
.visual-regression/
  report.html          ← self-contained HTML report
  report.json          ← machine-readable results
  baseline/
    mobile/
      index.png
      products__list.png
      ...
    tablet/
    desktop/
  candidate/
    mobile/
    tablet/
    desktop/
  diff/
    mobile/
      index.png          ← red-highlighted diff image
      products__list.png
    tablet/
    desktop/
```

---

## Edge cases and constraints

- **Server startup timeout**: if either server does not become ready within 120s, abort and report the error with the last N lines of the server's stderr
- **Flaky routes**: if a route fails 3 consecutive screenshot attempts, mark it as `error` and continue
- **Dimension mismatch**: resize to the larger dimensions before pixel comparison; record the size change in the report
- **Lazy-loaded images**: scroll to the bottom before capturing to trigger lazy loads; use `waitFor` for routes that need a specific selector to appear
- **Animations and transitions**: disabled by default via CSS injection; use `animations: allow` only if the user explicitly wants to capture animated states
- **Fonts not loaded**: wait for `document.fonts.ready` before capturing
- **`localhost` vs `127.0.0.1`**: use `localhost` consistently; some frameworks redirect or reject one form
- **Monorepos**: if multiple `package.json` files are detected, ask the user which app to test before proceeding
- **Git worktree conflicts**: if `.visual-regression/baseline` already exists from a previous run, remove it before creating a new one
- **Ports in use**: if `port` or `basePort` is busy, auto-increment by 1 and report the actual ports used
- **Large screenshot count**: if `routes × viewports > 100`, warn the user about runtime and ask for confirmation
- **HTTPS / certificates**: for local servers that use self-signed certs, launch the browser with `--ignore-certificate-errors`

---

## Success criteria

- Both servers start and serve all requested routes without error
- Every `(route, viewport)` pair has a screenshot for both candidate and baseline
- `report.html` and `report.json` are written and valid
- All failing comparisons are surfaced at the top of the report
- No working-tree files are modified; git worktree is cleaned up on exit (even on error)
- Dry-run produces no screenshots or servers, only a route/viewport plan
