---
name: extract-components
description: >
  Scans React TSX/JSX files (or raw HTML) for structurally repetitive JSX
  subtrees, proposes reusable component extractions with inferred prop
  signatures, writes new component files, and rewrites the original files to
  use them. Use when asked to extract repeated JSX into components, reduce
  duplication in React files, refactor repeated HTML patterns, or find
  reusable UI patterns in a codebase.
compatibility: Requires Node.js 18+. Installs ts-morph automatically on first run.
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Find JSX/HTML subtrees that repeat three or more times — within a file or
across files — infer which differing values become props and which stay
hardcoded, generate a typed component, and rewrite every call site.

A **repetition** is: the same element type with the same structural shape
(element tree depth and child types), where only leaf values (strings,
numbers, expressions, event handlers) differ across instances.

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to scan (default: `src/`) |
| `minOccurrences` | No | Minimum repetitions before a pattern is extracted (default: `3`) |
| `minDepth` | No | Minimum JSX subtree depth to consider (default: `2`) |
| `outputDir` | No | Where to write new component files (default: same directory as the first source file, or `src/components/` if cross-file) |
| `dryRun` | No | Preview extractions without writing any files (default: `false`) |
| `includeHtml` | No | Also scan `.html` files and produce plain JS components (default: `false`) |
| `interactive` | No | Pause after each proposal and ask for approval before writing (default: `true`) |

## Step 1 — Resolve config and discover files

Look for config in this order:
1. Path passed explicitly by the user
2. `extract-components.config.json` in the project root
3. Built-in defaults

```bash
node .agents/skills/extract-components/scripts/extractor.js \
  --mode scan \
  --target <path>
```

**Discovery rules:**
- Recursively find all `.tsx`, `.jsx` files (and `.html` if `includeHtml`)
- Skip `node_modules`, `dist`, `build`, `.next`, `.git`, `*.test.*`, `*.spec.*`, `*.stories.*`
- Report the file list to the user before continuing

## Step 2 — Parse and fingerprint JSX subtrees

```bash
node .agents/skills/extract-components/scripts/extractor.js \
  --mode fingerprint \
  --target <path> \
  --output-plan .extract-components/plan.json
```

For each file, use **ts-morph** to walk the JSX tree. For every JSX element:

### Normalisation

Produce a **structural fingerprint** by cloning the subtree and replacing all
varying leaf content with typed placeholders, while keeping the element types,
attribute names, and tree structure:

| Original | Fingerprint placeholder |
|---|---|
| `"Edit Transaction"` | `«string»` |
| `{formData.date}` | `«expression»` |
| `{(e) => setFormData(...)}` | `«handler»` |
| `true` / `false` | `«boolean»` |
| `42` / `0.5` | `«number»` |
| `className="w-full px-4…"` that is **identical** across all instances | kept as-is (becomes hardcoded) |
| `className="…"` that **differs** across instances | `«string»` |

A value is "varying" if it is not byte-identical across all candidate
occurrences. A value is "identical" if it matches exactly in every occurrence.

### Depth and complexity filter

Before fingerprinting, skip subtrees that:
- Have fewer than `minDepth` nesting levels
- Contain fewer than 3 JSX attributes total across the whole subtree
- Are single self-closing elements with no children (e.g. bare `<br />`, `<hr />`)

### Fingerprint hash

SHA-256 the serialised fingerprint string. Group all subtrees by hash.

### Plan shape

```json
{
  "patterns": [
    {
      "hash": "a3f9…",
      "occurrences": 5,
      "files": ["src/components/TransactionModal.tsx"],
      "locations": [
        { "file": "src/components/TransactionModal.tsx", "startLine": 84, "endLine": 92 },
        { "file": "src/components/TransactionModal.tsx", "startLine": 94, "endLine": 104 }
      ],
      "fingerprint": "<div><label className=\"block text-sm…\">«string»</label><input … className=\"w-full px-4…\" value={«expression»} onChange={«handler»} /></div>",
      "varyingValues": [
        { "role": "label", "type": "string", "examples": ["Date", "Type", "Category"] },
        { "role": "value", "type": "expression", "examples": ["formData.date", "formData.type"] },
        { "role": "onChange", "type": "handler" }
      ],
      "fixedAttributes": {
        "className (label)": "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1",
        "className (input)": "w-full px-4 py-2.5 bg-white dark:bg-gray-700 border …"
      }
    }
  ]
}
```

## Step 3 — Score and rank patterns

Score each pattern group:

```
score = occurrences × subtreeNodeCount × crossFileBonus
```

