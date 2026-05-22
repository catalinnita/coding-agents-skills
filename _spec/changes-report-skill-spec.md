# Skill Spec: Changes Report

## Goal

After any skill runs and modifies the codebase, generate a human-readable
change log that explains every modification in plain language pitched exactly
at the configured developer level — from absolute beginner through to senior
engineer — with links to authoritative further reading for each change type.

The report is the single place a developer can open to understand not just
*what* changed, but *why* it changed, *what it means for them*, and *where to
learn more*.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "explain what the last skill changed"
- "document the changes"
- "generate a changes report"
- "explain these changes for a junior / beginner / senior"
- "why did the accessibility / SEO / security / type-cleaner / ... skill change X"
- "write a changelog for the team"

Also invoked automatically as a final step by any other skill that makes file
edits when `autoReport: true` is set in config.

---

## Inputs

Read from `changes-report.config.json` at the project root.

| Config key | Default | Description |
|---|---|---|
| `devLevel` | `"junior"` | `"absolute-beginner"` \| `"junior"` \| `"senior"` |
| `outputFile` | `"CHANGES.md"` | Path to write the report (relative to project root) |
| `skills` | `["all"]` | Which skill outputs to include. `"all"` auto-discovers |
| `includeLinks` | `true` | Append further-reading links to each entry |
| `includeCode` | `true` | Include before/after code snippets |
| `autoReport` | `false` | If `true`, other skills invoke this automatically after they run |
| `append` | `false` | Append to `outputFile` instead of overwriting |
| `groupBy` | `"skill"` | `"skill"` \| `"file"` \| `"category"` |

---

## Behavior

### Step 1 — Discover skill runs

Scan for report outputs from all known skills, in the directories they write to
by default, and in the project root:

| Skill | Report file(s) to read |
|---|---|
| `accessibility` | `.accessibility/report.json` |
| `seo` | `.seo/report.json` |
| `security` | `.security/report.json` |
| `type-cleaner` | `type-cleaner-report.md` (parse change entries) |
| `css-extract-variables` | `.css-variables/report.json` (if present) |
| `visual-regression` | `.visual-regression/report.json` |
| `bundle-sizes` | `.performance/bundle-report.json` |
| `lighthouse-tests` | `.performance/lighthouse-report.json` |
| `page-render` | `.performance/render-report.json` |
| `unified-mocks` | `.tdd/unified-mocks-report.md` (parse change entries) |
| `test-conventions` | `.tdd/test-conventions-report.md` (parse change entries) |
| `global-mocks` | `.tdd/global-mocks-report.md` (parse change entries) |

If `skills` is set to a specific list, only read those skills' reports.

For each report found, extract:
- The list of files modified
- The type of change made (e.g. "added `alt` attribute", "removed duplicate mock")
- The reason the skill made the change (the violation or finding that triggered it)
- The severity / priority (if the report includes one)

If no reports are found, check the git working tree for uncommitted changes
(`git diff --name-only`) and attempt to match changed files to known skill
output patterns.

### Step 2 — Build the change inventory

Produce a structured list of every change across all discovered skills:

```json
[
  {
    "skill": "accessibility",
    "file": "src/components/Header.tsx",
    "line": 42,
    "changeType": "added-attribute",
    "attribute": "alt",
    "element": "<img src=\"/logo.png\">",
    "before": "<img src=\"/logo.png\" />",
    "after": "<img src=\"/logo.png\" alt=\"\" />",
    "reason": "WCAG 1.1.1 — Non-text content must have a text alternative",
    "severity": "critical",
    "links": {
      "spec": "https://www.w3.org/TR/WCAG21/#non-text-content",
      "mdn": "https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/alt",
      "beginner": "https://web.dev/image-alt/"
    }
  },
  ...
]
```

### Step 3 — Generate level-appropriate explanations

For each change, produce an explanation block calibrated to `devLevel`.

---

#### `absolute-beginner`

