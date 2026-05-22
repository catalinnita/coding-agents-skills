---
name: lighthouse-fix
description: >
  Reads the latest Lighthouse audit results, parses every failed or warning
  audit, applies auto-fixable recommendations directly to the source code
  (render-blocking scripts, missing preconnects, LCP preloads, font-display,
  image sizing, WebP conversion, text compression config, document.write
  replacement), and produces a structured report of fixes applied and issues
  that require manual attention. Use when asked to fix lighthouse issues,
  implement lighthouse recommendations, improve performance score, or act on
  lighthouse results.
compatibility: >
  Requires Python 3.10+ and Node.js. Image conversion requires sharp (installed
  automatically if missing). The lighthouse-tests skill must have run at least
  once so a raw result file exists.
metadata:
  author: the-morning-bell
  version: "1.0"
---

## Overview

Parse Lighthouse audit results and implement code-level performance fixes.
Reads the raw Lighthouse JSON from the most recent `lighthouse-tests` run,
classifies every failing or warning audit as auto-fixable or manual, applies
the safe code-level fixes, optionally re-runs Lighthouse to measure the
improvement, and writes a full report of what changed and what still needs
a developer.

## Inputs

| Config key | Default | Description |
|---|---|---|
| `reportDir` | `".performance/history/lighthouse"` | Where to find raw Lighthouse results |
| `outputDir` | `".performance"` | Where to write the fix report |
| `url` | `null` | Audit a specific URL only; default: all URLs in `reportDir` |
| `fix` | `true` | Apply fixes. `false` = report only (dry run) |
| `verify` | `false` | Re-run Lighthouse after fixing to measure score change |
| `categories` | `["performance"]` | Which Lighthouse audit categories to process |
| `ignore` | `[]` | Audit IDs to skip (e.g. `["uses-webp-images"]`) |
| `imageQuality` | `80` | WebP conversion quality (0–100) |

Config is read from `performance.config.json` under the key `lighthousefix`,
or from `.lighthousefix.config.json` at the project root.

## Step 1 — Locate the latest Lighthouse results

```bash
python3 .agents/skills/lighthouse-fix/scripts/runner.py \
  --mode locate \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Walk `reportDir` for all `<url-slug>/<timestamp>.raw/run-<n>.json` files.
For each URL slug, pick the most recent timestamp directory and average the
raw Lighthouse JSON across all runs in it.

The raw Lighthouse JSON `audits` object contains every audit with fields:
- `id` — audit identifier (e.g. `"render-blocking-resources"`)
- `score` — 0–1 (null = informational; < 1 = failing/warning)
- `details` — structured evidence (list of affected URLs, elements, sizes)
- `description` — human-readable explanation
- `displayValue` — human-readable measurement

Collect all audits where `score !== null && score < 1` across all URLs.

If no raw results are found, tell the user to run the `lighthouse-tests` skill
first and exit.

## Step 2 — Classify audits

```bash
python3 .agents/skills/lighthouse-fix/scripts/runner.py \
  --mode classify \
  --project-dir <path-to-project>
```

Sort every failing audit into one of three buckets:

### Auto-fixable (code changes applied by this skill)

| Audit ID | What this skill does |
|---|---|
| `render-blocking-resources` | Add `defer` to `<script>` in `<head>`; add `media="print" onload` to non-critical CSS `<link>` |
| `uses-rel-preconnect` | Insert `<link rel="preconnect" href="...">` for each detected third-party origin |
| `preload-lcp-image` | Insert `<link rel="preload" as="image" href="...">` for the LCP element's image |
| `font-display` | Add `font-display: swap` to all `@font-face` rules in source CSS/SCSS files |
| `unsized-images` | Add explicit `width` and `height` attributes to `<img>` elements missing them (prevents CLS) |
| `uses-responsive-images` | Add `srcset` to `<img>` elements serving images larger than their display size |
| `uses-webp-images` | Convert referenced images to WebP using sharp; replace `<img src>` with `<picture>` + WebP source |
| `efficient-animated-content` | Convert GIF images referenced in HTML to `<video autoplay loop muted playsinline>` |
| `uses-text-compression` | Add gzip/brotli compression config to `next.config.js`, `vercel.json`, or `nginx.conf` |
| `no-document-write` | Replace `document.write(html)` with equivalent `insertAdjacentHTML` or `appendChild` calls |
| `uses-passive-event-listeners` | Add `{ passive: true }` to `addEventListener` calls for `scroll`, `touchstart`, `touchmove`, `wheel` |
| `js-libraries` | Flag outdated libraries detected by Lighthouse (handled by security skill — note only) |

### Config-fixable (requires server or framework config changes, not source code)

| Audit ID | Guidance produced |
|---|---|
| `uses-long-cache-ttl` | Provide `Cache-Control` headers config for the detected framework |
| `server-response-time` | Provide TTFB optimisation checklist (caching, DB indexing, CDN) |
| `bootup-time` | Identify the heaviest JS files from `details`; suggest code-splitting entry points |

### Manual (too complex or risky to auto-fix)

| Audit ID | Why manual |
|---|---|
| `unused-javascript` | Requires understanding which code paths are actually used; may need bundle analysis |
| `unused-css-rules` | Safe removal requires visual testing; use `css-refactor` + `visual-regression` agents |
| `dom-size` | Requires component-level refactoring |
| `total-byte-weight` | Requires architecture decisions about bundle splitting |
| `third-party-summary` | Removing or lazy-loading third parties requires product decisions |
| `render-blocking-resources` (CSS) | Non-critical CSS inlining may require build pipeline changes |
| `legacy-javascript` | Requires Babel/transpilation config changes with broad scope |
| `efficient-animated-content` (complex) | Video encoding parameters need human review |

## Step 3 — Apply auto-fixes

```bash
python3 .agents/skills/lighthouse-fix/scripts/runner.py \
  --mode fix \
  --project-dir <path-to-project>