- `occurrences` — number of matching instances
- `subtreeNodeCount` — total JSX nodes in one instance (deeper = higher value)
- `crossFileBonus` — `2.0` if the pattern spans more than one file, `1.0` otherwise

Sort patterns descending by score. Discard any pattern where `occurrences < minOccurrences`.

Show the ranked list to the user before proceeding:

```
Found 3 extractable patterns:

  #1  score 40  — 5 occurrences  TransactionModal.tsx
      <div><label>…</label><input … /></div>   (label + form field)

  #2  score 18  — 3 occurrences  Dashboard.tsx, Summary.tsx
      <div className="flex items-center gap-2">…</div>   (stat card row)

  #3  score 12  — 3 occurrences  TransactionModal.tsx
      <button className="flex-1 px-4…">…</button>   (action button)
```

If `interactive` is `true` (default), ask the user which patterns to proceed
with. Accept `all`, a comma-separated list of numbers, or `none` to abort.

## Step 4 — Infer prop signatures

For each selected pattern:

### Prop naming heuristics

Derive prop names from the role of each varying value:

| Structural clue | Suggested prop name |
|---|---|
| Text content of `<label>` | `label` |
| `value` attribute | `value` |
| `onChange` / `onInput` attribute | `onChange` |
| `type` attribute of `<input>` | `type` |
| `placeholder` attribute | `placeholder` |
| `href` attribute | `href` |
| `onClick` attribute | `onClick` |
| `children` (slot) | `children` |
| `aria-label` attribute | `ariaLabel` |
| Any other varying attribute `foo` | `foo` |

If two props would collide (e.g. two `className` attributes at different
depths), suffix with the element tag: `labelClassName`, `inputClassName`.

### TypeScript type inference

Infer the TypeScript type of each prop from the examples:

| Example values across instances | Inferred type |
|---|---|
| `"Date"`, `"Type"`, `"Category"` | `string` |
| `{formData.date}`, `{formData.amount}` — same parent object | `string \| number` (widen from surrounding type if available) |
| Event handlers `{(e) => …}` | `React.ChangeEventHandler<HTMLInputElement>` (or `HTMLSelectElement`) |
| `{() => …}` (no arg) | `() => void` |
| Boolean toggles | `boolean` |
| JSX elements | `React.ReactNode` |

### Children slot detection

If the subtree has a consistent interior region that varies structurally
across instances (e.g. one instance has `<option>` children, another has
`<input>`), extract that region as a `children: React.ReactNode` prop rather
than trying to enumerate every variant.

### Props table (shown to user before writing)

```
FormField — 5 occurrences in TransactionModal.tsx

  Prop        Type                                    Required
  ─────────────────────────────────────────────────────────────
  label       string                                  yes
  children    React.ReactNode                         yes

Hardcoded inside component:
  label className  "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
  wrapper className  (none — plain <div>)
```

If `interactive`, ask for confirmation or allow the user to rename props
before writing.

## Step 5 — Name the component

Use these heuristics in priority order to derive the component name:

1. **Surrounding context**: If all occurrences are inside a `<form>`, prefer
   `FormField`. Inside `<ul>` / `<ol>` → `ListItem`. Inside a card layout
   (`className` contains `card` / `panel`) → `Card`.
2. **Dominant element type**: `<button>` → `Button`. `<a>` → `Link`.
   `<tr>` → `TableRow`. `<label>+<input>` together → `LabeledInput` or `FormField`.
3. **Most-repeated className token**: Extract the most distinctive word from
   the fixed className (e.g. `stat-card`, `badge`, `tab-item`) and PascalCase it.
4. **Fallback**: `ExtractedBlock` + a counter.

Present the suggested name to the user and allow renaming when `interactive`.

## Step 6 — Generate the component file

Write the new component to `outputDir/<ComponentName>.tsx`.

**Template:**

```tsx
import type { ReactNode } from 'react'

type <ComponentName>Props = {
  <prop>: <type>
  // … one per varying value
}

export function <ComponentName>({ <props> }: <ComponentName>Props) {
  return (
    <subtree with placeholders replaced by prop references>
  )
}
```

**Rules:**
- Always emit a named export (not default) so tree-shaking works
- Import `React` only if the project's tsconfig has `jsx: 'react'` (not
  `react-jsx` or `preserve`); detect from `tsconfig.json`
- If any prop type references an existing project type (e.g.
  `ChangeEventHandler`), add the correct import
- Add `'use client'` at the top if the original file had it and any prop is
  an event handler (handlers imply client interactivity)
