# Skill Spec: SEO Audit and Fix

## Goal

Audit the codebase for SEO issues — missing or malformed metadata, poor heading structure, absent structured data, slow Core Web Vitals signals, and crawlability problems — then apply safe, targeted fixes and produce a prioritised report so the highest-impact improvements are addressed first.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "run an SEO audit"
- "fix SEO issues"
- "improve SEO"
- "add meta tags / open graph tags"
- "check my sitemap / robots.txt"
- "add structured data / JSON-LD"
- "improve page titles / descriptions"
- "check canonical URLs"

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to audit (default: entire project source) |
| `fix` | No | `true` to apply auto-fixable issues; `false` (default) to report only |
| `baseUrl` | No | Production URL of the site (e.g. `https://example.com`) — required for canonical and sitemap checks |
| `includeRuntime` | No | `true` to also audit the live dev server with Lighthouse / browser (default: `false`) |
| `serveCommand` | No | Dev server command — required when `includeRuntime: true` |
| `port` | No | Port for the dev server (default: `3000`) |
| `routes` | No | URL paths to audit when `includeRuntime: true` (default: auto-discovered) |
| `ignore` | No | Array of rule names to suppress |
| `outputDir` | No | Where to write the report (default: `.seo/`) |

---

## Behavior

### 1. Pre-flight checks

- Confirm the project contains HTML output (framework source or static files)
- Detect the framework and rendering model:
  - **SSR / SSG** (Next.js, Nuxt, SvelteKit, Astro): most metadata is in source — full static analysis possible
  - **CSR-only** (Create React App, Vite SPA): metadata may be injected at runtime — recommend `includeRuntime: true`
- If `fix: true`, confirm no uncommitted changes or ask for confirmation
- If `baseUrl` is not provided, warn that canonical URL and sitemap checks will be skipped

### 2. Static analysis (always runs)

**Files scanned by type:**

| File type | What is checked |
|---|---|
| `.html` | All HTML-level rules |
| `.jsx`, `.tsx`, `.vue`, `.svelte`, `.astro` | Metadata components (`<Head>`, `<Helmet>`, `useHead`, `<svelte:head>`) parsed for tag extraction |
| `robots.txt` | Crawl directives |
| `sitemap.xml` / `sitemap-index.xml` | Structure and URL validity |
| `next.config.*`, `nuxt.config.*`, etc. | `trailingSlash`, `basePath`, redirect rules |

---

#### Metadata

**`<title>` tag**
- Missing `<title>` → High
- `<title>` empty or whitespace-only → High
- `<title>` longer than 60 characters (truncated in SERPs) → Medium
- `<title>` shorter than 10 characters (too generic) → Medium
- Duplicate `<title>` across pages (same value used as a template without page-specific content) → High
- `<title>` contains only the site name without a page-specific segment → Medium

**`<meta name="description">`**
- Missing → High
- Empty → High
- Longer than 160 characters → Medium
- Shorter than 50 characters → Low
- Duplicate across pages → High

**Canonical URL (`<link rel="canonical">`)**
- Missing on pages that may be reached via multiple URLs → High
- Points to a different domain than `baseUrl` → High
- Self-referencing canonical present and correct → pass
- Canonical URL contains a query string or fragment → Medium

**Open Graph**
- Missing `og:title` → Medium
- Missing `og:description` → Medium
- Missing `og:image` → Medium
- Missing `og:url` → Medium
- `og:image` is a relative URL (must be absolute) → High
- `og:image` dimensions not specified via `og:image:width` / `og:image:height` → Low

**Twitter Card**
- Missing `twitter:card` → Low
- Missing `twitter:title` when `og:title` is also absent → Medium
- `twitter:image` is a relative URL → High

**Other meta**
- `<meta name="robots" content="noindex">` or `nofollow` present on pages that should be indexed → High (flag, do not auto-remove)
- `<meta charset>` missing → Medium
- `<meta name="viewport">` missing → High (also an accessibility issue)