```

Apply each auto-fixable audit's fix in order of potential score impact
(highest improvement first, estimated from the audit's `details.overallSavingsMs`
or `details.overallSavingsBytes`).

---

### `render-blocking-resources`

Detect `<script>` tags in `<head>` without `defer` or `async`. For each:
- If the script has no `type="module"` (which defers automatically) → add `defer`
- If the script is an inline script → skip (cannot defer inline scripts)

```html
<!-- Before -->
<script src="/app.js"></script>
<!-- After -->
<script src="/app.js" defer></script>
```

For blocking CSS `<link rel="stylesheet">` in `<head>` that Lighthouse flags:
```html
<!-- Before -->
<link rel="stylesheet" href="/non-critical.css">
<!-- After -->
<link rel="stylesheet" href="/non-critical.css"
      media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="/non-critical.css"></noscript>
```

Only apply to CSS files explicitly listed in the `details.items` of the audit.

---

### `uses-rel-preconnect`

Read `details.items` for third-party origins. For each origin not already
preconnected in `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
```

Add `crossorigin` for origins serving fonts or CORS resources (detected from
the origin hostname pattern: `fonts.*`, `static.*`, `cdn.*`, `assets.*`).

---

### `preload-lcp-image`

Read the `details.items[0].url` from the `preload-lcp-image` audit (the LCP
element's image URL). Find the `<img>` or CSS `background-image` referencing it.

Insert in `<head>` (before other `<link>` tags for correct priority):
```html
<link rel="preload" as="image" href="/hero.jpg"
      imagesrcset="/hero-400.jpg 400w, /hero-800.jpg 800w"
      imagesizes="100vw">
```

Include `imagesrcset` only if `srcset` is already present on the `<img>`.

---

### `font-display`

Scan all `.css`, `.scss`, `.sass` files for `@font-face` blocks without a
`font-display` property. For each:

```css
/* Before */
@font-face {
  font-family: 'Inter';
  src: url('/fonts/inter.woff2') format('woff2');
}

/* After */
@font-face {
  font-family: 'Inter';
  src: url('/fonts/inter.woff2') format('woff2');
  font-display: swap;
}
```

---

### `unsized-images`

For each `<img>` in `details.items` that is missing `width` or `height`:
- Inspect the image file (using Python's `PIL` / `Pillow`) to get its natural dimensions
- Add `width` and `height` attributes matching the natural size
- This prevents layout shift while the image loads

```html
<!-- Before -->
<img src="/hero.jpg" alt="Hero image">
<!-- After -->
<img src="/hero.jpg" alt="Hero image" width="1200" height="600">
```

If the image is not on the local filesystem (external URL), skip and add to
the manual list.

---

### `uses-responsive-images`

For each `<img>` in `details.items` serving an image larger than its displayed
size by more than 25KB:
- Detect the natural image width from the file
- Add a `srcset` with the original + a half-width variant (if it exists or can
  be created alongside the WebP step)

```html
<!-- Before -->
<img src="/hero.jpg" width="800" height="400">
<!-- After -->
<img src="/hero.jpg" width="800" height="400"
     srcset="/hero.jpg 1200w, /hero-800.jpg 800w"
     sizes="(max-width: 800px) 100vw, 800px">
