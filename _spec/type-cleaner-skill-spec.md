# Skill Spec: TypeScript Type Cleaner

## Goal

Analyse all TypeScript source files in a repository, apply a configurable set of type hygiene rules, and rewrite the files in place — reducing duplication, removing redundancy, improving consistency, and surfacing structural improvements without changing runtime behaviour.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "clean up types"
- "fix TypeScript types"
- "deduplicate types"
- "remove redundant types"
- "unify type declarations"
- "generate enums from union types"
- "tidy types"

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | Path to scan (default: entire repo) |
| `rules` | No | List of rule IDs to apply, or `all` (default: `all`) |
| `exclude` | No | Paths to skip (default: `node_modules`, `dist`, `build`, `.git`) |
| `extensions` | No | File extensions to process (default: `.ts`, `.tsx`, `.d.ts`) |
| `dryRun` | No | Preview changes without writing (default: `false`) |
| `threshold` | No | Similarity ratio 0–1 for partial-duplicate detection (default: `0.8`) |
| `enumStyle` | No | `enum` (default) \| `const-enum` \| `string-union` (keeps as-is) |
| `preferInterface` | No | Prefer `interface` over `type` for object shapes (default: `true`) |
| `sortMembers` | No | Sort type/interface members alphabetically (default: `false`) |
| `anyPolicy` | No | `flag` (default) \| `replace-unknown` \| `ignore` |
| `report` | No | Write a markdown summary of all changes (default: `true`) |

---

## Config file

The skill reads configuration from `type-cleaner.config.json` in the project root. CLI flags override config file values. Config file values override built-in defaults.

**Resolution order (highest to lowest priority):**
1. CLI flags passed directly to the skill
2. `type-cleaner.config.json` in the project root
3. Built-in defaults

**Auto-discovery:** if no `--config` flag is provided, look for `type-cleaner.config.json` in the current working directory, then walk up to the git root. If no file is found, use built-in defaults.

**Recommended practice:** commit `type-cleaner.config.json` to the repository so all team members share the same rule set and style decisions.

**Full config structure with defaults:**

```json
{
  "target": ".",
  "rules": "all",
  "exclude": ["node_modules", "dist", "build", ".git", "coverage"],
  "extensions": [".ts", ".tsx"],
  "dryRun": false,
  "threshold": 0.8,
  "enumStyle": "enum",
  "preferInterface": true,
  "sortMembers": false,
  "anyPolicy": "flag",
  "report": true,
  "reportPath": "type-cleaner-report.md",
  "rules_config": {
    "dedup-identical": {
      "enabled": true
    },
    "dedup-partial": {
      "enabled": true,
      "threshold": 0.8,
      "minSharedProperties": 2
    },
    "dedup-imports": {
      "enabled": true
    },
    "remove-optional-undefined": {
      "enabled": true
    },
    "remove-null-undefined-strict": {
      "enabled": true,
      "requireConfirmation": true
    },
    "remove-never-union": {
      "enabled": true
    },
    "remove-unknown-intersection": {
      "enabled": true
    },
    "remove-duplicate-union-members": {
      "enabled": true
    },
    "flatten-nested-unions": {
      "enabled": true
    },
    "remove-noop-utility": {
      "enabled": true
    },
    "remove-wrapper-types": {
      "enabled": true
    },
    "remove-any-cast-chain": {
      "enabled": true
    },
    "extract-enum": {
      "enabled": true,
      "minMembers": 3,
      "minOccurrences": 2,
      "style": "enum"
    },
    "extract-inline-shape": {
      "enabled": true,
      "minOccurrences": 2
    },
    "extract-discriminated-union": {
      "enabled": true,
      "requireConfirmation": true
    },
    "normalise-interface-type": {
      "enabled": true,
      "prefer": "interface"
    },
    "normalise-record-index": {
      "enabled": true,
      "prefer": "Record"
    },
    "normalise-function-type": {
      "enabled": true,
      "prefer": "arrow"
    },
    "normalise-array-type": {
      "enabled": true,
      "prefer": "shorthand"
    },
    "merge-declarations": {
      "enabled": true
    },
    "remove-unused-types": {
      "enabled": true,
      "skipDeclarationFiles": true
    },
    "remove-unused-imports": {
      "enabled": true
    },
    "flag-any": {
      "enabled": true,
      "policy": "flag",
      "skipGenericConstraints": true
    },
    "flag-object-type": {
      "enabled": true
    },
    "flag-circular": {
      "enabled": true
    },
    "sort-members": {
      "enabled": false,
      "requiredFirst": true
    },
    "sort-union-members": {
      "enabled": false
    },
    "sort-imports": {
      "enabled": true
    }
  }
}
```