---

#### Heading structure

- Missing `<h1>` on a page → High
- Multiple `<h1>` elements on a page → High
- `<h1>` text is identical to `<title>` (low differentiation) → Low
- Heading levels skipped (e.g. `<h2>` → `<h4>`) → Medium
- Headings used purely for styling (very short or generic text like "Click here") → Low

---

#### Links

- `<a>` with no `href` or `href="#"` → Medium
- `<a>` with generic link text ("click here", "read more", "here") → Medium
- `<a>` with no text content and no `aria-label` → High (also accessibility)
- Broken internal links (href references a route that does not exist in the project) → High
- `rel="nofollow"` on internal links → Medium (flag, do not auto-remove)
- Missing `rel="noopener noreferrer"` on `target="_blank"` external links → Low

---

#### Images

- `<img>` missing `alt` attribute → High (also accessibility)
- `<img>` missing `width` and `height` attributes (causes Cumulative Layout Shift) → High
- `<img>` without lazy loading (`loading="lazy"`) for below-the-fold images → Medium
- Large images referenced without a `srcset` or `sizes` → Medium
- Image filenames containing only generic names (`image1.jpg`, `img_001.png`) → Low

---

#### Performance signals (static heuristics)

- Render-blocking `<script>` tags without `defer` or `async` in `<head>` → Medium
- `<link rel="stylesheet">` in `<body>` → Medium
- Missing `<link rel="preconnect">` for third-party origins used by the page (fonts.googleapis.com, etc.) → Low
- Inline `<style>` blocks larger than 14 KB → Low

---

#### Crawlability

**`robots.txt`**
- File missing → Medium
- `Disallow: /` without a matching `Allow` — entire site blocked → High
- `Sitemap:` directive missing → Low
- Syntax errors (invalid field names) → Medium

**Sitemap**
- `sitemap.xml` missing → Medium
- `<loc>` entries containing relative URLs → High
- `<lastmod>` dates in the future → Medium
- `<priority>` outside the 0.0–1.0 range → Low
- More than 50,000 URLs in a single sitemap file (exceeds spec limit) → High
- Pages that appear in the sitemap but have `noindex` meta → High

**Redirects**
- Redirect chains longer than 2 hops → Medium
- Redirect to an HTTP (non-HTTPS) destination → High

---

#### Structured data (JSON-LD)

- No structured data present anywhere in the project → Low (guidance only)
- `<script type="application/ld+json">` containing invalid JSON → High
- JSON-LD `@type` missing → High
- JSON-LD `@context` missing or not `https://schema.org` → High
- Required properties missing for detected `@type`:
  - `Article`: `headline`, `author`, `datePublished` → Medium
  - `Product`: `name`, `offers` → Medium
  - `BreadcrumbList`: `item` entries with `name` and `id` → Medium
  - `FAQPage`: `mainEntity` array → Medium
  - `Organization`: `name`, `url` → Low

---

### 3. Runtime analysis (when `includeRuntime: true`)

Start the dev server, then for each route:

1. Launch headless Chromium and navigate to the route
2. Run **Lighthouse** in SEO and Performance category mode; extract:
   - All Lighthouse SEO audits and scores
   - Core Web Vitals: LCP, CLS, FID/INP, FCP, TTFB
   - Render-blocking resource warnings
3. Collect the fully-rendered `<head>` (catches metadata injected via JavaScript)
4. Re-run all static metadata checks against the rendered output
5. Validate any JSON-LD blocks found in the rendered DOM

### 4. Fix phase (when `fix: true`)

Apply only violations that have a safe, deterministic fix. Never alter content strategy or remove `noindex` directives.

**Auto-fixable:**

