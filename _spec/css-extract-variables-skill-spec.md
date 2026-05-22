# Skill Spec: Extract CSS Variables from Hardcoded Values

## Goal

Scan all CSS files in a repository, identify repeated or semantically meaningful hardcoded values, extract them into CSS custom properties, and replace all occurrences with variable references.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "extract CSS variables"
- "replace hardcoded values with CSS vars"
- "refactor CSS to use custom properties"
- "tokenize CSS values"

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | Path to scan (default: entire repo) |
| `types` | No | Value types to extract: `colors`, `spacing`, `typography`, `radii`, `shadows`, `z-index`, `transitions`, `all` (default: `all`) |
| `output` | No | File to write variables to (default: auto-detected or `variables.css`) |
| `threshold` | No | Minimum occurrences before a value is extracted (default: `2`) |
| `dry-run` | No | Preview changes without writing files (default: `false`) |
| `prefix` | No | Custom property name prefix, e.g. `--brand` (default: `--`) |
| `normalize` | No | Unification rules for formats and units — see [Normalization](#normalization) section |
| `approximate` | No | Snapping and rounding rules to keep variable count below a cap — see [Approximation](#approximation) section |

---

## Behavior

### 1. Discovery

- Recursively find all `.css`, `.scss`, `.sass`, `.less`, `.module.css`, `.module.scss` files
- Exclude `node_modules`, `dist`, `build`, `.git`, and any path in `.gitignore`
- Report total file count before proceeding

### 2. Parsing

Extract the following hardcoded value types:

**Colors**
- Hex: `#fff`, `#ffffff`, `#ff0000cc`
- RGB/RGBA: `rgb(255, 0, 0)`, `rgba(0,0,0,0.5)`
- HSL/HSLA: `hsl(200, 100%, 50%)`, `hsla(...)`
- Named colors: `red`, `transparent`, `currentColor` (skip `currentColor` and `inherit`)

**Spacing / sizing**
- Fixed lengths: `px`, `rem`, `em`, `%`, `vh`, `vw`, `ch`, `ex`
- Only extract values used in `margin`, `padding`, `gap`, `width`, `height`, `top`, `right`, `bottom`, `left`, `inset`

**Typography**
- `font-size`, `font-weight`, `font-family`, `line-height`, `letter-spacing`

**Border radius**
- Values in `border-radius` and shorthand variants

**Shadows**
- `box-shadow`, `text-shadow` — full value string as one variable

**Z-index**
- Numeric values in `z-index`

**Transitions / durations**
- `transition-duration`, `animation-duration`: time values (`ms`, `s`)
- `transition-timing-function`

### 3. Normalization

When a `normalize` config is provided, values are converted to a canonical format or unit **before** deduplication and naming. This ensures that `#fff`, `rgb(255,255,255)`, and `white` are treated as the same value and collapsed into one variable.

#### Color format unification

Supported target formats: `hex` | `hsl` | `rgb` | `oklch`

Rules:
- All parsed colors are converted to the target format before comparison and variable value output
- Alpha channel is preserved: `rgba(0,0,0,0.5)` → `hsl(0 0% 0% / 0.5)` when target is `hsl`
- Named colors are resolved to their RGB equivalent first, then converted
- `transparent` is normalized to `rgb(0 0 0 / 0)` if not in the skip list
- Short hex `#fff` is expanded to `#ffffff` before conversion
- If the target format is `hex` and the color has an alpha channel, fall back to `rgba` (hex alpha is not universally supported)
- Precision for `hsl` and `oklch`: round to 2 decimal places

#### Spacing / sizing unit unification

Supported target units: `px` | `rem` | `em`

Rules:
- `px` ↔ `rem`: requires a `baseFontSize` (default: `16`) to compute the ratio
- `em` → `rem`: only safe when `em` is used outside a nested context; the skill converts `em` to `rem` 1:1 and adds a warning that `em` values are context-dependent
- `%`, `vh`, `vw`, `ch`, `ex`: cannot be converted to `px`/`rem` — left unchanged, reported as skipped
- Values inside `calc()` are converted term by term where possible; mixed-unit `calc()` expressions are left intact

#### Typography unit unification

- `font-size`: same rules as spacing units above
- `line-height`: unitless values (e.g. `1.5`) are left as-is; values with units follow spacing unit rules
- `letter-spacing`: follows spacing unit rules

#### Duration unification

Supported target units: `ms` | `s`

Rules:
- `ms` ↔ `s`: multiply or divide by 1000, round to 2 decimal places for `s` (e.g. `200ms` → `0.2s`)

#### Normalization and deduplication order

1. Parse the raw value
2. Apply normalization (convert to target format/unit)
3. Compare normalized values for deduplication
4. Use the normalized value as the variable value in the output file
5. Replace all original (pre-normalization) occurrences in source files with `var(--variable-name)`

#### Normalization report

When normalization runs, the output includes a conversion summary:

```
Normalized values:
  Colors     14 converted to hsl  (3 duplicates collapsed)
  Spacing    9 converted to rem   (2 values skipped: % unit)
  Durations  5 converted to ms
```

---

### 4. Approximation

Approximation runs **after normalization and before deduplication**. Its purpose is to snap near-identical values to a common canonical value so the final variable count stays manageable. Without this step a codebase using `14px`, `15px`, and `16px` for spacing would produce three variables; with a 4px grid snap all three collapse to `16px` and become one.

#### Variable count cap

Each group (colors, spacing, etc.) can have a `maxVariables` cap. When the number of distinct values would exceed the cap, the skill progressively tightens the approximation step size until the count falls within the limit. The tightening algorithm:

1. Start with the configured step/tolerance
2. Count distinct values after snapping
3. If count > `maxVariables`, double the step and re-snap
4. Repeat up to `maxIterations` times (default: `5`)
5. If count still exceeds the cap after all iterations, emit a warning and proceed with the closest result

A global `maxVariables` cap applies across all groups combined.

#### Spacing and sizing — grid snapping

Snap each value to the nearest multiple of a grid step:

- `step`: grid interval (e.g. `4` means values snap to 0, 4, 8, 12, 16 … in the target unit)
- Rounding mode: `round` (default) | `floor` | `ceil`
- `minValue` / `maxValue`: values outside this range are not snapped and are flagged for review
- Custom scale: instead of a uniform grid, provide an explicit list of allowed values; each value snaps to the nearest allowed entry

Example: `13px` with a 4px grid → `12px`; with a custom scale `[0, 4, 8, 12, 16, 24, 32, 48, 64]` → `12px`

#### Colors — perceptual tolerance

Colors within a perceptual distance threshold are merged into the centroid (average) color of their cluster:

- `tolerance`: maximum Delta-E 2000 distance between two colors for them to be merged (range 0–100; `0` = exact match only, `5` = visually near-identical)
- `strategy`: `nearest` (snap to the closest value in the cluster) | `centroid` (compute the average color)
- Colors with alpha channels are only merged with other colors that share the same alpha value (±`alphaTolerance`, default `0.05`)

Example: `#3a85ff` and `#3b87fe` with `tolerance: 3` → merged into one variable `--color-blue`

#### Typography — scale snapping

Font sizes can be snapped to a modular type scale or a custom list:

- `scaleBase` + `scaleRatio`: e.g. base `16px`, ratio `1.25` generates `…10.24, 12.8, 16, 20, 25, 31.25…`; each font size snaps to the nearest step
- `customScale`: explicit list overrides `scaleBase`/`scaleRatio`
- `roundDecimalPlaces`: round the snapped value to N decimal places (default: `2`)
- Font weights are snapped to valid CSS keyword values: `100 200 300 400 500 600 700 800 900`

#### Duration — step snapping

Duration values snap to the nearest multiple of a step:

- `step`: e.g. `50` (ms) means `180ms` → `200ms`, `220ms` → `200ms`
- Applies after unit normalization, so the step is always in the target unit

#### Approximation pipeline order

```
raw value
  → normalize (format/unit conversion)
  → approximate (snap to grid / scale / tolerance cluster)
  → deduplicate (identical normalized+snapped values collapse)
  → name and output
```

The variable value written to the output file is the **snapped** value, not the original. All source occurrences of the original value are replaced with the variable reference.

#### Approximation report

```
Approximated values:
  Colors     6 merged  (tolerance ≤ 4 ΔE)  →  4 variables
  Spacing    11 snapped to 4px grid        →  7 variables  (cap: 10)
  Font sizes 8 snapped to type scale       →  5 variables

Warnings:
  Spacing value 3px is below minValue (4px) — not snapped, kept as-is
  Colors cap (4) could not be reached after 5 iterations — result: 5 variables
```

---

### 5. Deduplication and naming

- Group identical values across all files
- Apply the threshold: only extract values appearing `>= threshold` times
- Generate variable names using these rules:
  - Colors: `--color-{semantic-name-or-hex-slug}` — attempt semantic naming from context (e.g. property name, selector name, nearby comments)
  - Spacing: `--spacing-{value}` (e.g. `--spacing-4` for `4px`, `--spacing-1rem` for `1rem`)
  - Font sizes: `--font-size-{value}`
  - Font weights: `--font-weight-{value}`
  - Font families: `--font-family-{slug}`
  - Radii: `--radius-{value}`
  - Shadows: `--shadow-{slug}`
  - Z-index: `--z-{value}`
  - Transitions: `--duration-{value}`, `--easing-{slug}`
- Slugify values: replace `.` with `-`, strip special chars, lowercase
- Avoid name collisions: append `-2`, `-3` if the generated name is already taken by a different value

### 6. Variable file output

- Write all extracted variables into a single `:root { }` block
- If an existing variable file is detected (e.g. already has `:root` with `--` properties), merge: add new variables, do not overwrite existing ones with conflicting names
- Group variables by type with a comment heading:
  ```css
  /* Colors */
  --color-primary: #3a86ff;

  /* Spacing */
  --spacing-4: 4px;
  ```
- If the project uses SCSS, output as `$variable: value;` instead of custom properties, unless the user specifies otherwise

### 7. Replacement

- Replace every matched hardcoded occurrence with `var(--variable-name)`
- Preserve surrounding syntax (shorthand properties, calc(), gradients)
- Do not replace values inside comments
- Do not replace values that are already a CSS variable reference
- For SCSS: replace with `$variable-name` syntax

### 8. Validation

After writing changes:
- Run a diff summary: files changed, total replacements made, variables introduced
- Warn about any value that appears only once (below threshold) and was skipped
- Warn about any value that could not be automatically named (flag for manual review)
- If a CSS linter or formatter config is detected (`.stylelintrc`, `prettier`), note that the user may want to run it after

---

## Output format

```
Scanning 47 CSS files...

Approximated values:
  Colors     6 merged  (tolerance ≤ 4 ΔE)  →  4 variables
  Spacing    11 snapped to 4px grid        →  7 variables  (cap: 10)
  Font sizes 8 snapped to type scale       →  5 variables

Extracted 23 variables:
  Colors    12
  Spacing    6
  Typography 3
  Radii      2

Written to: src/styles/variables.css

Modified files:
  src/components/Button.module.css     (8 replacements)
  src/components/Card.module.css       (5 replacements)
  src/styles/global.css               (14 replacements)
  ...

Skipped (below threshold of 2):
  #e0e0e0  — 1 occurrence in Button.module.css:34
  1.25rem  — 1 occurrence in Header.css:12

Review needed (could not auto-name):
  rgba(0,0,0,0.07)  → --color-unnamed-1
```

---

## Edge cases and constraints

- **Shorthand properties**: when replacing a value in a shorthand (e.g. `margin: 8px 16px`), replace each value independently only if both have variables; otherwise leave the shorthand intact and add a comment
- **calc() expressions**: replace individual values inside `calc()` only if the full expression is not being reused as a unit
- **Gradients**: treat gradient strings as atomic shadow-like values; extract the whole string as one variable only if repeated
- **Media queries**: do not extract breakpoint values unless the user explicitly includes `breakpoints` in types
- **!important**: preserve the `!important` flag after replacement
- **CSS-in-JS** (styled-components, emotion): out of scope unless the file extension is `.css`/`.scss`
- **Existing partial variable usage**: if a file already uses some custom properties, do not duplicate them

---

## File placement heuristics

Prefer writing variables to:
1. An existing file already containing `:root` with `--` variables
2. `src/styles/variables.css` (or `.scss`)
3. `src/styles/tokens.css`
4. `styles/variables.css`
5. If none exist, create `src/styles/variables.css`

---

## Success criteria

- All hardcoded values meeting the threshold are replaced
- No visual regressions (values are semantically equivalent)
- Variable file is valid CSS / SCSS
- No duplicate variable names in output
- Dry-run mode produces no file writes
- Variable count per group does not exceed `maxVariables` cap (or a warning is emitted if unreachable)
- Approximated values in source files differ from originals only within the configured tolerance
