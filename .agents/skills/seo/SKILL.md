---
name: seo
description: >
  Audits the codebase for SEO issues — missing or malformed metadata, poor
  heading structure, absent structured data, crawlability problems, and Core Web
  Vitals heuristics — then applies safe fixes and produces a priority-ranked HTML
  report. Use when asked to run an SEO audit, fix SEO issues, add meta or open
  graph tags, check a sitemap or robots.txt, add structured data, or improve
  page titles and descriptions.
compatibility: >
  Requires Python 3.10+. Runtime Lighthouse analysis requires Node.js and
  Playwright (installed automatically via PEP 723 inline metadata).
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Audit and fix SEO issues in a codebase. Scans source files statically for
metadata, heading, link, image, and crawlability violations; optionally runs
Lighthouse against the live dev server for Core Web Vitals and runtime-rendered
metadata; applies safe auto-fixes; and writes a self-contained HTML report.

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to audit. Default: entire project source |
| `fix` | No | `true` to apply auto-fixable issues. Default: `false` (report only) |
| `baseUrl` | No | Production URL (e.g. `https://example.com`) — required for canonical and sitemap checks |
| `includeRuntime` | No | `true` to audit the live dev server with Lighthouse. Default: `false` |
| `serveCommand` | No | Dev server command — required when `includeRuntime: true` |
| `port` | No | Dev server port. Default: `3000` |
| `routes` | No | URL paths to audit when `includeRuntime: true`. Default: auto-discovered |
| `ignore` | No | Array of rule names to suppress |
| `outputDir` | No | Output directory. Default: `.seo/` |

## Step 1 — Resolve config and pre-flight checks

Look for config in this order:
1. `.seo.config.json` in the project root
2. Built-in defaults

Run pre-flight checks:

```bash
python3 .agents/skills/seo/scripts/runner.py \
  --mode preflight \
  --project-dir <path-to-project>
```

Checks performed:
- Project contains HTML-producing source files
- Detect framework and rendering model:
  - **SSR / SSG** (Next.js, Nuxt, SvelteKit, Astro): full static analysis possible
  - **CSR-only** (CRA, Vite SPA): metadata injected at runtime — recommend `includeRuntime: true`
- If `fix: true` — confirm no uncommitted changes or ask for confirmation
- If `baseUrl` not provided — warn that canonical URL and sitemap checks will be skipped
- If monorepo detected — ask which app to audit

## Step 2 — Static analysis

Scan source files without executing the app:

```bash
python3 .agents/skills/seo/scripts/runner.py \
  --mode analyze \
  --project-dir <path-to-project>
```

**Files scanned:**

| File type | What is checked |
|---|---|
| `.html` | All HTML-level rules |
| `.jsx`, `.tsx`, `.vue`, `.svelte`, `.astro` | Metadata components (`<Head>`, `<Helmet>`, `useHead`, `<svelte:head>`) |
| `robots.txt` | Crawl directives |
| `sitemap.xml` / `sitemap-index.xml` | Structure and URL validity |
| Framework configs | `trailingSlash`, `basePath`, redirect rules |

**Metadata checks:**

*`<title>`*: missing; empty; >60 chars (truncated in SERPs); <10 chars; duplicate across pages; contains only site name without page-specific segment.

*`<meta name="description">`*: missing; empty; >160 chars; <50 chars; duplicate across pages.

*Canonical (`<link rel="canonical">`)*: missing on pages reachable via multiple URLs; points to wrong domain; contains query string or fragment.

*Open Graph*: missing `og:title`, `og:description`, `og:image`, `og:url`; relative `og:image`; missing `og:image:width` / `og:image:height`.

*Twitter Card*: missing `twitter:card`; relative `twitter:image`.

*Other meta*: `noindex` / `nofollow` on pages that should be indexed (flag, never auto-remove); missing `<meta charset>`; missing `<meta name="viewport">`.

**Heading structure:**
Missing `<h1>`; multiple `<h1>`; `<h1>` text identical to `<title>`; skipped heading levels; headings with generic text.

**Links:**
`<a>` with no `href` or `href="#"`; generic anchor text ("click here", "read more"); empty `<a>`; broken internal links; `rel="nofollow"` on internal links; missing `rel="noopener noreferrer"` on `target="_blank"` external links.

**Images:**
Missing `alt`; missing `width` and `height` (causes CLS); missing `loading="lazy"` for below-fold images; large images without `srcset`; generic filenames (`image1.jpg`).

**Performance signals (static heuristics):**
Render-blocking `<script>` without `defer` / `async` in `<head>`; `<link rel="stylesheet">` in `<body>`; missing `<link rel="preconnect">` for third-party origins; inline `<style>` >14 KB.

**Crawlability — `robots.txt`:**
File missing; `Disallow: /` blocking entire site; missing `Sitemap:` directive; syntax errors.

