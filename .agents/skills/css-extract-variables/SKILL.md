---
name: css-extract-variables
description: >
  Scans all CSS/SCSS files in a repo, extracts hardcoded values (colors, spacing, typography, radii, shadows, z-index, transitions) into CSS custom properties, and replaces every occurrence with a variable reference. Supports format and unit normalization, perceptual color merging, grid and scale snapping to keep variable counts below a configurable cap, and dry-run mode. Use when asked to extract CSS variables, replace hardcoded values with CSS vars, refactor CSS to use custom properties, or tokenize CSS design values.
compatibility: Requires Python 3.10+. Colour distance requires the `colormath` package (installed automatically via PEP 723 inline metadata in the script).
metadata:
  author: the-morning-bell
  version: "1.1"
---

## Overview

Extract hardcoded CSS values into CSS custom properties across an entire codebase, with optional normalization, approximation, and a configurable variable-count cap.

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | Path to scan (default: entire repo) |
| `types` | No | Value types: `colors`, `spacing`, `typography`, `radii`, `shadows`, `z-index`, `transitions`, `all` (default: `all`) |
| `output` | No | File to write variables to (default: auto-detected, see Step 4) |
| `threshold` | No | Minimum occurrences before a value is extracted (default: `2`) |
| `dryRun` | No | Preview changes without writing any files (default: `false`) |
| `prefix` | No | Custom property name prefix, e.g. `--brand` (default: `--`) |
| `normalize` | No | Format and unit unification rules — see Normalization rules below |
| `approximate` | No | Snapping and rounding rules to cap variable count — see Approximation rules below |

## Step 1 — Resolve config

Look for a config file in this order:
1. Path passed explicitly by the user
2. `css-extract-variables.config.json` in the project root
3. Built-in defaults

Merge user config on top of defaults. Surface the resolved config to the user and ask for confirmation before proceeding when `dryRun` is `false`.

**Defaults**

```json
{
  "target": ".",
  "output": "auto",
  "prefix": "--",
  "threshold": 2,
  "dryRun": false,
  "types": ["colors", "spacing", "typography", "radii", "shadows", "z-index", "transitions"],
  "exclude": ["node_modules", "dist", "build", ".git"],
  "extensions": [".css", ".scss", ".sass", ".less", ".module.css", ".module.scss"],
  "scss": false
}
```

## Step 2 — Discover files

Run the extractor script in **scan-only** mode to list every file that will be processed:

```bash
python3 .agents/skills/css-extract-variables/scripts/extractor.py \
  --config <resolved-config-path> \
  --mode scan
```

**Discovery rules:**
- Recursively find all files matching `extensions`
- Exclude any directory in `exclude`, paths matched by `.gitignore`, and hidden directories (leading `.`)
- Report total file count to the user before continuing

## Step 3 — Extract and approximate

Run the extractor in **extract** mode. This parses all discovered files, normalizes values (if configured), applies approximation/snapping (if configured), deduplicates, and produces an extraction plan without writing any files:

```bash
python3 .agents/skills/css-extract-variables/scripts/extractor.py \
  --config <resolved-config-path> \
  --mode extract \
  --output-plan extraction-plan.json
```

### Parsing rules

The extractor reads CSS declarations of the form `property: value` and extracts tokens by type. Values inside comments and existing `var(--…)` references are never extracted.

**Colors** — extracted from any property:
- Hex: `#fff`, `#ffffff`, `#ff0000cc`
- RGB/RGBA: `rgb(255, 0, 0)`, `rgba(0,0,0,0.5)`
- HSL/HSLA: `hsl(200, 100%, 50%)`, `hsla(…)`
- Named: `red`, `blue`, etc. — skip `currentColor`, `inherit`, `transparent`

**Spacing** — extracted only from: `margin`, `padding`, `gap`, `width`, `height`, `top`, `right`, `bottom`, `left`, `inset` (and their longhand variants):
- Units: `px`, `rem`, `em`, `%`, `vh`, `vw`, `ch`, `ex`

**Typography** — extracted from: `font-size`, `font-weight`, `font-family`, `line-height`, `letter-spacing`

**Radii** — extracted from: `border-radius` and all four corner longhands

**Shadows** — extracted from: `box-shadow`, `text-shadow` — full value string treated as one atomic token

**Z-index** — numeric values from `z-index`

**Transitions** — time values (`ms`, `s`) from `transition-duration` and `animation-duration`; timing function strings from `transition-timing-function`

### Normalization rules

When `normalize` is configured, values are converted to a canonical format or unit **before** deduplication. This ensures `#fff`, `rgb(255,255,255)`, and `white` collapse into one variable.

