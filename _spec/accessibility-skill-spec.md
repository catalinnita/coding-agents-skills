# Skill Spec: Accessibility Audit and Fix

## Goal

Scan the codebase for accessibility violations, report them with WCAG 2.1 criteria references and severity levels, and apply targeted fixes — from missing `alt` attributes to broken keyboard navigation — so the product is usable by people relying on assistive technology.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "run an accessibility audit"
- "fix accessibility issues"
- "check WCAG compliance"
- "make this accessible"
- "add aria labels / alt text"
- "check keyboard navigation"
- "improve screen reader support"

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob, directory, or URL path to audit (default: entire project source) |
| `level` | No | WCAG conformance level: `A`, `AA` (default), or `AAA` |
| `fix` | No | `true` to apply auto-fixable issues; `false` (default) to report only |
| `includeRuntime` | No | `true` to also run axe-core against the live dev server (default: `false`) |
| `serveCommand` | No | Dev server command — required when `includeRuntime: true` |
| `port` | No | Port for the dev server (default: `3000`) |
| `routes` | No | URL paths to test when `includeRuntime: true` (default: auto-discovered) |
| `ignore` | No | Array of WCAG criteria IDs or rule names to suppress (e.g. `["color-contrast"]`) |
| `outputDir` | No | Where to write the report (default: `.accessibility/`) |

---

## Behavior

### 1. Pre-flight checks

- Confirm the working directory contains a recognisable project (looks for `package.json`, HTML files, or a framework config)
- Detect the framework: Next.js, React, Vue, Angular, Svelte, plain HTML — determines which static analysis rules apply
- If `fix: true`, confirm there are no uncommitted changes (or warn and ask) — fixes will modify source files
- If `includeRuntime: true`, verify a dev server can be started and that Playwright or Puppeteer is available

### 2. Static analysis (always runs)

Scan source files for violations without executing the app.

**Files scanned by type:**

| File type | What is checked |
|---|---|
| `.html`, `.htm` | All rules below applied directly |
| `.jsx`, `.tsx`, `.vue`, `.svelte` | JSX/template-aware parsing; attributes mapped to their HTML equivalents |
| `.css`, `.scss`, `.less` | Color contrast of hardcoded color pairs; `outline: none` / `outline: 0` without `:focus-visible` replacement |

**Checks performed:**

**Images and media**
- `<img>` missing `alt` attribute → WCAG 1.1.1 (Level A)
- `<img alt="">` used on non-decorative images → WCAG 1.1.1
- `<svg>` missing `aria-label` or `<title>` when not `aria-hidden` → WCAG 1.1.1
- `<video>` missing `<track kind="captions">` → WCAG 1.2.2 (Level A)
- `<audio>` missing transcript link → WCAG 1.2.1 (Level A)

**Color and contrast**
- Hardcoded foreground/background color pairs with contrast ratio below 4.5:1 (normal text) or 3:1 (large text / UI components) → WCAG 1.4.3 (Level AA)
- `color: inherit` or CSS variables resolved when possible; flag unresolvable pairs as warnings
- `outline: none` / `outline: 0` on interactive elements without an equivalent `:focus-visible` style → WCAG 2.4.7 (Level AA)

**Structure and semantics**
- Missing `<html lang="...">` attribute → WCAG 3.1.1 (Level A)
- Multiple `<h1>` elements per page → WCAG 1.3.1 (Level A)
- Skipped heading levels (e.g. `<h2>` directly followed by `<h4>`) → WCAG 1.3.1
- Missing `<main>`, `<nav>`, `<header>`, `<footer>` landmarks → WCAG 1.3.1
- `<div>` or `<span>` used as interactive elements without `role`, `tabindex`, and keyboard handlers → WCAG 4.1.2 (Level A)
- Empty `<button>` or `<a>` (no text content, no `aria-label`) → WCAG 4.1.2
- `<a>` used as button (`href="#"` or `href="javascript:void"` with `onClick`) → WCAG 4.1.2
- Form `<input>` missing associated `<label>` (via `for`/`id`, wrapping, or `aria-label`) → WCAG 1.3.1
- Form `<input>` with `type="image"` missing `alt` → WCAG 1.1.1
- `<table>` missing `<caption>` or `scope` on `<th>` → WCAG 1.3.1
- `<iframe>` missing `title` → WCAG 4.1.2

**ARIA**
- Invalid `role` values → WCAG 4.1.2
- ARIA attributes on elements whose role prohibits them (`aria-*` on `<meta>`, `<script>`) → WCAG 4.1.2
- `aria-required`, `aria-invalid`, `aria-expanded`, `aria-controls` referencing non-existent IDs → WCAG 1.3.1
- `aria-hidden="true"` on a focused element → WCAG 4.1.2
- `role="presentation"` or `role="none"` on interactive elements → WCAG 4.1.2

