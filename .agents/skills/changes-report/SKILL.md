---
name: changes-report
description: >
  After any skill runs and modifies the codebase, generates a human-readable
  change log that explains every modification in plain language pitched at the
  configured developer level (absolute-beginner, junior, senior) with links to
  authoritative further reading for each change type. Use when asked to explain
  what a skill changed, document changes, generate a changes report, or write a
  changelog for the team.
compatibility: >
  Requires Python 3.10+. Reads report JSON/MD files written by other skills.
  Git must be available for fallback change detection.
metadata:
  author: the-morning-bell
  version: "1.0"
---

## Overview

Document every skill-applied change with level-appropriate explanations and
links. Discovers skill output reports automatically, builds a structured change
inventory, generates explanations in the voice of the configured `devLevel`,
and writes a single `CHANGES.md` that a developer can open to understand what
changed, why, and where to learn more.

## Config (changes-report.config.json)

| Key | Default | Description |
|---|---|---|
| `devLevel` | `"junior"` | `"absolute-beginner"` \| `"junior"` \| `"senior"` |
| `outputFile` | `"CHANGES.md"` | Path to write the report (relative to project root) |
| `skills` | `["all"]` | Skills to include. `"all"` auto-discovers |
| `includeLinks` | `true` | Append further-reading links to each entry |
| `includeCode` | `true` | Include before/after code snippets |
| `autoReport` | `false` | When `true`, other skills invoke this skill after they run |
| `append` | `false` | Append to `outputFile` rather than overwrite |
| `groupBy` | `"skill"` | `"skill"` \| `"file"` \| `"category"` |

## Step 1 — Discover skill reports

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode discover \
  --config changes-report.config.json \
  --project-dir <path-to-project>
```

Scan for report files from all known skills:

| Skill | Report file |
|---|---|
| `accessibility` | `.accessibility/report.json` |
| `seo` | `.seo/report.json` |
| `security` | `.security/report.json` |
| `type-cleaner` | `type-cleaner-report.md` |
| `css-extract-variables` | `.css-variables/report.json` |
| `visual-regression` | `.visual-regression/report.json` |
| `bundle-sizes` | `.performance/bundle-report.json` |
| `lighthouse-tests` | `.performance/lighthouse-report.json` |
| `page-render` | `.performance/render-report.json` |
| `unified-mocks` | `.tdd/unified-mocks-report.md` |
| `test-conventions` | `.tdd/test-conventions-report.md` |
| `global-mocks` | `.tdd/global-mocks-report.md` |

If `skills` is a specific list, only read those skill reports.

If no report files are found, fall back to `git diff --name-only` and attempt
to match changed files to known skill output patterns. If still nothing, exit
with a clear message: "No skill outputs found. Run a skill with `--fix true` first."

## Step 2 — Build change inventory

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode inventory \
  --config changes-report.config.json \
  --project-dir <path-to-project>
```

Parse each discovered report and extract a normalised change record per entry:

```json
{
  "skill": "accessibility",
  "file": "src/components/Header.tsx",
  "line": 42,
  "changeType": "added-attribute",
  "attribute": "alt",
  "before": "<img src=\"/logo.png\" />",
  "after": "<img src=\"/logo.png\" alt=\"\" />",
  "reason": "WCAG 1.1.1 — Non-text content must have a text alternative",
  "severity": "critical",
  "links": {
    "spec": "https://www.w3.org/TR/WCAG21/#non-text-content",
    "mdn": "https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/alt",
    "beginner": "https://web.dev/articles/image-alt"
  }
}
```

Only include changes that were **actually applied** (fixed), not issues that
were reported but not auto-fixed. Read the `applied: true` / `autoFixed: true`
fields from skill JSON reports; for markdown reports, parse "✓ normalised" /
"created" / "promoted" markers.

Writes `.changes-report/inventory.json`.

## Step 3 — Generate explanations

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode explain \
  --config changes-report.config.json \
  --project-dir <path-to-project>
```

For each change record, produce an explanation block calibrated to `devLevel`.
Use the link library (Step 4) to select the right documentation URLs.

---

### `absolute-beginner` — ~200 words per entry

Define every term. Use real-world analogies. Focus on user impact. Link to
beginner-friendly sources first.

```markdown
### 📄 src/components/Header.tsx — line 42