**Disabling individual rules** without removing them from the config:

```json
{
  "rules_config": {
    "extract-enum": { "enabled": false },
    "sort-members": { "enabled": false }
  }
}
```

**Running a subset of rules** via the top-level `rules` key:

```json
{
  "rules": ["dedup-identical", "remove-optional-undefined", "remove-wrapper-types"]
}
```

When `rules` is a list, only those rules run regardless of `enabled` flags in `rules_config`. When `rules` is `"all"`, every rule with `"enabled": true` runs.

---

## Rules catalogue

### Category: Deduplication

**`dedup-identical`**
Find type aliases and interfaces with structurally identical definitions across the codebase. Keep the first occurrence (or the one with the most descriptive name), replace all others with an import of the canonical type, and delete the duplicates.

- Comparison is structural, not nominal: `type A = { id: string }` and `type B = { id: string }` are duplicates
- Interfaces and type aliases are compared across files
- Canonical file is chosen by: most imports of the type → shortest file path → alphabetical name

**`dedup-partial`**
Find pairs of object types that share `>= threshold` (default 80%) of their properties. Extract the common properties into a new base type and rewrite both as extensions of it.

- Base type name is derived from the shared property set or the common name prefix of the two types
- Only applied when the result reduces total line count
- Example: `UserCreate` and `UserUpdate` sharing `name`, `email` → extract `UserBase`

**`dedup-imports`**
Merge multiple import statements from the same module that import types.

```ts
// before
import type { Foo } from './types'
import type { Bar } from './types'
// after
import type { Bar, Foo } from './types'
```

---

### Category: Redundancy removal

**`remove-optional-undefined`**
Remove explicit `| undefined` from optional property types, and remove `| undefined` from non-optional properties that already allow `undefined` via a different union member.

```ts
// before
type T = { name?: string | undefined }
// after
type T = { name?: string }
```

**`remove-null-undefined-strict`**
When `strictNullChecks` is enabled in `tsconfig.json`, remove `| null | undefined` from types that are already optional and can never be null in context. Flag only — do not auto-rewrite; requires user confirmation per occurrence.

**`remove-never-union`**
Remove `never` from union types (it is the identity element for unions).

```ts
type T = string | never  →  type T = string
```

**`remove-unknown-intersection`**
Remove `unknown` from intersection types (it is the identity element for intersections, i.e. `T & unknown = T`).

**`remove-duplicate-union-members`**
Deduplicate repeated members within the same union type.

```ts
type T = string | number | string  →  type T = string | number
```

**`flatten-nested-unions`**
Flatten unnecessarily nested union types.

```ts
type T = (A | B) | C  →  type T = A | B | C
```

**`remove-noop-utility`**
Remove utility type applications that have no effect:
- `Omit<T, never>` → `T`
- `Pick<T, keyof T>` → `T`
- `Required<Required<T>>` → `Required<T>`
- `Readonly<Readonly<T>>` → `Readonly<T>`
- `Partial<Partial<T>>` → `Partial<T>`
- `NonNullable<NonNullable<T>>` → `NonNullable<T>`

**`remove-wrapper-types`**
Replace JavaScript wrapper object types with their primitive equivalents.

```ts
Boolean → boolean
Number  → number
String  → string
Object  → object  (and flag for review — prefer specific shape)
```

**`remove-any-cast-chain`**
Simplify double-cast patterns used to bypass the type checker.

```ts
x as unknown as T  →  x as T   (when T is structurally compatible)
```

Flag all remaining `as unknown as T` casts in the report for manual review.

---

### Category: Extraction

**`extract-enum`**
Convert string or numeric literal union types that are used in more than one place into an enum (or `const` enum, depending on `enumStyle`).

```ts
// before (used in 3 files)
type Status = 'pending' | 'active' | 'archived'

// after
enum Status {
  Pending  = 'pending',
  Active   = 'active',
  Archived = 'archived',
}
```