Write as if explaining to someone who is comfortable reading code but new to
web development. Define every technical term. Use analogies. Focus on real-world
impact for the user of the website.

Template structure:
```
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
The `alt` was set to `""` (empty) as a placeholder — this tells screen
readers the image is decorative. If the image conveys meaning (like a logo),
change it to a real description: `alt="Company logo"`.

**Learn more**
- [What is alt text? (web.dev — beginner-friendly)](https://web.dev/image-alt/)
- [How screen readers work (WebAIM)](https://webaim.org/techniques/screenreader/)
```

---

#### `junior`

Write for someone who understands HTML, CSS, and basic JavaScript. Explain the
principle or pattern, mention common mistakes, skip definitions of basic terms.

Template structure:
```
### src/components/Header.tsx — line 42

**Change:** Added `alt=""` to decorative `<img>`

**Why:** WCAG 1.1.1 (Level A) requires every `<img>` to have an `alt`
attribute. An empty string (`alt=""`) is the correct value for purely
decorative images — it signals to screen readers to skip the element entirely.
Using no `alt` at all causes screen readers to fall back to the filename, which
is never useful.

**Action required:** If this image conveys meaning to sighted users, replace
`alt=""` with a descriptive string. If it is purely decorative, leave it as is.

**Further reading**
- [MDN: HTMLImageElement.alt](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/alt)
- [WCAG 1.1.1 Non-text Content](https://www.w3.org/TR/WCAG21/#non-text-content)
- [WebAIM: Appropriate use of alternative text](https://webaim.org/techniques/alttext/)
```

---

#### `senior`

Write as a terse peer review note. State what changed, the precise rationale
(standard, version, rule ID), any trade-offs, and a link to the authoritative
spec. No definitions, no hand-holding.

Template structure:
```
### src/components/Header.tsx:42

`alt=""` added to decorative `<img>`. WCAG 1.1.1 (A) — empty string is
correct for decorative images; omitted `alt` causes UA fallback to filename.
Verify intent: if image is informational, alt needs a real description.

→ [WCAG 1.1.1](https://www.w3.org/TR/WCAG21/#non-text-content)
  [MDN alt](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/alt)
```

---

### Step 4 — Link library

Each change type has a canonical set of links. The skill maintains an internal
map of change types to documentation sources:

| Change type | Beginner link | Junior/Canonical | Senior/Spec |
|---|---|---|---|
| Missing `alt` attribute | web.dev/image-alt | MDN alt | WCAG 1.1.1 |
| Missing `lang` on `<html>` | web.dev/html-has-lang | MDN lang | WCAG 3.1.1 |
| Colour contrast | web.dev/color-contrast | MDN contrast | WCAG 1.4.3 |
| Missing meta description | web.dev/meta-description | MDN meta | Google Search docs |
| Open Graph tags | ogp.me beginner guide | ogp.me | Open Graph Protocol spec |
| Structured data | Google Search Docs intro | schema.org | JSON-LD spec |
| SQL injection | OWASP SQL intro | OWASP SQL Prevention | OWASP ASVS |
| XSS | OWASP XSS intro | OWASP XSS Prevention | OWASP ASVS |
| Missing security headers | web.dev/security-headers | MDN CSP | RFC 7230 |
| Exposed secret | GitGuardian explainer | OWASP Secrets Management | NIST 800-57 |
| Bundle size regression | web.dev/reduce-javascript | webpack-bundle-analyzer | Chrome DevTools coverage |
| LCP regression | web.dev/lcp | MDN LCP | W3C PaintTiming spec |
| CLS regression | web.dev/cls | MDN CLS | W3C Layout Instability spec |
| TypeScript `any` | TypeScript Handbook intro | TypeScript `any` docs | TypeScript spec |
| Duplicate type declaration | — | TypeScript utility types | TypeScript Declaration Merging spec |
| CSS variable extraction | CSS-Tricks custom properties | MDN custom properties | CSS Custom Properties spec |
| Mock factory consolidation | — | Jest mocking docs | Testing Library guiding principles |
| Global mock setup | — | Jest setupFiles docs | Vitest globalSetup docs |
| Test convention normalisation | — | Testing Library best practices | FIRST principles |

