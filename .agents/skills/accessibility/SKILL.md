---
name: accessibility
description: >
  Audits the codebase for WCAG 2.1 accessibility violations — missing alt text,
  broken keyboard navigation, colour contrast failures, invalid ARIA, and more —
  then applies safe targeted fixes and produces a severity-ranked HTML report.
  Use when asked to run an accessibility audit, fix accessibility issues, check
  WCAG compliance, add aria labels, or improve screen reader support.
compatibility: >
  Requires Python 3.10+. Runtime analysis requires Node.js and Playwright
  (installed automatically via PEP 723 inline metadata).
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Audit and fix WCAG 2.1 accessibility violations in a codebase. Scans source
files statically for violations mapped to specific WCAG criteria, optionally
runs axe-core against the live dev server for runtime violations, applies safe
auto-fixes, and writes a self-contained HTML report.

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to audit. Default: entire project source |
| `level` | No | WCAG conformance level: `A`, `AA` (default), or `AAA` |
| `fix` | No | `true` to apply auto-fixable issues. Default: `false` (report only) |
| `includeRuntime` | No | `true` to run axe-core against the live dev server. Default: `false` |
| `serveCommand` | No | Dev server command — required when `includeRuntime: true` |
| `port` | No | Dev server port. Default: `3000` |
| `routes` | No | URL paths to test when `includeRuntime: true`. Default: auto-discovered |
| `ignore` | No | Array of WCAG criterion IDs or rule names to suppress |
| `outputDir` | No | Output directory. Default: `.accessibility/` |

## Step 1 — Resolve config and pre-flight checks

Look for config in this order:
1. `.accessibility.config.json` in the project root
2. Built-in defaults

Run pre-flight checks:

```bash
python3 .agents/skills/accessibility/scripts/runner.py \
  --mode preflight \
  --project-dir <path-to-project>
```

Checks performed:
- Project contains recognisable source files (HTML, JSX/TSX, Vue, Svelte)
- Detect framework: Next.js, React, Vue, Angular, Svelte, plain HTML
- If `fix: true` — confirm no uncommitted changes or ask for confirmation
- If `includeRuntime: true` — verify Playwright is available (`python3 -m playwright --version`); install if missing: `playwright install chromium`
- If multiple `package.json` files detected (monorepo) — ask user which app to audit

## Step 2 — Static analysis

Scan source files without executing the app:

```bash
python3 .agents/skills/accessibility/scripts/runner.py \
  --mode analyze \
  --project-dir <path-to-project>
```

**Files scanned:**

| File type | How |
|---|---|
| `.html`, `.htm` | Direct HTML parsing |
| `.jsx`, `.tsx`, `.vue`, `.svelte` | JSX/template-aware — attributes mapped to HTML equivalents |
| `.css`, `.scss`, `.less` | Color contrast of hardcoded pairs; `outline: none` without `:focus-visible` |

**Checks by category:**

*Images and media (WCAG 1.1.1 A, 1.2.1 A, 1.2.2 A)*
- `<img>` missing `alt`; decorative images using non-empty `alt`
- `<svg>` missing `aria-label` or `<title>` when not `aria-hidden`
- `<video>` missing `<track kind="captions">`; `<audio>` missing transcript link

*Colour and contrast (WCAG 1.4.3 AA, 2.4.7 AA)*
- Hardcoded colour pairs below 4.5:1 (normal text) or 3:1 (large text / UI)
- `outline: none` / `outline: 0` on interactive elements without `:focus-visible` replacement

*Structure and semantics (WCAG 1.3.1 A, 3.1.1 A, 4.1.2 A)*
- Missing `<html lang>`; multiple `<h1>`; skipped heading levels
- Missing landmark elements (`<main>`, `<nav>`, `<header>`, `<footer>`)
- `<div>` / `<span>` used as interactive elements without `role`, `tabindex`, and keyboard handlers
- Empty `<button>` or `<a>`; `<a>` used as button; unlabelled form `<input>`
- `<table>` missing `<caption>` or `scope` on `<th>`; `<iframe>` missing `title`

*ARIA (WCAG 4.1.2 A, 1.3.1 A)*
- Invalid `role` values; prohibited ARIA attributes on element roles
- `aria-controls`, `aria-labelledby`, `aria-describedby` referencing non-existent IDs
- `aria-hidden="true"` on a focused element; `role="presentation"` on interactive elements

*Keyboard and focus (WCAG 2.1.1 A, 2.1.2 A, 2.4.3 A, 2.4.7 AA)*
- `tabindex > 0`; mouse-only event handlers without keyboard equivalents
- Modal dialogs without focus trap logic
- `onKeyDown` handlers missing `Enter` / `Space` handling for button-like elements