**Colors** — `normalize.colors.targetFormat`: `hex` | `hsl` | `rgb` | `oklch`
- All parsed colors are converted to the target format
- Alpha is preserved (`rgba(0,0,0,0.5)` → `hsl(0 0% 0% / 0.5)`)
- Named colors are resolved to RGB first, then converted
- Short hex `#fff` is expanded to `#ffffff` before conversion
- If target is `hex` and the color has an alpha channel, fall back to `rgba`
- Precision for `hsl` and `oklch`: `normalize.colors.precision` decimal places (default: `2`)

**Spacing / radii** — `normalize.spacing.targetUnit` / `normalize.radii.targetUnit`: `px` | `rem` | `em`
- `px` ↔ `rem`: divided or multiplied by `baseFontSize` (default: `16`)
- `em` → `rem`: converted 1:1; always emit a warning that `em` is context-dependent
- `%`, `vh`, `vw`, `ch`, `ex`: cannot be converted — left unchanged, reported as skipped
- Values inside `calc()` are converted term by term where possible; mixed-unit `calc()` is left intact

**Typography** — `normalize.typography.fontSize.targetUnit` etc., same unit rules as spacing above:
- `line-height`: unitless values (e.g. `1.5`) are left as-is
- `letter-spacing`: follows spacing rules

**Durations** — `normalize.transitions.duration.targetUnit`: `ms` | `s`
- `ms` ↔ `s`: multiply or divide by 1000, round to 2 decimal places for `s`

**Pipeline order:** parse → normalize → approximate → deduplicate → name → output

### Approximation rules

When `approximate` is configured, values are snapped to a canonical grid or cluster **after normalization and before deduplication**, to keep the variable count within a cap.

**Variable count cap:**
- Each group has an optional `maxVariables` cap; there is also a global cap
- When the distinct value count exceeds the cap, the step/tolerance is doubled and snapping re-runs
- This repeats up to `maxIterations` times (default: `5`)
- If the cap is still not reached, emit a warning and proceed with the closest result; never silently exceed the cap

**Spacing and radii — grid snapping:**
- Snap each value to the nearest multiple of `step` (e.g. `step: 4` snaps to 0, 4, 8, 12 … in the target unit)
- `roundingMode`: `round` (default) | `floor` | `ceil`
- Values below `minValue` or above `maxValue` are not snapped and are flagged for review
- If `customScale` is provided, snap to the nearest value in the explicit list instead of a grid

**Colors — perceptual tolerance:**
- Colors within Delta-E distance `tolerance` are merged into one cluster
- `strategy: nearest` keeps the first value in the cluster; `strategy: centroid` averages all values
- Colors are only merged with others that share the same alpha value (±`alphaTolerance`, default `0.05`)

**Typography — scale snapping:**
- `scaleBase` + `scaleRatio` generates a modular scale; each font size snaps to the nearest step
- `customScale` list overrides the modular scale
- Font weights snap to the nearest valid CSS keyword: `100 200 300 400 500 600 700 800 900`
- `roundDecimalPlaces`: decimal places for snapped values (default: `2`)

**Durations — step snapping:**
- Snap to the nearest multiple of `step` in the target unit (e.g. `step: 50` with `ms` → `180ms` becomes `200ms`)

### Deduplication and naming

After normalization and approximation, group identical values across all files. Apply the `threshold`: only extract values with `>= threshold` occurrences.

Generate variable names using these patterns:

| Type | Pattern |
|---|---|
| Colors | `{prefix}-color-{slug}` — attempt semantic name from selector name, property name, or nearby comment first |
| Spacing | `{prefix}-spacing-{value}` |
| Font size | `{prefix}-font-size-{value}` |
| Font weight | `{prefix}-font-weight-{value}` |
| Font family | `{prefix}-font-family-{slug}` |
| Line height | `{prefix}-line-height-{value}` |
| Letter spacing | `{prefix}-letter-spacing-{value}` |
| Radii | `{prefix}-radius-{value}` |
| Shadows | `{prefix}-shadow-{slug}` |
| Z-index | `{prefix}-z-{value}` |
| Duration | `{prefix}-duration-{value}` |
| Easing | `{prefix}-easing-{slug}` |

- Slugify: replace `.` with `-`, strip non-alphanumeric chars, lowercase
- Collision handling: if a generated name is already taken by a different value, append `-2`, `-3`, etc.
- If a name cannot be derived automatically, generate `{prefix}-color-unnamed-1` and flag it in warnings

### Plan shape

```json
{
  "variables": [
    {
      "name": "--brand-color-primary",
      "value": "hsl(220 90% 56%)",
      "type": "colors",
      "occurrences": 14,
      "sources": [{"file": "src/Button.css", "line": 12, "original": "#3a86ff"}]
    }
  ],
  "skipped": [...],
  "warnings": [...]
}
```

Show the user a summary table:

```
Group         Extracted   Snapped   Merged   Skipped
colors             12         0        3        2
spacing             7         4        0        1
typography          5         3        0        0
radii               3         0        0        0
transitions         4         2        0        0
```