**Keyboard and focus**
- `tabindex` values greater than `0` (disrupts natural focus order) → WCAG 2.4.3 (Level A)
- Interactive elements reachable only via mouse events (`onMouseOver`, `onMouseEnter`) without keyboard equivalents → WCAG 2.1.1 (Level A)
- Modal dialogs without focus trap logic (`react-focus-lock`, `@radix-ui/dialog`, or manual implementation) → WCAG 2.1.2 (Level A)
- `onKeyDown` handlers that do not handle both `Enter` and `Space` for button-like elements → WCAG 2.1.1

**Timing**
- `setTimeout` / `setInterval` used to auto-dismiss UI without a pause/stop mechanism → WCAG 2.2.1 (Level A)

### 3. Runtime analysis (when `includeRuntime: true`)

Start the dev server, then for each route:

1. Launch a headless Chromium browser with axe-core injected
2. Navigate to the route, wait for network idle
3. Run `axe.run()` and collect violations
4. Run a keyboard-only simulation: Tab through all interactive elements, verify each is reachable and visually focused
5. Check color contrast at runtime (resolves CSS variables and computed styles)
6. Capture a screenshot of each page annotated with violation bounding boxes

### 4. Fix phase (when `fix: true`)

Apply only violations that have a deterministic, safe fix. Never modify logic — only markup, attributes, and styles.

**Auto-fixable:**

| Violation | Fix applied |
|---|---|
| Missing `alt` on `<img>` | Add `alt=""` and flag for human review with a `TODO` comment |
| Missing `lang` on `<html>` | Add `lang="en"` (warn: may need localisation) |
| `tabindex > 0` | Set to `tabindex="0"` |
| Empty `<button>` with adjacent icon | Add `aria-label` derived from the icon component name or filename |
| `outline: none` without `:focus-visible` | Append a `:focus-visible` rule restoring the browser default outline |
| Missing `<label>` for a named `<input>` | Wrap `<input>` in a `<label>` element and move any adjacent text node inside |
| Skipped heading level | Flag with `TODO` comment; do not auto-change heading levels as it may alter semantics |

**Not auto-fixed** (reported with guidance):
- Color contrast issues (requires design decision)
- Missing captions/transcripts (requires content)
- Complex keyboard navigation issues (requires logic changes)
- Ambiguous `alt` text (requires human judgment)

### 5. Generate report

Write to `<outputDir>/report.html` — self-contained HTML, no external dependencies.

**Summary header:**

```
Project:   my-app
Standard:  WCAG 2.1 Level AA
Date:      2026-05-21 14:32
Files scanned: 84

Critical (Level A):   12 violations
Serious  (Level AA):   8 violations
Moderate:              5 violations
Minor:                 3 violations

Auto-fixed: 7
Needs review: 21
```

**Per-violation table:**

| Column | Description |
|---|---|
| Severity | Critical / Serious / Moderate / Minor |
| WCAG criterion | e.g. `1.1.1 Non-text Content (A)` |
| File + line | Clickable path |
| Element | Offending HTML snippet |
| Issue | Plain-English description |
| Fix guidance | What to do (and the applied fix if auto-fixed) |

Violations grouped by file, sorted critical → minor within each file.

Also write `<outputDir>/report.json` with machine-readable results.

If `includeRuntime: true`, include annotated screenshots for each route in `<outputDir>/screenshots/`.

---

## Severity mapping

| WCAG Level | Skill severity |
|---|---|
| A (must) — blocks assistive technology | Critical |
| AA (should) — common support requirement | Serious |
| AAA (may) — best practice | Minor |
| Heuristic (not in WCAG but harmful) | Moderate |

---

## Output structure

```
.accessibility/
  report.html
  report.json
  screenshots/         ← only when includeRuntime: true
    index.png
    products__list.png
```

---

## Edge cases and constraints

- **CSS variables and `currentColor`**: resolve where possible; flag as "contrast unverifiable" when the computed value cannot be determined statically
- **Dynamic content** (items rendered only after interaction): static analysis cannot find these — recommend `includeRuntime: true` and guide the user to include routes that trigger dynamic states
- **Third-party iframes** (ads, embeds): flag but mark as "vendor responsibility"; do not attempt to fix
- **`aria-label` vs visible text**: if an element has both visible text and `aria-label`, warn when they diverge by more than minor punctuation (violates WCAG 2.5.3 Label in Name, Level A)
- **SVG sprites**: if `<use>` references an external file, flag for manual review; symbol titles cannot be statically resolved
- **Server components (Next.js App Router)**: parse `.tsx` files but note that some attributes are controlled at runtime — annotate accordingly
- **Monorepos**: if multiple apps are detected, ask the user which to audit before proceeding
- **Dark mode**: if the project has a dark-mode theme, run contrast checks against both color schemes

---

## Success criteria

- Every source file in scope is scanned
- Each violation is mapped to a specific WCAG criterion with level and a plain-English description
- Auto-fixes do not break any existing tests (run the test suite after fixing, if one exists)
- `report.html` is self-contained and opens correctly in a browser without a server
- No false positives for `aria-hidden` decorative elements, `alt=""` intentionally empty images, or valid ARIA patterns