For change types not in the map, the skill generates a generic explanation and
omits specific links rather than linking to irrelevant pages.

### Step 5 — Write report

Write `outputFile` (default `CHANGES.md`) with this structure:

```markdown
# Changes Report
Generated: 2026-05-22 14:32  |  Developer level: junior  |  Skills: accessibility, seo, security

## Summary
- **Files modified:** 14
- **Changes applied:** 23
- **Skills that ran:** accessibility (12 changes), seo (8 changes), security (3 changes)

---

## Accessibility changes (12)

### src/components/Header.tsx — line 42
...level-appropriate explanation...

### src/pages/about.tsx — line 18
...

---

## SEO changes (8)

...

---

## Security changes (3)

...
```

When `groupBy: "file"` is set, all changes to a single file are grouped
together regardless of which skill made them — useful for code review.

When `groupBy: "category"` is set, changes are grouped by the type of issue
(accessibility, performance, security, code quality) across all skills.

When `append: true`, prepend a `---` divider and a new dated header before
the new entries rather than overwriting the file.

---

## Further reading: link selection rules

- Always prefer the official specification as the canonical link for `senior`
- For `junior`, prefer MDN, official framework docs, or the relevant standards body
- For `absolute-beginner`, prefer web.dev, CSS-Tricks, or WebAIM — sources that
  teach concepts with examples rather than specifying behaviour
- Never link to Stack Overflow or blog posts as the primary reference
- If a change involves a security vulnerability, always include the OWASP link
  regardless of dev level — security context is non-negotiable

---

## Output structure

```
CHANGES.md                    ← human-readable report (outputFile)
changes-report.config.json    ← config (project root)
```

---

## Edge cases

- **No skill reports found**: check `git diff` for changed files; if still nothing,
  report "No skill outputs found. Run a skill with `--fix true` first."
- **Multiple skills modified the same file**: list all changes to that file under
  one heading (regardless of `groupBy`) to avoid fragmented per-file context
- **Report JSON missing but MD report exists**: parse the markdown report to
  extract change entries; flag that the JSON was missing so future runs produce
  better output
- **`devLevel` not set**: default to `junior`; log a note at the top of the report
  suggesting the user configure their level for more relevant explanations
- **Change has no matching link in the library**: generate the explanation but
  omit the links section rather than linking to something irrelevant; log the
  missing change type so it can be added to the library
- **`append: true` with a very large existing file** (>500 entries): warn the user
  and suggest archiving the old file before appending
- **Sensitive information in security reports**: never reproduce the actual secret
  value or full vulnerability payload in the explanations; reference the file and
  line only

---

## Dev level explanation style guide

| | Absolute beginner | Junior | Senior |
|---|---|---|---|
| **Tone** | Encouraging, patient | Collegial, informative | Terse, peer-level |
| **Terminology** | Define every term | Assume basic vocab | No definitions |
| **Code snippets** | Before/after with annotations | Before/after | After only |
| **Why it matters** | Real-world user impact | Standards compliance | Rule ID only |
| **What to do next** | Step-by-step | One-liner action | Inline note |
| **Link count** | 2–3 (beginner-friendly first) | 2–3 (canonical first) | 1–2 (spec only) |
| **Entry length** | ~200 words | ~80 words | ~30 words |

---

## Success criteria

- Every file changed by any discovered skill has at least one entry in the report
- Explanations match the configured `devLevel` in tone, length, and vocabulary
- All links are to real, authoritative sources appropriate to the dev level
- No secret values, full vulnerability payloads, or sensitive data appear in the report
- Report opens and reads cleanly as plain markdown (renders correctly on GitHub)
- When `append: true`, previous entries are preserved intact
- The report accurately reflects only changes that were actually applied — not
  issues that were reported but not fixed