If `dryRun` is `true`, stop here and print the full plan. Do not write any files.

## Step 4 — Write variable file

Determine the output file path using these heuristics (unless `output` is set explicitly):
1. Existing file already containing `:root {` with `--` properties
2. `src/styles/variables.css` / `.scss`
3. `src/styles/tokens.css`
4. `styles/variables.css`
5. Create `src/styles/variables.css`

```bash
python3 .agents/skills/css-extract-variables/scripts/extractor.py \
  --config <resolved-config-path> \
  --mode write-variables \
  --plan extraction-plan.json \
  --variables-file <output-path>
```

**Write rules:**
- Write all variables into a single `:root { }` block
- If an existing variable file is detected, merge: add new variables, never overwrite conflicting names; log every skipped-because-existing variable
- Group variables by type with a comment heading
- If nothing new would be written (all names already exist), skip writing entirely
- For SCSS (`scss: true`), output `$variable: value;` instead of custom properties and omit `:root`

```css
/* Colors */
--brand-color-primary: hsl(220 90% 56%);

/* Spacing */
--brand-spacing-4: 0.25rem;
```

## Step 5 — Replace source occurrences

```bash
python3 .agents/skills/css-extract-variables/scripts/extractor.py \
  --config <resolved-config-path> \
  --mode replace \
  --plan extraction-plan.json
```

**Replacement rules:**
- Replace every matched original occurrence with `var(--variable-name)` (or `$variable-name` for SCSS)
- Never replace values inside CSS comments
- Never replace values that are already a `var(--…)` reference
- Preserve `!important` after the replacement
- Shorthand properties: replace each token independently only if every token in the shorthand has a variable; otherwise leave the shorthand intact and add a `/* css-extract: review */` comment
- Use word-boundary regex matching to prevent replacing substrings inside already-replaced `var(--…)` names

## Step 6 — Report

Print the final report:

```
Scanning complete — 47 files processed

Normalized values:
  Colors     14 converted to hsl  (3 duplicates collapsed)
  Spacing     9 converted to rem  (2 values skipped: % unit)
  Durations   5 converted to ms

Approximated values:
  Colors      6 merged  (tolerance ≤ 4 ΔE)  →  4 variables
  Spacing    11 snapped to 4px grid         →  7 variables  (cap: 10)
  Font sizes  8 snapped to type scale       →  5 variables

Extracted 31 variables → src/styles/variables.css

Modified files:
  src/components/Button.module.css    (8 replacements)
  src/components/Card.module.css      (5 replacements)
  src/styles/global.css              (14 replacements)

Skipped (below threshold of 2):
  #e0e0e0  — 1 occurrence  Button.module.css:34
  1.25rem  — 1 occurrence  Header.css:12

Warnings:
  rgba(0,0,0,0.07)  named automatically → --color-unnamed-1  (review suggested)
  Spacing 3px below minValue (4px) — kept as-is
  Colors cap (4) could not be reached after 5 iterations — result: 5 variables
```

If a `.stylelintrc` or `prettier` config is detected, remind the user to run their formatter.

## Available scripts

- **`scripts/extractor.py`** — Main worker. Modes: `scan`, `extract`, `write-variables`, `replace`. Run with `--help` for full usage.

## Edge cases

- **Media queries**: do not extract breakpoint values unless the user explicitly includes `breakpoints` in `types`
- **`calc()` expressions**: convert individual numeric terms where possible; leave mixed-unit `calc()` intact and flag it in warnings
- **Gradients**: treat the entire gradient string as one atomic value; extract as a variable only if the full string repeats
- **Shorthand properties**: only replace individual tokens if every token in the shorthand has a variable; otherwise leave intact with a `/* css-extract: review */` comment
- **`!important`**: preserve the flag after replacement — `color: #fff !important` → `color: var(--color-white) !important`
- **`em` in nested selectors**: `em` → `rem` is 1:1 and only safe at top level; always warn the user to verify no nested context breaks
- **Existing partial variable usage**: if a file already uses some custom properties, skip those specific declarations and do not duplicate them
- **CSS-in-JS** (styled-components, emotion): out of scope unless the file extension is `.css` or `.scss`
- **Color approximation and alpha**: colors with different alpha values are never merged, even if their RGB channels are within tolerance
- **SCSS vs CSS**: when `scss: true`, use `$name: value` syntax in the output file and `$name` (no `var()`) in replacements; never mix both syntaxes in the same file

## Success criteria

- All hardcoded values meeting the threshold are replaced
- No visual regressions — variable values are semantically equivalent to the originals
- Variable file is valid CSS / SCSS with no duplicate names
- Dry-run mode produces no file writes
- Variable count per group does not exceed `maxVariables` cap (or a warning is emitted if unreachable)
- Approximated values differ from originals only within the configured tolerance
- Skipped-because-existing variables are logged so the user knows what was not updated