- Member names are derived from the literal values: `kebab-case` → `PascalCase`, `SCREAMING_SNAKE` → `PascalCase`
- Existing usages of the string literal in assignments and comparisons are updated to use the enum member
- Only triggered when the union has 3+ members and appears in 2+ locations
- If `enumStyle` is `string-union`, this rule is skipped

**`extract-inline-shape`**
Find identical or near-identical inline object type literals that appear in 2+ positions and extract them into a named type alias or interface.

```ts
// before
function create(data: { id: string; name: string }): void
function update(id: string, data: { id: string; name: string }): void

// after
interface ItemData { id: string; name: string }
function create(data: ItemData): void
function update(id: string, data: ItemData): void
```

- Name is inferred from surrounding context (function name, parameter name, variable name)
- Placed in the same file as the first occurrence, or in a shared `types.ts` if occurrences span files

**`extract-discriminated-union`**
Detect object union types that share a common literal property (discriminant) but are not yet written as a proper discriminated union, and rewrite with explicit discriminant.

```ts
// before
type Shape = { kind: string; radius: number } | { kind: string; width: number }

// after
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'rect';   width: number }
```

Flag only — do not auto-rewrite; requires user confirmation because literal values must be inferred from usage.

---

### Category: Normalisation

**`normalise-interface-type`**
Enforce a consistent choice between `interface` and `type` for object shapes, controlled by `preferInterface`:

- `preferInterface: true` → convert `type X = { ... }` to `interface X { ... }` (except types that use mapped types, conditionals, or union/intersection)
- `preferInterface: false` → convert `interface X { ... }` to `type X = { ... }`

**`normalise-record-index`**
Normalise between `Record<string, T>` and `{ [key: string]: T }` to a consistent style. Default: prefer `Record<string, T>`.

**`normalise-function-type`**
Normalise between `{ (): T }` call signatures and `() => T` function type aliases. Default: prefer `() => T` for standalone function types.

**`normalise-array-type`**
Normalise between `Array<T>` and `T[]`. Default: prefer `T[]` for simple types, `Array<T>` for complex generics.

**`merge-declarations`**
Merge multiple `interface` declarations with the same name in the same file into one. (TypeScript allows declaration merging, but multiple declarations in a single file are usually unintentional.)

```ts
// before
interface Config { port: number }
interface Config { host: string }

// after
interface Config { port: number; host: string }
```

---

### Category: Cleanup

**`remove-unused-types`**
Find type aliases, interfaces, and enums that are defined but never referenced anywhere in the project and remove them. Exclude types in `.d.ts` files (they may be part of a public API).

**`remove-unused-imports`**
Remove type imports that are no longer referenced after other rules have been applied.

**`flag-any`**
Collect all uses of `any` and include them in the report. If `anyPolicy` is `replace-unknown`, replace `any` with `unknown` in positions where `unknown` is safe (variable declarations, return types, parameter types — not generic constraints where `any` has structural meaning).

**`flag-object-type`**
Flag uses of the `object` type (too broad). Suggest specific alternatives based on context and include in the report.

**`flag-circular`**
Detect circular type references and include them in the report. Do not auto-fix (resolving circular dependencies requires architectural changes).

---

### Category: Organisation

**`sort-members`**
When `sortMembers: true`, sort properties within interfaces and type literals alphabetically. Required members before optional members within each alphabetical group.

**`sort-union-members`**
Sort members of union types: primitive types first (`null`, `undefined`, `boolean`, `number`, `string`), then literals, then type references, then object literals — within each group, alphabetically.

**`sort-imports`**
Sort type imports alphabetically within each import statement.

---

## Behaviour

### 1. Resolve config and discovery

Resolve the effective config using the priority order defined in the Config file section. Surface the resolved config to the user before proceeding so they can verify which rules are active.

Recursively find all files matching `extensions` under `target`, excluding `exclude` paths and `.gitignore` entries.

Parse each file into an AST using the TypeScript compiler API (`ts.createSourceFile`). Build a cross-file symbol table: for each exported type, record all import sites.

### 2. Analysis pass

Run all enabled rules in **analysis-only** mode across all files simultaneously. Collect:
- All proposed changes with their rule ID, file, line range, before/after text
- Conflicts: two rules targeting the same node (resolved by rule priority order)
- Dependencies: if rule A renames a type that rule B references, apply A before B

Report rule-by-rule findings before any writes.

### 3. Confirmation (interactive)