**What changed**
An `alt` attribute was added to an image tag.

**What is an `alt` attribute?**
Every image on a webpage can have a short text description attached to it
called an "alt" (alternative) attribute. Screen readers — software used by
people who are visually impaired — read this text aloud instead of showing
the image. Think of it like a caption that only assistive technology can hear.

**Why was this changed?**
This image had no `alt` attribute at all, which means screen readers would
either skip it entirely or read out the raw filename ("logo-png"), which is
confusing and unhelpful.

**What this means for you**
The website is now more usable for people with visual impairments. This is
also required by accessibility laws in many countries (WCAG 2.1 Level A).

**What to do next**
The `alt` was set to `""` (empty) as a placeholder — this tells screen readers
the image is decorative. If the image conveys meaning (like a logo), change it
to a real description: `alt="Company logo"`.

**Learn more**
- [What is alt text? (web.dev)](https://web.dev/articles/image-alt)
- [How screen readers work (WebAIM)](https://webaim.org/techniques/screenreader/)
```

---

### `junior` — ~80 words per entry

Assume basic vocabulary. State the standard. One-liner action item. Canonical
docs first.

```markdown
### src/components/Header.tsx — line 42

**Change:** Added `alt=""` to decorative `<img>`

**Why:** WCAG 1.1.1 (Level A) requires every `<img>` to have an `alt`
attribute. An empty string is correct for decorative images — it signals screen
readers to skip the element. Omitting `alt` causes a fallback to the filename,
which is never useful.

**Action required:** If this image conveys meaning, replace `alt=""` with a
descriptive string.

**Further reading**
- [MDN: HTMLImageElement.alt](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/alt)
- [WCAG 1.1.1](https://www.w3.org/TR/WCAG21/#non-text-content)
```

---

### `senior` — ~30 words per entry

Terse peer note. Rule ID, precise rationale, trade-off if any. Spec link only.

```markdown
### src/components/Header.tsx:42

`alt=""` added — decorative image, WCAG 1.1.1 (A). Empty string correct;
omitted `alt` causes UA fallback to filename. Verify: if informational,
needs real description.

→ [WCAG 1.1.1](https://www.w3.org/TR/WCAG21/#non-text-content)
```

---

## Step 4 — Link library

The skill maintains an internal map of change types to documentation URLs
per dev level. Selected entries:

| Change type | Beginner | Junior / Canonical | Senior / Spec |
|---|---|---|---|
| Missing `alt` | web.dev/image-alt | MDN alt | WCAG 1.1.1 |
| Missing `lang` on `<html>` | web.dev/html-has-lang | MDN lang | WCAG 3.1.1 |
| Colour contrast | web.dev/color-contrast | MDN contrast | WCAG 1.4.3 |
| Missing meta description | web.dev/meta-description | MDN meta | Google Search docs |
| Open Graph tags | ogp.me beginner guide | ogp.me | Open Graph Protocol spec |
| Structured data (JSON-LD) | Google Search Docs intro | schema.org | JSON-LD spec |
| SQL injection | OWASP SQL intro | OWASP SQL Prevention | OWASP ASVS V5 |
| XSS (`innerHTML`) | OWASP XSS intro | OWASP XSS Prevention | OWASP ASVS V5 |
| Missing security headers | web.dev/security-headers | MDN CSP | RFC 7230 |
| Exposed secret | GitGuardian explainer | OWASP Secrets Management | NIST 800-57 |
| Missing `HttpOnly` cookie | OWASP cookie explainer | MDN Set-Cookie | RFC 6265 |
| JWT misconfiguration | Auth0 JWT intro | jwt.io | RFC 7519 |
| Bundle size regression | web.dev/reduce-javascript | webpack-bundle-analyzer | Chrome DevTools coverage |
| LCP regression | web.dev/lcp | MDN LCP | W3C PaintTiming spec |
| CLS regression | web.dev/cls | MDN CLS | W3C Layout Instability spec |
| TypeScript `any` | TypeScript Handbook intro | TypeScript `any` docs | TypeScript language spec |
| Duplicate type declaration | TypeScript Handbook utilities | TypeScript utility types | TypeScript Declaration Merging |
| CSS variable extraction | CSS-Tricks custom properties | MDN custom properties | CSS Custom Properties spec |
| Mock factory consolidation | — | Jest mocking docs | Testing Library guiding principles |
| Global mock promotion | — | Jest setupFiles docs | Vitest globalSetup docs |
| Test convention normalisation | — | Testing Library best practices | FIRST principles |
| `defer` added to `<script>` | web.dev/render-blocking | MDN script defer | HTML spec §4.12.1 |
| Missing `loading="lazy"` | web.dev/lazy-loading | MDN loading | HTML spec §4.8.3 |

For change types not in the map: generate the explanation, omit links rather
than linking to something irrelevant, and log the missing type to
`.changes-report/unknown-types.json` for future library additions.

## Step 5 — Write report

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode report \
  --config changes-report.config.json \
  --project-dir <path-to-project>
```

Write `outputFile` with this structure:

```markdown
# Changes Report
Generated: 2026-05-22 14:32  |  Level: junior  |  Skills: accessibility, seo, security

## Summary
- **Files modified:** 14
- **Changes applied:** 23
- **Skills:** accessibility (12), seo (8), security (3)

---

## Accessibility (12 changes)

### src/components/Header.tsx — line 42
...

---

## SEO (8 changes)

...

---

## Security (3 changes)

...
```

**`groupBy: "file"`** — all changes to a single file grouped together under one
heading, regardless of which skill made them (useful for code review).

**`groupBy: "category"`** — changes grouped as: Accessibility, Performance,
Security, Code Quality, Testing (maps multiple skills to a shared category).

**`append: true`** — prepend `---` divider and a new dated `## Run — <timestamp>`
heading before new entries; preserve all previous content.

Security reports: never reproduce the actual secret value or full vulnerability
payload — reference file and line only.

## Convenience: run the full pipeline

```bash
python3 .agents/skills/changes-report/scripts/runner.py \
  --mode run \
  --config changes-report.config.json \
  --project-dir <path-to-project>
```

Runs Steps 1–5 in sequence.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Output structure

```
CHANGES.md                       ← human-readable report (outputFile)
.changes-report/
  inventory.json                 ← structured change records (Step 2)
  unknown-types.json             ← change types not yet in the link library
```

## Dev level style guide

| | Absolute beginner | Junior | Senior |
|---|---|---|---|
| Tone | Encouraging, patient | Collegial, informative | Terse, peer-level |
| Terminology | Define every term | Assume basic vocab | No definitions |
| Code snippets | Before + after with annotations | Before + after | After only |
| Why it matters | Real-world user impact | Standards compliance | Rule ID only |
| Action item | Step-by-step | One-liner | Inline note |
| Links | 2–3 beginner-friendly first | 2–3 canonical first | 1–2 spec only |
| Entry length | ~200 words | ~80 words | ~30 words |

## Edge cases

- **No skill reports found**: check `git diff`; if still nothing, exit with
  "No skill outputs found. Run a skill with `--fix true` first."
- **Multiple skills modified the same file**: list all changes under one heading
  for that file regardless of `groupBy`, to avoid fragmented context
- **Markdown report only** (no JSON): parse "✓ normalised" / "created" /
  "promoted" markers; flag that JSON was missing for better future output
- **`devLevel` not set**: default to `junior`; note at the top of the report
  that the level can be configured in `changes-report.config.json`
- **Change type not in link library**: generate explanation, omit links, log to
  `unknown-types.json` — never link to something irrelevant
- **`append: true` with >500 existing entries**: warn and suggest archiving
  before appending
- **Sensitive data in security reports**: reference file and line only; never
  reproduce secret values or full vulnerability payloads in any explanation

## Success criteria

- Every applied change from every discovered skill has an entry in the report
- Explanations match `devLevel` in tone, length, and vocabulary
- All links are real, authoritative, and appropriate to the dev level
- No secret values or sensitive data appear in the report
- Report renders cleanly as markdown on GitHub and in any markdown viewer
- When `append: true`, previous entries are preserved intact
- Only applied fixes are reported — not issues flagged but not fixed
