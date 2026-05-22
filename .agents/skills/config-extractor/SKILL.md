---
name: config-extractor
description: >
  Scans a TypeScript/JavaScript repository for hardcoded values that belong in
  configuration — URLs, secrets, ports, timeouts, limits, feature flags,
  repeated literals, paths, and magic numbers — extracts them into
  .env.example, config/config.ts, config/feature-flags.ts, and
  config/constants.ts, then rewrites source files to use the new references.
  Use when asked to extract config, move hardcoded values to config, find
  magic numbers, or externalise configuration.
compatibility: Requires Node.js 18+. Installs ts-morph automatically on first run.
metadata:
  author: the-morning-bell
  version: "1.0"
---

## Overview

Extract hardcoded values from a codebase into typed config, env, flags, and
constants files. All eight extraction categories are individually configurable.
Source files are rewritten to reference the new config modules.

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | Path to scan (default: `.`) |
| `exclude` | No | Paths to skip (default: `node_modules`, `dist`, `build`, `.git`) |
| `extensions` | No | File extensions (default: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`) |
| `categories` | No | `all` or a subset (default: `all`) — see Categories |
| `output` | No | Directory for config modules (default: `config/`) |
| `envFile` | No | Path for env template (default: `.env.example`) |
| `threshold` | No | Min occurrences for `repeated` category (default: `2`) |
| `dryRun` | No | Preview only, no writes (default: `false`) |
| `replace` | No | Rewrite source files with references (default: `true`) |
| `framework` | No | `auto` \| `nextjs` \| `vite` \| `node` (default: `auto`) |

## Step 1 — Resolve config

Look for config in this order:
1. `--config <path>` flag
2. `config-extractor.config.json` in the project root
3. Built-in defaults

```bash
node .agents/skills/config-extractor/scripts/extractor.js \
  --mode analyze \
  --project-dir <path> \
  [--config config-extractor.config.json]
```

Auto-detect framework from `package.json` (`next` → nextjs, `vite` → vite).

Warn if:
- Uncommitted git changes present (`replace: true` could be hard to revert)
- `.env` file already exists with real values — never read or expose those values

## Step 2 — Analyze

Scan all matching files with ts-morph, run all enabled detectors, collect
findings **without writing anything**.

```bash
node .agents/skills/config-extractor/scripts/extractor.js \
  --mode analyze \
  --project-dir <path>
```

Detectors run in this order (so higher-priority categories claim values first):
1. `secrets` — high-entropy strings, known credential prefixes, secret-named vars
2. `urls` — `http://`, `https://`, `ws://`, `wss://` string literals
3. `ports` — numeric literals in port-suggestive contexts
4. `feature-flags` — `const ENABLE_X = true/false` boolean constants
5. `timeouts` — numerics in timeout/delay/ttl/interval contexts
6. `limits` — numerics in limit/max/min/size/count/rate contexts
7. `paths` — string literals that are file system or URL path prefixes
8. `repeated` — any literal appearing ≥ threshold times not already claimed
9. `magic-numbers` — remaining unclaimed numerics with no contextual name

Each finding records: `category`, `value`, `varName` (proposed), `destination`
(`env` | `config` | `flags` | `constants`), `occurrences` (file + line + offset
+ raw text), `confidence` (`high` | `medium` | `low`).

Writes `.config-extractor/findings.json`.

Prints a summary table:

```
Category        Findings  Destination               Auto-apply
secrets              2    .env.example              yes
urls                 4    .env.example              yes
ports                1    .env.example              yes
feature-flags        3    config/feature-flags.ts   yes
timeouts             6    config/config.ts          yes
limits               9    config/config.ts          yes
paths                4    config/constants.ts       yes
repeated             7    config/constants.ts       yes
magic-numbers        2    config/constants.ts       confirm
────────────────────────────────────────────────────────
Total               38
```

If `dryRun` is `true`, stop here.

## Step 3 — Confirm low-confidence findings

For `magic-numbers` and other `confidence: low` findings, show each one and
ask the user to approve the proposed name, supply a better name, or skip.
All `high` and `medium` confidence findings are applied automatically.

## Step 4 — Generate config files

```bash
node .agents/skills/config-extractor/scripts/extractor.js \
  --mode generate \
  --project-dir <path>
```

Writes four output files. Merge behaviour on existing files: add new
entries, never overwrite existing keys.

**`.env.example`** — secrets, URLs, ports:
```bash
# URLs
API_BASE_URL=https://api.example.com

# Secrets (never commit real values)
STRIPE_SECRET_KEY=
JWT_SECRET=

# Ports
PORT=3000
```

**`config/config.ts`** — timeouts and limits with env-var fallbacks:
```ts
export const config = {
  REQUEST_TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS) || 5000,
  PAGE_SIZE:          Number(process.env.PAGE_SIZE)           || 20,
} as const
```

**`config/feature-flags.ts`** — boolean toggles:
```ts
export const flags = {
  ENABLE_DARK_MODE: process.env.ENABLE_DARK_MODE === 'true' || true,
} as const
```

**`config/constants.ts`** — compile-time constants, repeated literals, paths:
```ts
export const CONTENT_TYPE_JSON = 'application/json'
export const HASH_PRIME = 31
export const paths = {
  UPLOAD_DIR: '/var/uploads',
} as const
```

## Step 5 — Rewrite source files

```bash
node .agents/skills/config-extractor/scripts/extractor.js \
  --mode replace \
  --project-dir <path>
```

Only runs when `replace: true`. Applies text replacements in reverse
position order (bottom-to-top) so offsets stay valid.

**Replacement patterns by destination:**

| Destination | Replacement | Import added |
|---|---|---|
| `env` (node/nextjs server) | `process.env.VAR_NAME!` | none |
| `env` (nextjs client) | `process.env.NEXT_PUBLIC_VAR_NAME!` | none |
| `env` (vite client) | `import.meta.env.VITE_VAR_NAME` | none |
| `config` | `config.VAR_NAME` | `import { config } from '@/config/config'` |
| `flags` | `flags.VAR_NAME` | `import { flags } from '@/config/feature-flags'` |
| `constants` | `CONST_NAME` | `import { CONST_NAME } from '@/config/constants'` |

For **feature flag declarations** (`const ENABLE_X = true`): the variable
statement is removed entirely; all identifier usages of `ENABLE_X` across
the file are replaced with `flags.ENABLE_X`.

Imports are inserted after the last existing import declaration. If the file
already imports from the target module, the new identifier is added to the
existing import.

**Never replace** values in: comments, test files (`*.test.*`, `*.spec.*`),
type-only positions, `.env*` files, JSON files.

## Step 6 — Validate

```bash
node .agents/skills/config-extractor/scripts/extractor.js \
  --mode validate \
  --project-dir <path>
```

Runs `tsc --noEmit` if `tsconfig.json` exists. On errors: print them, offer
`git checkout .` to revert.

## Step 7 — Report

Writes `.config-extractor/report.md`:
- Extraction table (category, count, destination)
- Security flags: any discovered secrets with file + line
- Manual review items: low-confidence findings
- Skipped items: test files, type positions

## Convenience: full pipeline

```bash
node .agents/skills/config-extractor/scripts/extractor.js \
  --mode run \
  --project-dir <path> \
  [--config config-extractor.config.json] \
  [--dry-run]
```

## Available scripts

- **`scripts/extractor.js`** — main worker. Run with `--help` for full usage.

## Edge cases

- **Secrets already in `.env.example`**: do not duplicate; flag that the value was also found hardcoded in source
- **Next.js client env vars**: values used in `app/`, `pages/` (non-`api/`), or `components/` get `NEXT_PUBLIC_` prefix automatically
- **Test files**: counted toward `repeated` threshold but never rewritten
- **Type positions**: `type Status = 'active' | 'inactive'` — literals are type constraints, not runtime config; skip them
- **String template literals**: if the whole expression is a URL, extract the origin as an env var; if a URL is embedded in a larger template, extract only the hostname
- **Barrel files** (`index.ts` with only re-exports): imports updated if a referenced name moves, but no new imports or replacements added
- **Duplicate proposed names**: append `_2`, `_3` if two different values generate the same name
- **JSON config files** (`package.json`, `tsconfig.json`): analyse for counting only, never rewrite
- **Uncommitted changes**: warn before replacing; `git checkout .` reverts everything