For rules that make semantic assumptions (`extract-discriminated-union`, `remove-null-undefined-strict`, `dedup-partial`), show proposed changes and ask the user to confirm each group before applying.

Fully mechanical rules (`remove-never-union`, `flatten-nested-unions`, `remove-wrapper-types`, etc.) are applied without prompting unless `dryRun` is true.

### 4. Rewrite pass

Apply approved changes to the AST and print using the TypeScript printer (`ts.createPrinter`). Write modified files.

Update all cross-file import paths for renamed or moved types.

### 5. Validation

After rewriting, run `tsc --noEmit` to confirm no type errors were introduced. If errors appear:
- Show the errors
- Offer to revert all changes (restore from backup)
- Never leave the project in a broken state

### 6. Report

Write `type-cleaner-report.md` to the project root summarising:

```
## Type Cleaner Report

Date: 2026-05-21
Files scanned:      47
Files modified:     12
Rules applied:      8

### Changes by rule

| Rule                      | Changes | Files |
|---|---|---|
| dedup-identical           | 3 types removed | 5 |
| remove-optional-undefined | 14 properties   | 8 |
| extract-enum              | 2 enums created | 4 |
| remove-wrapper-types      | 6 occurrences   | 3 |
| ...                       | ...             | . |

### Flags (require manual review)

- `any` usages: 23 (see list below)
- Circular references: 2
- Partial duplicate candidates: 4 (threshold 80%)

### Removed types
- `UserPayload` (duplicate of `UserDto` in src/dto/user.ts)
- `StatusString` (replaced by enum `Status`)
```

---

## Pipeline order

Rules must be applied in this order to avoid conflicts:

1. `merge-declarations` — consolidate before analysing
2. `dedup-identical` — remove exact duplicates first
3. `remove-unused-types` — remove orphans before extracting
4. `remove-optional-undefined`, `remove-never-union`, `remove-unknown-intersection`, `remove-duplicate-union-members`, `flatten-nested-unions` — simplify individual types
5. `remove-noop-utility`, `remove-wrapper-types`, `remove-any-cast-chain` — mechanical substitutions
6. `normalise-interface-type`, `normalise-record-index`, `normalise-function-type`, `normalise-array-type` — normalise style
7. `extract-enum`, `extract-inline-shape` — extract after dedup (avoids extracting something about to be removed)
8. `dedup-partial` — run after extraction (newly extracted bases reduce partial-dup count)
9. `sort-members`, `sort-union-members`, `sort-imports` — cosmetic, last
10. `remove-unused-imports`, `dedup-imports` — clean imports after all structural changes
11. `flag-any`, `flag-object-type`, `flag-circular`, `extract-discriminated-union` — flags only, no writes

---

## Edge cases and constraints

- **Declaration files (`.d.ts`)**: run analysis and flag rules only; never auto-rewrite (`.d.ts` files are public API contracts)
- **Barrel files (`index.ts` re-exports)**: update re-exports when a type is renamed or moved, but do not remove re-exports even if the type appears unused within the barrel
- **Generic constraints**: `any` in `T extends any` is structurally meaningful; `flag-any` skips generic constraints
- **Ambient declarations (`declare module`)**: skip rewrite rules; flag only
- **Mapped types and conditional types**: `normalise-interface-type` does not convert `type T = { [K in ...]: ... }` to `interface` — mapped types cannot be expressed as interfaces
- **Intersection types used as interfaces**: `type T = A & B` is not equivalent to `interface T extends A, B` in all cases; do not auto-convert intersections
- **Enums with computed values**: `extract-enum` only applies to unions of string or numeric literals with no computed members
- **Module augmentation**: `merge-declarations` does not merge a local interface with a module augmentation of the same name
- **Type-only imports** (`import type`): always preserved as `import type` after merge/sort
- **`tsconfig.json` path aliases**: resolve path aliases when determining cross-file import paths after type moves
- **Git state**: if `dryRun` is false, create a git commit of the current state before writing (or warn if there are uncommitted changes), so changes can be reverted with `git checkout .`

---

## Success criteria

- `tsc --noEmit` passes with zero errors after all rewrites
- No runtime-visible changes (type aliases, interfaces, and enums do not exist at runtime)
- Every removed type has either been deleted (unused) or replaced with an import of the canonical definition
- All cross-file references updated — no dangling type imports
- Dry-run produces no file writes
- Report accurately lists every change made