**Crawlability — Sitemap:**
`sitemap.xml` missing; relative URLs in `<loc>`; future `<lastmod>` dates; `<priority>` out of range; >50,000 URLs in one file; pages with `noindex` appearing in sitemap.

**Structured data (JSON-LD):**
No structured data present; invalid JSON; missing `@type` or `@context`; missing required properties per type (`Article`, `Product`, `BreadcrumbList`, `FAQPage`, `Organization`).

Writes `<outputDir>/static-issues.json`.

## Step 3 — Runtime analysis (when `includeRuntime: true`)

Start the dev server, then for each route run Lighthouse and collect rendered metadata:

```bash
python3 .agents/skills/seo/scripts/runner.py \
  --mode runtime \
  --project-dir <path-to-project>
```

Per route:
1. Launch headless Chromium, navigate to route
2. Run Lighthouse in SEO + Performance mode — extract audit results and Core Web Vitals (LCP, CLS, INP, FCP, TTFB)
3. Collect fully-rendered `<head>` (catches JS-injected metadata)
4. Re-run static metadata checks against rendered output
5. Validate JSON-LD blocks found in the rendered DOM

Writes `<outputDir>/runtime-issues.json` and `<outputDir>/lighthouse/<route-slug>.json`.

## Step 4 — Fix phase (when `fix: true`)

Apply only violations with a safe, deterministic fix. Never alter content strategy or remove `noindex` directives:

```bash
python3 .agents/skills/seo/scripts/runner.py \
  --mode fix \
  --project-dir <path-to-project>
```

**Auto-fixable:**

| Violation | Fix applied |
|---|---|
| Missing `<meta charset>` | Insert `<meta charset="UTF-8">` as first `<head>` child |
| Missing `<meta name="viewport">` | Insert `<meta name="viewport" content="width=device-width, initial-scale=1">` |
| Missing `og:url` (when `baseUrl` known) | Generate from `baseUrl` + route |
| Relative `og:image` / `twitter:image` | Prepend `baseUrl` |
| Missing `rel="noopener noreferrer"` on `target="_blank"` | Add the attribute |
| Missing `loading="lazy"` on below-fold images | Add `loading="lazy"` |
| Render-blocking `<script>` without `defer` | Add `defer` (warn: verify no synchronous dependency) |
| Missing `<link rel="preconnect">` for detected origins | Insert into `<head>` |

**Not auto-fixed** (reported with guidance): title/description content, canonical URL decisions, structured data content, `noindex` removals, heading hierarchy changes.

If a test suite exists, run it after fixing and report any failures.

## Step 5 — Generate report

```bash
python3 .agents/skills/seo/scripts/runner.py \
  --mode report \
  --project-dir <path-to-project>
```

Writes `<outputDir>/report.html` — **self-contained** HTML (no external dependencies):

```
Project:   my-app
Base URL:  https://example.com
Date:      2026-05-22
Pages scanned: 24

High priority:    9 issues
Medium priority: 14 issues
Low priority:     7 issues

Auto-fixed: 6   Needs review: 24
```

Per-issue table: priority, category, file + line (clickable), affected route, plain-English description with offending value, fix guidance. Sorted High → Low within each category, grouped by page.

Also writes `<outputDir>/report.json`.

## Convenience: run the full pipeline

```bash
python3 .agents/skills/seo/scripts/runner.py \
  --mode run \
  --project-dir <path-to-project>
```

Runs Steps 1–5 in sequence.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Priority mapping

| Signal | Priority |
|---|---|
| Blocks indexing or crawling entirely | High |
| Reduces SERP visibility or click-through rate | Medium |
| Best practice / marginal impact | Low |

## Output structure

```
.seo/
  static-issues.json
  runtime-issues.json        ← only when includeRuntime: true
  report.html                ← open this
  report.json
  lighthouse/                ← only when includeRuntime: true
    index.json
    products__list.json
```

## Edge cases

- **CSR-rendered metadata** (`document.title` via `useEffect`): invisible to static analysis — warn and recommend `includeRuntime: true`
- **Dynamic routes** (`[slug]`, `:id`): flag the template file; note all instances must have unique non-duplicate metadata
- **Duplicate metadata from shared layouts**: if a `<Head>` component is shared without per-page overrides, flag the shared component as the likely source
- **i18n / `hreflang`**: if locale-prefixed routes exist with no `hreflang` tags, flag as Medium
- **Trailing slash inconsistency**: mixed routes without canonical/redirect, flag as Medium
- **HTTP `baseUrl`**: warn and flag all absolute `og:image` URLs as High
- **Large sitemaps (>50,000 URLs)**: validate the first 1,000 and note the limit

## Success criteria

- Every HTML-producing source file is scanned
- Each issue includes exact file path, line number, and offending value
- Fixes do not alter meaningful content, only markup and attributes
- Auto-fixes pass the existing test suite
- `report.html` is self-contained and viewable without a server
- No false positives for intentional `noindex`, valid canonical configs, or decorative images with correct `alt=""`