| Violation | Fix applied |
|---|---|
| Missing `<meta charset>` | Insert `<meta charset="UTF-8">` as first child of `<head>` |
| Missing `<meta name="viewport">` | Insert `<meta name="viewport" content="width=device-width, initial-scale=1">` |
| Missing `og:url` when `baseUrl` is known | Generate from `baseUrl` + current route |
| Relative `og:image` / `twitter:image` | Prepend `baseUrl` to make it absolute |
| Missing `rel="noopener noreferrer"` on `target="_blank"` | Add the attribute |
| Missing `width`/`height` on `<img>` | Add `TODO` comment for human to fill in; set placeholder `0` only if explicitly confirmed |
| Missing `loading="lazy"` on below-fold images | Add `loading="lazy"` attribute |
| Render-blocking `<script>` without `defer` | Add `defer` attribute (warn: verify no script depends on synchronous execution) |
| Missing `<link rel="preconnect">` for detected origins | Insert into `<head>` |

**Not auto-fixed** (reported with guidance):
- Title / description content (requires copywriting)
- Canonical URL decisions (requires URL strategy)
- Structured data content (requires business data)
- `noindex` removals (requires human decision)
- Heading hierarchy changes (may affect visual design)

### 5. Generate report

Write to `<outputDir>/report.html` — self-contained HTML, no external dependencies.

**Summary header:**

```
Project:   my-app
Base URL:  https://example.com
Date:      2026-05-21 14:32
Pages scanned: 24

High priority:    9 issues
Medium priority: 14 issues
Low priority:     7 issues

Auto-fixed: 6
Needs review: 24
```

**Per-issue table:**

| Column | Description |
|---|---|
| Priority | High / Medium / Low |
| Category | Metadata / Structure / Links / Images / Crawlability / Structured data / Performance |
| File + line | Clickable path |
| Page / route | Affected URL |
| Issue | Plain-English description with the offending value |
| Fix guidance | What to do (and the applied fix if auto-fixed) |

Issues sorted High → Low within each category, grouped by page.

Also write `<outputDir>/report.json` with machine-readable results.

If `includeRuntime: true`, include a per-route Lighthouse JSON in `<outputDir>/lighthouse/`.

---

## Priority mapping

| Signal | Priority |
|---|---|
| Blocks indexing or crawling entirely | High |
| Reduces SERP visibility or click-through rate | Medium |
| Best practice / marginal impact | Low |

---

## Output structure

```
.seo/
  report.html
  report.json
  lighthouse/           ← only when includeRuntime: true
    index.json
    products__list.json
```

---

## Edge cases and constraints

- **CSR-rendered metadata**: `document.title` set via `useEffect` or `document.write` is invisible to static analysis — warn the user and recommend `includeRuntime: true`
- **Dynamic routes** (`[slug]`, `:id`): static analysis cannot resolve the actual metadata values — flag the template file and note that all instances should have unique, non-duplicate metadata
- **Duplicate metadata from shared layouts**: if a `<Head>` component is shared across pages without per-page overrides, flag the shared component as the likely source of duplicate issues
- **i18n / `hreflang`**: if the project has locale-prefixed routes but no `hreflang` tags, flag as Medium
- **Trailing slash inconsistency**: if some routes have trailing slashes and others do not (without a canonical or redirect), flag as Medium
- **HTTP vs HTTPS**: if `baseUrl` is HTTP, warn and flag all `og:image` absolute URLs as High
- **Monorepos**: if multiple apps are detected, ask which to audit before proceeding
- **Large sitemaps**: if the sitemap references more than 50,000 URLs, validate only the first 1,000 and note the limit

---

## Success criteria

- Every HTML-producing source file is scanned
- Each issue includes the exact file path, line number, and the offending value
- Fixes do not alter meaningful content, only markup and attributes
- Auto-fixes pass the existing test suite (run if one exists)
- `report.html` is self-contained and viewable without a server
- No false positives for intentional `noindex` pages, valid canonical configurations, or decorative images with correct `alt=""`