- Preserve original formatting: detect tabs vs spaces from the source file
- Do not add JSDoc, comments, or prop descriptions unless the original had them

**Example output for `TransactionModal.tsx` pattern #1:**

```tsx
'use client'

import type { ReactNode } from 'react'

type FormFieldProps = {
  label: string
  children: ReactNode
}

export function FormField({ label, children }: FormFieldProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {label}
      </label>
      {children}
    </div>
  )
}
```

## Step 7 — Rewrite call sites

Replace every matched occurrence in the original source files with a JSX call
to the new component, and add the import at the top of the file.

**Replacement rules:**
- Determine the relative import path from the source file to the new component
- Add the import as a named import on a new line after the last existing import
- Replace the matched subtree with the component call, substituting prop values
  for the corresponding original expressions
- Preserve surrounding indentation
- If the original occurrence spanned multiple lines, keep the same number of
  lines to minimise diff noise (add or remove blank lines as needed)

**Example rewrite of `TransactionModal.tsx`:**

Before:
```tsx
<div>
  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date</label>
  <input
    type="date"
    value={formData.date}
    onChange={(e) => setFormData({ ...formData, date: e.target.value })}
    className="w-full px-4 py-2.5 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
  />
</div>
```

After:
```tsx
<FormField label="Date">
  <input
    type="date"
    value={formData.date}
    onChange={(e) => setFormData({ ...formData, date: e.target.value })}
    className="w-full px-4 py-2.5 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
  />
</FormField>
```

If `dryRun` is `true`, print the diff for every file but do not write.

## Step 8 — Validate

Run TypeScript type-check on every modified file:

```bash
npx tsc --noEmit --project tsconfig.json
```

If type errors are introduced by the rewrite, print the errors and offer to
revert the specific file. Never leave the codebase in a type-broken state.

If the project has tests, report which test files import any modified source
file so the user knows what to re-run.

## Step 9 — Report

```
extract-components — done

Patterns extracted: 2

  FormField (src/components/FormField.tsx)
    5 occurrences replaced  →  TransactionModal.tsx
    Props: label: string, children: ReactNode
    Lines removed from source: 48  (net −38 after adding import)

  StatRow (src/components/StatRow.tsx)
    3 occurrences replaced  →  Dashboard.tsx (2), Summary.tsx (1)
    Props: label: string, value: string | number
    Lines removed from source: 21  (net −16 after adding import)

Skipped (below threshold of 3):
  <button className="flex-1 px-4…">…</button>  — 2 occurrences

TypeScript: ✓ no errors

Files to re-check tests:
  src/components/TransactionModal.test.tsx
```

## Available scripts

- **`scripts/extractor.js`** — Main worker. Modes: `scan`, `fingerprint`, `extract`. Run with `--help` for full usage.

## Edge cases

- **Variants with different child element types**: If some instances use `<input>` and others `<select>` inside the same wrapper structure, extract the wrapper only and use a `children` slot for the differing interior
- **Conditional rendering** (`&&`, `? :`): If the condition itself is identical across instances, keep it inside the component; if it varies, make the condition value a boolean prop
- **Event handlers with inline closures**: Preserve the closure as-is in the call site; the prop type becomes the handler signature, not the closure body
- **`key` props**: Never include `key` inside the extracted component; keep it on the call site
- **`ref` forwarding**: If any occurrence uses a `ref`, add `React.forwardRef` to the extracted component and add `ref` to the prop type
- **Default exports**: The new component uses a named export; if the source file re-exports it as a barrel, add the named export to the barrel automatically
- **`className` merging**: If instances pass an additional `className` on top of the fixed one, add a `className?: string` prop and merge with `cn()` or `clsx()` if those are already used in the project; otherwise use template literals
- **Cross-file patterns in different directories**: Place the new component in the nearest common ancestor directory, or `src/components/` if the project has one
- **HTML files** (`includeHtml: true`): Parse with a DOM parser, fingerprint the same way, emit a plain `.tsx` function component; do not attempt to convert inline styles to Tailwind
- **Patterns that are already a component**: If a fingerprint matches an existing component's render output, flag it as "already extracted" and skip
- **Large files (> 1000 lines)**: Process in chunks; never hold the full AST in memory simultaneously

## Success criteria

- Every extracted pattern has `>= minOccurrences` replaced call sites
- The new component file compiles with no TypeScript errors
- All original files pass `tsc --noEmit` after rewriting
- Dry-run produces no file writes
- No occurrence is left un-replaced (unless it was skipped by user choice)
- The extracted component renders identically to the original subtree for every set of prop values seen in the source
