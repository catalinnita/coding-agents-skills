---
name: type-cleaner
description: >
  Analyses all TypeScript source files in a repo, applies configurable type
  hygiene rules (deduplication, redundancy removal, enum extraction,
  normalisation, cleanup, organisation), and rewrites files in place. Use when
  asked to clean up types, deduplicate types, generate enums, unify
  declarations, or remove redundant type rules like ? and undefined.
compatibility: Requires Node.js 18+. Installs ts-morph automatically on first run.
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

TypeScript type hygiene — deduplicate, simplify, normalise, and clean types
across a codebase. All rules are configurable via `type-cleaner.config.json`.
Changes are validated with `tsc --noEmit` before saving.

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | Path to scan (default: `.`) |
| `rules` | No | Rule IDs or `"all"` (default: `"all"`) |
| `exclude` | No | Paths to skip (default: `node_modules`, `dist`, `build`, `.git`, `coverage`) |
| `extensions` | No | File extensions (default: `.ts`, `.tsx`) |
| `dryRun` | No | Preview without writing (default: `false`) |
| `threshold` | No | Similarity ratio for partial-dup detection (default: `0.8`) |
| `enumStyle` | No | `enum` \| `const-enum` \| `string-union` (default: `enum`) |
| `preferInterface` | No | Prefer `interface` over `type` for object shapes (default: `true`) |
| `sortMembers` | No | Sort interface members alphabetically (default: `false`) |
| `anyPolicy` | No | `flag` \| `replace-unknown` \| `ignore` (default: `flag`) |
| `report` | No | Write markdown report (default: `true`) |

## Step 1 — Resolve config

Look for config in this order:
1. `--config <path>` flag
2. `type-cleaner.config.json` in the project root (walk up to git root)
3. Built-in defaults

```bash
node .agents/skills/type-cleaner/scripts/cleaner.js \
  --mode analyze \
  --project-dir <path-to-ts-project> \
  [--config type-cleaner.config.json]
```

Surface the effective config (which rules are active, target, exclusions) to
the user before any changes are made.

**Warn if:**
- No `tsconfig.json` found in the project directory
- Uncommitted git changes exist (changes cannot easily be reverted without a clean tree)
- `node_modules` does not exist (dependencies may not be installed)

## Step 2 — Analyze

Run all enabled rules in **read-only** mode across all files. Collect findings
without writing anything:

```bash
node .agents/skills/type-cleaner/scripts/cleaner.js \
  --mode analyze \
  --project-dir <path> \
  --config <config>
```

Writes `<project-dir>/.type-cleaner/findings.json`:

```json
{
  "files": 47,
  "findings": [
    {
      "rule": "remove-optional-undefined",
      "file": "src/types.ts",
      "line": 12,
      "description": "Remove '| undefined' from optional property 'name'",
      "before": "name?: string | undefined",
      "after":  "name?: string",
      "autoApply": true
    }
  ],
  "flags": [...],
  "stats": { "byRule": { "remove-optional-undefined": 14 } }
}
```

Print a summary table to stdout:

```
Rule                        Findings   Auto-apply
remove-optional-undefined      14         yes
remove-wrapper-types            6         yes
extract-enum                    2         confirm
flag-any                       23         flag only
```

If `dryRun` is `true`, stop here.

## Step 3 — Confirm interactive rules

For rules with `requireConfirmation: true`
(`extract-enum`, `dedup-partial`, `remove-null-undefined-strict`,
`extract-discriminated-union`), show each proposed change and ask the user to
approve or skip before continuing.

Auto-apply rules proceed without prompting.

## Step 4 — Transform

Apply all approved findings:

```bash
node .agents/skills/type-cleaner/scripts/cleaner.js \
  --mode transform \
  --project-dir <path> \
  --config <config>
```

Rules are applied in pipeline order (defined in the spec):

1. `merge-declarations`
2. `dedup-identical`
3. `remove-unused-types`
4. Redundancy group: `remove-optional-undefined`, `remove-never-union`,
   `remove-unknown-intersection`, `remove-duplicate-union-members`,
   `flatten-nested-unions`
5. Substitution group: `remove-noop-utility`, `remove-wrapper-types`
6. Normalisation group: `normalise-interface-type`, `normalise-array-type`
7. Extraction group: `extract-enum`
8. Organisation group: `sort-members`, `sort-union-members`
9. Import cleanup: `sort-imports`, `remove-unused-imports`, `dedup-imports`
10. Flags only (no writes): `flag-any`, `flag-object-type`

Each stage saves files before the next stage begins.

## Step 5 — Validate

```bash
node .agents/skills/type-cleaner/scripts/cleaner.js \
  --mode validate \
  --project-dir <path>
```

Runs `tsc --noEmit`. If errors appear: print them, offer to revert via
`git checkout .`, and never leave the project with new type errors.

## Step 6 — Report

```bash
node .agents/skills/type-cleaner/scripts/cleaner.js \
  --mode report \
  --project-dir <path> \
  --config <config>
```

Writes `type-cleaner-report.md` (or `reportPath` from config) summarising
every change made, every flag raised, and every rule that found nothing.

## Convenience: full pipeline

```bash
node .agents/skills/type-cleaner/scripts/cleaner.js \
  --mode run \
  --project-dir <path> \
  [--config <config>] \
  [--dry-run]
```

## Available scripts

- **`scripts/cleaner.js`** — main worker. Run with `--help` for full usage.

## Implemented rules

| Rule | Category | Auto-apply |
|---|---|---|
| `merge-declarations` | Deduplication | yes |
| `dedup-identical` | Deduplication | yes (within-file); flag cross-file |
| `dedup-imports` | Deduplication | yes |
| `remove-optional-undefined` | Redundancy | yes |
| `remove-never-union` | Redundancy | yes |
| `remove-unknown-intersection` | Redundancy | yes |
| `remove-duplicate-union-members` | Redundancy | yes |
| `flatten-nested-unions` | Redundancy | yes |
| `remove-noop-utility` | Redundancy | yes |
| `remove-wrapper-types` | Redundancy | yes |
| `extract-enum` | Extraction | confirm |
| `normalise-interface-type` | Normalisation | yes |
| `normalise-array-type` | Normalisation | yes |
| `remove-unused-types` | Cleanup | yes (non-.d.ts) |
| `remove-unused-imports` | Cleanup | yes |
| `flag-any` | Cleanup | flag only |
| `flag-object-type` | Cleanup | flag only |
| `sort-members` | Organisation | yes (when enabled) |
| `sort-union-members` | Organisation | yes (when enabled) |
| `sort-imports` | Organisation | yes |

## Edge cases

- **`.d.ts` files**: flag-only, never rewritten
- **Barrel files**: import paths updated when a type moves, re-exports never removed
- **Mapped/conditional types**: `normalise-interface-type` skips them
- **Generic constraints**: `any` in `T extends any` skipped by `flag-any`
- **Ambient declarations**: flag-only
- **`import type`**: always preserved as `import type` after merging/sorting
- **Uncommitted changes**: warn before running with `dryRun: false`