*Timing (WCAG 2.2.1 A)*
- `setTimeout` / `setInterval` auto-dismissing UI without a pause/stop mechanism

Writes `<outputDir>/static-violations.json`.

## Step 3 — Runtime analysis (when `includeRuntime: true`)

Start the dev server, then for each route run axe-core and a keyboard simulation:

```bash
python3 .agents/skills/accessibility/scripts/runner.py \
  --mode runtime \
  --project-dir <path-to-project>
```

Per route:
1. Launch headless Chromium, navigate to route, wait for network idle
2. Inject and run `axe.run()` — collect violations with WCAG criterion references
3. Simulate keyboard-only navigation: Tab through all interactive elements, verify each is reachable and has a visible focus indicator
4. Check colour contrast at runtime (resolves CSS variables and computed styles)
5. Capture annotated screenshot with violation bounding boxes

Writes `<outputDir>/runtime-violations.json` and `<outputDir>/screenshots/<route-slug>.png`.

## Step 4 — Fix phase (when `fix: true`)

Apply only violations with a deterministic, safe fix. Never modify logic — only markup, attributes, and styles:

```bash
python3 .agents/skills/accessibility/scripts/runner.py \
  --mode fix \
  --project-dir <path-to-project>
```

**Auto-fixable:**

| Violation | Fix applied |
|---|---|
| Missing `alt` on `<img>` | Add `alt=""` + `<!-- TODO: add descriptive alt text -->` |
| Missing `lang` on `<html>` | Add `lang="en"` (warn: may need localisation) |
| `tabindex > 0` | Set to `tabindex="0"` |
| Empty `<button>` with adjacent icon | Add `aria-label` derived from icon component name |
| `outline: none` without `:focus-visible` | Append `:focus-visible` rule restoring browser default |
| Missing `<label>` for named `<input>` | Wrap in `<label>`, move adjacent text inside |

**Not auto-fixed** (reported with guidance): colour contrast, missing captions/transcripts, complex keyboard navigation, ambiguous `alt` text.

If a test suite exists, run it after fixing and report any failures.

## Step 5 — Generate report

```bash
python3 .agents/skills/accessibility/scripts/runner.py \
  --mode report \
  --project-dir <path-to-project>
```

Writes `<outputDir>/report.html` — **self-contained** HTML (no external dependencies):

```
Project:   my-app
Standard:  WCAG 2.1 Level AA
Date:      2026-05-22

Files scanned: 84

Critical (Level A):   12 violations
Serious  (Level AA):   8 violations
Moderate:              5 violations
Minor:                 3 violations

Auto-fixed: 7   Needs review: 21
```

Per-violation table: severity, WCAG criterion, file + line (clickable), offending HTML snippet, plain-English description, fix guidance. Sorted Critical → Minor, grouped by file.

Also writes `<outputDir>/report.json`.

## Convenience: run the full pipeline

```bash
python3 .agents/skills/accessibility/scripts/runner.py \
  --mode run \
  --project-dir <path-to-project>
```

Runs Steps 1–5 in sequence.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Severity mapping

| WCAG level | Skill severity |
|---|---|
| A (must) — blocks assistive technology | Critical |
| AA (should) — common support requirement | Serious |
| AAA (may) — best practice | Minor |
| Heuristic (not in WCAG but harmful) | Moderate |

## Output structure

```
.accessibility/
  static-violations.json
  runtime-violations.json    ← only when includeRuntime: true
  report.html                ← open this
  report.json
  screenshots/               ← only when includeRuntime: true
    index.png
    products__list.png
```

## Edge cases

- **CSS variables / `currentColor`**: resolve where possible; flag as "contrast unverifiable" when undeterminable statically
- **Dynamic content**: static analysis cannot find elements rendered only after interaction — recommend `includeRuntime: true` for routes that trigger dynamic states
- **Third-party iframes** (ads, embeds): flag but mark "vendor responsibility"; do not fix
- **`aria-label` vs visible text divergence**: warn when they differ beyond minor punctuation (WCAG 2.5.3 Label in Name, Level A)
- **SVG sprites via `<use>`**: flag for manual review — symbol titles cannot be statically resolved
- **Next.js App Router server components**: parse `.tsx` but note some attributes are runtime-controlled
- **Dark mode**: if project has a dark-mode theme, run contrast checks against both colour schemes
- **Monorepo**: ask which app before proceeding

## Success criteria

- Every source file in scope is scanned
- Each violation is mapped to a WCAG criterion with level and plain-English description
- Auto-fixes do not break any existing tests
- `report.html` is self-contained and opens without a server
- No false positives for `aria-hidden` decorative elements, intentional `alt=""`, or valid ARIA patterns