```

---

### `uses-webp-images`

For each image in `details.items` that is a JPEG or PNG on the local filesystem:

1. Convert to WebP using sharp: `sharp input.jpg --webp -q <imageQuality> -o output.webp`
2. Replace the `<img src>` reference with a `<picture>` element:

```html
<!-- Before -->
<img src="/images/hero.jpg" alt="Hero" width="1200" height="600">

<!-- After -->
<picture>
  <source srcset="/images/hero.webp" type="image/webp">
  <img src="/images/hero.jpg" alt="Hero" width="1200" height="600">
</picture>
```

3. For CSS `background-image` references, add a `.webp` class alternative and
   a `TODO` comment: the Modernizr / feature-detect approach cannot be auto-applied.

---

### `efficient-animated-content`

For each GIF in `details.items`:
1. Convert to MP4 using `ffmpeg`: `ffmpeg -i input.gif -movflags faststart -pix_fmt yuv420p output.mp4`
2. Replace `<img src="*.gif">` with:

```html
<video autoplay loop muted playsinline width="400" height="300">
  <source src="/images/animation.mp4" type="video/mp4">
  <img src="/images/animation.gif" alt="Animation">
</video>
```

If `ffmpeg` is not available, skip and add to manual list.

---

### `uses-text-compression`

Detect the serving framework from config files and add compression:

| Framework | Fix applied |
|---|---|
| Next.js | Add `compress: true` to `next.config.js` (default is already true; flag if explicitly set to false) |
| Express | Add `compression` middleware import and `app.use(compression())` |
| Fastify | Add `@fastify/compress` plugin registration |
| Nginx | Add `gzip on; gzip_types text/plain text/css application/json application/javascript;` |
| Vercel | Add `headers` with `Content-Encoding: br` note (Vercel compresses automatically; flag if custom server) |

---

### `no-document-write`

For each `document.write(...)` call in `details.items`:
- Parse the argument to extract the HTML string
- Replace with `document.getElementById('target').insertAdjacentHTML('beforeend', html)` where `target` is inferred from context, or wrap in a `TODO` comment if context is ambiguous

---

### `uses-passive-event-listeners`

For each `addEventListener` call in `details.items` using `scroll`,
`touchstart`, `touchmove`, or `wheel`:

```javascript
// Before
element.addEventListener('scroll', handler);
// After
element.addEventListener('scroll', handler, { passive: true });
```

If the existing third argument is already an options object, merge `passive: true`.
If the handler calls `event.preventDefault()` inside, skip (passive listeners
cannot prevent default) and add to manual list.

---

## Step 4 — Generate config guidance (config-fixable audits)

For each config-fixable audit, write a ready-to-apply config snippet to the
report with instructions, but do not write to source files automatically:

**`uses-long-cache-ttl` — Cache-Control config:**
```nginx
# nginx.conf
location ~* \.(js|css|png|jpg|jpeg|gif|ico|woff2)$ {
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

**`server-response-time` — TTFB checklist:**
```
□ Enable Next.js ISR or full-page caching for static routes
□ Add Redis caching for repeated database queries
□ Move to a CDN edge location closer to your users
□ Enable Next.js output: 'standalone' + CDN in front
```

**`bootup-time` — JS splitting entry points:**
List the heaviest JS files from `details.items` sorted by transfer size, with
their exact paths and estimated savings, ready to convert to dynamic `import()`.

## Step 5 — Verify (when `verify: true`)

Re-run the `lighthouse-tests` skill in single-URL mode to measure the score
improvement:

```bash
python3 .agents/skills/lighthouse-tests/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Compare the new scores against the scores from Step 1. Record the delta for
each metric in the final report.

## Step 6 — Generate report

```bash
python3 .agents/skills/lighthouse-fix/scripts/runner.py \
  --mode report \
  --project-dir <path-to-project>
```

Write `<outputDir>/lighthouse-fix-report.md`:

```markdown
# Lighthouse Fix Report — 2026-05-22 14:32

## Score change (after fixes)
| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Performance | 68 | 84 | ▲ +16 |
| LCP | 3.2s | 1.9s | ▲ improved |
| TBT | 480ms | 120ms | ▲ improved |
| CLS | 0.18 | 0.02 | ▲ improved |

## Auto-fixed (9 issues across 3 files)

### render-blocking-resources — 3 scripts
- src/pages/_document.tsx:14 — added `defer` to `/app.js`
- src/pages/_document.tsx:15 — added `defer` to `/vendor.js`
- public/index.html:8 — added `defer` to `/analytics.js`
  Estimated saving: ~680ms TBT

### uses-rel-preconnect — 2 origins
- src/pages/_document.tsx — added preconnect for `fonts.googleapis.com`
- src/pages/_document.tsx — added preconnect for `fonts.gstatic.com`

### font-display — 4 @font-face rules
- src/styles/fonts.css:3,12,21,30 — added `font-display: swap`
  Estimated saving: ~0.4s FCP

### unsized-images — 2 images
- src/components/Hero.tsx:8 — added width="1200" height="600" to /hero.jpg
- src/components/Card.tsx:22 — added width="400" height="300" to /card.jpg
  Estimated CLS improvement: 0.16

### uses-webp-images — 1 image
- public/images/hero.jpg → public/images/hero.webp (saved 142KB)
- src/components/Hero.tsx:8 — wrapped in <picture>

---

## Config guidance (not auto-applied)

### uses-long-cache-ttl
Add the following to nginx.conf — see `.performance/config-guidance.md`

### bootup-time — Top JS files to split
1. /static/chunks/framework.abc123.js — 148KB
2. /static/chunks/main.def456.js — 62KB
Split recommendation: dynamic import() for routes using these chunks

---

## Manual review required (4 issues)

### unused-javascript — 54KB saveable
The following chunks contain unused code that cannot be safely removed
automatically. Use webpack-bundle-analyzer or next bundle-analyzer to
investigate:
- /static/chunks/pages/checkout.js — 32KB unused
- /static/chunks/shared.js — 22KB unused

### dom-size — 1,842 elements
The DOM has 1,842 elements (threshold: 800). This requires component-level
refactoring to virtualise long lists or reduce nesting. No auto-fix available.
```

Also write `<outputDir>/lighthouse-fix-report.json` with machine-readable results,
and `<outputDir>/config-guidance.md` with copy-paste config snippets for the
config-fixable audits.

## Convenience: run the full pipeline

```bash
python3 .agents/skills/lighthouse-fix/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project> \
  [--verify] [--dry-run]
```

`--dry-run` runs Steps 1–2 only: prints what would be fixed without writing files.
`--verify` runs Step 5 after Step 4 to measure the improvement.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Output structure

```
.performance/
  lighthouse-fix-report.md     ← human-readable fix summary
  lighthouse-fix-report.json   ← machine-readable results
  config-guidance.md           ← copy-paste config snippets
```

## Edge cases

- **No raw Lighthouse results found**: tell the user to run `lighthouse-tests`
  first and exit with a helpful message listing the expected file path
- **Multiple URLs in results**: process each URL's audits independently; a fix
  applied to a shared file (e.g. `_document.tsx`) is applied once and noted for
  all affected URLs
- **`render-blocking-resources` — inline scripts**: cannot defer; add a `TODO`
  comment and note in the manual review section
- **WebP conversion — external images**: only convert images on the local
  filesystem; skip `https://` references and note them
- **WebP conversion — CSS `background-image`**: note in report; cannot be auto-
  converted without a feature-detect mechanism; provide the Modernizr pattern
- **`no-document-write` — ambiguous target**: if the injection target cannot be
  inferred from context, wrap in a `TODO` rather than breaking the code
- **`uses-passive-event-listeners` — `preventDefault()` calls**: passive
  listeners cannot call `preventDefault()`; skip and flag for manual review
- **`efficient-animated-content` — ffmpeg not installed**: skip and add to
  manual review with install instructions
- **`preload-lcp-image` — dynamically inserted image** (set by JS, not in HTML):
  cannot be preloaded statically; note in manual section with LCP optimisation
  alternatives (priority hints, `fetchpriority="high"` on the `<img>`)
- **`font-display` — already set**: skip `@font-face` blocks that already have
  any `font-display` value; do not overwrite an intentional choice
- **Existing `defer` or `async`**: skip scripts that already have either attribute
- **TypeScript / JSX files**: parse JSX `<script>` and `<link>` the same as HTML;
  handle template literals for dynamic `href` values by adding a `TODO`
- **Uncommitted changes at start**: warn if the working tree is not clean; the
  user may want to commit before applying fixes so the diff is clear

## Success criteria

- Every auto-fixable audit in the Lighthouse results has a corresponding code
  change or a documented reason it was skipped
- No applied fix breaks the syntax of the modified file (validate with the
  project's existing linter/TypeScript compiler after applying)
- The report distinguishes clearly between: fixes applied, config guidance
  provided, and issues requiring manual developer attention
- Score improvement is measured if `verify: true` (requires re-running Lighthouse)
- All image originals are preserved; WebP and MP4 files are additions, not replacements
