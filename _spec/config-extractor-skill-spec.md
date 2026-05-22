# Skill Spec: Config Extractor

## Goal

Scan an entire repository, identify all hardcoded values that belong in configuration, extract them into the appropriate config files (`.env`, typed config modules, constants files, feature flag files), and replace the original hardcoded values with references — without changing runtime behaviour.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "extract config from the codebase"
- "move hardcoded values to config"
- "find magic numbers / hardcoded URLs"
- "create config files from the repo"
- "externalise configuration"

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | Path to scan (default: entire repo) |
| `exclude` | No | Paths to skip (default: `node_modules`, `dist`, `build`, `.git`, `coverage`, `*.test.*`, `*.spec.*`) |
| `extensions` | No | File extensions to process (default: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) |
| `categories` | No | Which extraction categories to run — `all` or a subset (default: `all`) — see Categories |
| `output` | No | Where to write config files (default: `config/` for modules, `.env.example` at root) |
| `envFile` | No | Path to write the env template (default: `.env.example`) |
| `configModule` | No | Path to write the typed config module (default: `config/config.ts`) |
| `flagsModule` | No | Path to write the feature flags module (default: `config/feature-flags.ts`) |
| `constantsModule` | No | Path to write the constants module (default: `config/constants.ts`) |
| `threshold` | No | Min occurrences for a repeated literal to be extracted (default: `2`) |
| `dryRun` | No | Preview findings without writing (default: `false`) |
| `replace` | No | Rewrite source files with references after extraction (default: `true`) |
| `framework` | No | `auto` (default), `nextjs`, `node`, `vite`, `react` — affects import style and env access pattern |

---

## Config file

The skill reads `config-extractor.config.json` from the project root, then falls back to built-in defaults. CLI flags override config file values.

**Full config with defaults:**

```json
{
  "target": ".",
  "exclude": ["node_modules", "dist", "build", ".git", "coverage"],
  "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  "categories": "all",
  "output": "config",
  "envFile": ".env.example",
  "configModule": "config/config.ts",
  "flagsModule": "config/feature-flags.ts",
  "constantsModule": "config/constants.ts",
  "threshold": 2,
  "dryRun": false,
  "replace": true,
  "framework": "auto",
  "categories_config": {
    "urls": {
      "enabled": true,
      "destination": "env",
      "patterns": ["http://", "https://", "ws://", "wss://"]
    },
    "ports": {
      "enabled": true,
      "destination": "env"
    },
    "secrets": {
      "enabled": true,
      "destination": "env",
      "minLength": 16,
      "namePatterns": ["key", "secret", "token", "password", "auth", "credential", "api_key"]
    },
    "timeouts": {
      "enabled": true,
      "destination": "config",
      "units": ["ms", "s", "min"],
      "contextKeywords": ["timeout", "delay", "interval", "ttl", "expiry", "duration", "retry"]
    },
    "limits": {
      "enabled": true,
      "destination": "config",
      "contextKeywords": ["limit", "max", "min", "size", "count", "length", "threshold", "batch", "page", "rate"]
    },
    "featureFlags": {
      "enabled": true,
      "destination": "flags",
      "namePatterns": ["enable", "disable", "feature", "flag", "toggle", "show", "hide", "allow", "block"]
    },
    "repeated": {
      "enabled": true,
      "destination": "constants",
      "threshold": 2
    },
    "paths": {
      "enabled": true,
      "destination": "constants",
      "patterns": ["/uploads/", "/tmp/", "/static/", "public/"]
    },
    "magic-numbers": {
      "enabled": true,
      "destination": "constants",
      "skip": [0, 1, -1, 2, 100]
    }
  }
}
```

---

## Extraction categories

### `urls`

Find hardcoded HTTP/HTTPS/WebSocket URL strings.

```ts
// before
const res = await fetch('https://api.example.com/v1/users')

// after
const res = await fetch(`${process.env.API_BASE_URL}/v1/users`)
```

**Detection:**
- String literals starting with `http://`, `https://`, `ws://`, `wss://`
- Template literals containing a full domain
- Excludes `localhost` and `127.0.0.1` for the base only (path segments are kept)
- Excludes test and documentation files

**Output destination:** `.env.example`

**Naming:** derive from context — containing variable name, function name, or import alias. `fetch('https://api.stripe.com/v1')` → `STRIPE_API_URL`. Unknown: `API_URL_1`.

---

### `ports`

Find hardcoded port numbers.

```ts
// before
app.listen(3000)

// after
app.listen(Number(process.env.PORT) || 3000)
```

**Detection:**
- Numeric literals in port-suggestive contexts: `listen(`, `createServer(`, `port:`, `:PORT`, `PORT=`
- Common port values: 80, 443, 3000, 3001, 4000, 5000, 8000, 8080, 8443

**Output destination:** `.env.example`

---

### `secrets`

Find hardcoded credentials, API keys, tokens, and passwords.

```ts
// before
const client = new Stripe('sk_live_aBcDeFgHiJkLmNoPqRsTuVwXyZ')

// after
const client = new Stripe(process.env.STRIPE_SECRET_KEY!)
```

**Detection:**
- String literals ≥ `minLength` characters that look like keys (high entropy, alphanumeric + special chars)
- Variables/params whose name matches `namePatterns` (case-insensitive)
- Values matching known credential patterns: `sk_live_`, `pk_live_`, `Bearer `, `ghp_`, `xoxb-` (Slack), AWS key patterns
- Any string that appears to be a JWT (`ey...`)

**Important:** secrets always go to `.env.example`, never to a committed config module. Flag any discovered secret in the report regardless of whether it is extracted.

**Output destination:** `.env.example`

---

### `timeouts`

Find hardcoded timing values.

```ts
// before
setTimeout(callback, 5000)
await retry({ delay: 1000, retries: 3 })

// after (config module)
import { config } from '@/config/config'
setTimeout(callback, config.RETRY_DELAY_MS)
await retry({ delay: config.RETRY_DELAY_MS, retries: config.MAX_RETRIES })
```

**Detection:**
- Numeric literals in contexts containing `contextKeywords` in the surrounding variable name, function argument name, object key, or JSDoc comment
- Time unit suffixes in nearby comments: `// 5 seconds`, `/* 1 min */`
- Common timeout patterns: `setTimeout`, `setInterval`, `AbortSignal.timeout`, `axios.create({ timeout: ... })`

**Naming:** `CONTEXT_UNIT` — e.g. `SESSION_TTL_MS`, `REQUEST_TIMEOUT_MS`, `RETRY_DELAY_MS`.

**Output destination:** `config/config.ts`

---

### `limits`

Find hardcoded limit, size, count, and threshold values.

```ts
// before
const users = await db.user.findMany({ take: 20 })
if (content.length > 5000) throw new Error('too large')

// after
import { config } from '@/config/config'
const users = await db.user.findMany({ take: config.PAGE_SIZE })
if (content.length > config.MAX_CONTENT_LENGTH) throw new Error('too large')
```

**Detection:**
- Numeric literals in contexts containing `contextKeywords`
- Numeric literals passed as named arguments whose name contains a context keyword
- Repeated numeric values across files (threshold-based)

**Naming:** derive from the surrounding context key or variable: `take: 20` → `PAGE_SIZE`, `maxRetries: 3` → `MAX_RETRIES`.

**Output destination:** `config/config.ts`

---

### `featureFlags`

Find boolean constants and conditions used to enable/disable features.

```ts
// before
const ENABLE_DARK_MODE = true
const SHOW_BETA_BANNER = false
if (ENABLE_DARK_MODE) { ... }

// after
import { flags } from '@/config/feature-flags'
if (flags.ENABLE_DARK_MODE) { ... }
```

**Detection:**
- `const NAME = true | false` where `NAME` matches `namePatterns`
- Object literals with boolean values where keys match patterns: `{ enableDarkMode: true }`
- `process.env.FEATURE_*` already in use (include in the flags module as a reference)

**Naming:** `SCREAMING_SNAKE_CASE` of the original identifier.

**Output destination:** `config/feature-flags.ts`

---

### `repeated`

Find string or numeric literals that appear ≥ `threshold` times across the codebase and are not already extracted.

```ts
// before (appears in 4 files)
'application/json'

// after
import { CONTENT_TYPE_JSON } from '@/config/constants'
```

**Detection:**
- String literals with ≥ threshold occurrences
- Numeric literals (excluding `0`, `1`, `-1`, values in `magic-numbers.skip`) with ≥ threshold occurrences
- Group by exact value and count cross-file occurrences

**Naming:** attempt to derive from surrounding variable/key names. Fallback: slugified value in SCREAMING_SNAKE_CASE.

**Output destination:** `config/constants.ts`

---

### `paths`

Find hardcoded file system paths and URL path prefixes.

```ts
// before
const uploadDir = '/var/uploads/avatars'
res.redirect('/auth/login')

// after
import { paths } from '@/config/constants'
const uploadDir = paths.UPLOAD_DIR_AVATARS
res.redirect(paths.AUTH_LOGIN)
```

**Detection:**
- String literals starting with `/` that contain at least one more `/` segment (not single-segment paths like `'/api'`)
- Absolute paths starting with common roots: `/var/`, `/tmp/`, `/etc/`, `/home/`
- Relative paths matching `patterns` from config

**Output destination:** `config/constants.ts`

---

### `magic-numbers`

Find numeric literals used in non-obvious positions that have no surrounding context to derive a name from.

```ts
// before
const hash = value % 31

// after
import { HASH_PRIME } from '@/config/constants'
const hash = value % HASH_PRIME
```

**Detection:**
- Numeric literals not in `skip` list, not preceded by a descriptive variable assignment on the same line
- Excludes: array indices, loop counters (`i++`), simple arithmetic with `0`/`1`, version numbers

**Naming:** flag for manual review if no contextual name can be derived. Generate a placeholder: `MAGIC_NUMBER_<value>` and include in the warnings section of the report.

**Output destination:** `config/constants.ts`

---

## Output files

### `.env.example`

Template env file — keys with placeholder values, grouped by category, never contains real values:

```bash
# URLs
API_BASE_URL=https://api.example.com
STRIPE_API_URL=https://api.stripe.com/v1

# Ports
PORT=3000

# Secrets (never commit real values)
STRIPE_SECRET_KEY=
JWT_SECRET=
DATABASE_URL=
```

If an `.env.example` already exists, merge: add new keys at the bottom of the appropriate group, never overwrite existing keys.

### `config/config.ts`

Typed configuration module that reads from `process.env` with defaults:

```ts
export const config = {
  // Timeouts
  REQUEST_TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS) || 5000,
  RETRY_DELAY_MS:     Number(process.env.RETRY_DELAY_MS)     || 1000,

  // Limits
  PAGE_SIZE:          Number(process.env.PAGE_SIZE)           || 20,
  MAX_CONTENT_LENGTH: Number(process.env.MAX_CONTENT_LENGTH)  || 5000,
  MAX_RETRIES:        Number(process.env.MAX_RETRIES)         || 3,
} as const

export type Config = typeof config
```

### `config/feature-flags.ts`

Boolean flags — can be driven by env vars for runtime toggling:

```ts
export const flags = {
  ENABLE_DARK_MODE:   process.env.ENABLE_DARK_MODE   === 'true' || true,
  SHOW_BETA_BANNER:   process.env.SHOW_BETA_BANNER   === 'true' || false,
} as const

export type Flags = typeof flags
```

### `config/constants.ts`

Compile-time constants that never change between environments:

```ts
export const CONTENT_TYPE_JSON = 'application/json'
export const HASH_PRIME = 31

export const paths = {
  UPLOAD_DIR_AVATARS: '/var/uploads/avatars',
  AUTH_LOGIN: '/auth/login',
} as const
```

---

## Replacement rules

After extracting values, rewrite source files to use the config references. Applies only when `replace: true`.

**Import insertion:**
- If the file already imports from the target module, add the new name to the existing import
- Otherwise insert a new import at the top of the file, after existing imports
- For env vars, no import is needed — replace inline with `process.env.VAR_NAME`

**Framework-specific env access patterns:**

| Framework | Pattern |
|---|---|
| Next.js (server) | `process.env.VAR_NAME` |
| Next.js (client) | `process.env.NEXT_PUBLIC_VAR_NAME` |
| Vite | `import.meta.env.VITE_VAR_NAME` |
| Node / generic | `process.env.VAR_NAME` |

**Replacement examples by category:**

```ts
// url → env
'https://api.example.com'  →  process.env.API_BASE_URL!

// timeout → config module
5000  →  config.REQUEST_TIMEOUT_MS   (with import { config } from '@/config/config')

// feature flag → flags module
const ENABLE_X = true  →  (declaration removed; usages rewritten)
ENABLE_X  →  flags.ENABLE_X   (with import { flags } from '@/config/feature-flags')

// repeated constant → constants module
'application/json'  →  CONTENT_TYPE_JSON   (with import { CONTENT_TYPE_JSON } from '@/config/constants')
```

**Never replace:**
- Values inside comments
- Values in test files (they test the logic, not the config)
- Values in type definitions and interfaces (they are type constraints, not runtime values)
- Values inside `.env*` files themselves
- Literal `0`, `1`, `-1` in any context

---

## Behaviour

### 1. Discover files

Recursively find all files matching `extensions` under `target`, excluding `exclude` paths and `.gitignore` entries.

Auto-detect framework from `package.json` if `framework` is `auto`.

### 2. Analysis pass

Parse each file using the TypeScript compiler API. For each enabled category, run the detector and collect findings without writing anything.

Each finding records:
- Category
- File and line number
- The raw value
- Proposed variable name
- Destination (`env`, `config`, `flags`, `constants`)
- Occurrences (list of all files and lines)
- Confidence: `high` (clear context) | `medium` (inferred) | `low` (no context — manual review needed)

Write findings to `.config-extractor/findings.json`.

### 3. Confirmation

For findings with `confidence: low` (magic numbers with no context, ambiguous literals), show each one and ask the user to:
- Approve the proposed name
- Provide a better name
- Skip this finding

Auto-apply all `high` and `medium` confidence findings without prompting.

### 4. Generate config files

Write the output files following the structure above.

**Merge behaviour:**
- Existing `.env.example`: add new keys, never overwrite
- Existing `config/config.ts`: add new keys to the export object
- Existing `config/constants.ts`: add new exports at the end
- Existing `config/feature-flags.ts`: add new flags to the export object

### 5. Rewrite source files

If `replace: true`, update all source files to use the new references (follow replacement rules above). Process files in dependency order so imports are valid by the time downstream files are processed.

### 6. Validation

Run `tsc --noEmit` (if TypeScript) to verify no type errors were introduced. If errors appear, show them and offer to revert via `git checkout .`.

### 7. Report

Write `.config-extractor/report.md`:

```
## Config Extractor Report

Date: 2026-05-21
Files scanned:     47
Files modified:    12

### Extracted by category

| Category       | Extracted | Destination        |
|---|---|---|
| urls           | 4         | .env.example       |
| secrets        | 2         | .env.example       |
| timeouts       | 6         | config/config.ts   |
| limits         | 9         | config/config.ts   |
| feature-flags  | 3         | config/feature-flags.ts |
| repeated       | 7         | config/constants.ts |
| paths          | 4         | config/constants.ts |
| magic-numbers  | 2         | config/constants.ts |

### Security flags

The following hardcoded secrets were found and extracted to .env.example.
⚠ Remove these from git history if they were ever committed:
  src/lib/stripe.ts:12  — STRIPE_SECRET_KEY

### Manual review needed (low confidence)

  src/utils/hash.ts:8   value=31   proposed=HASH_PRIME
  src/cache.ts:44       value=512  proposed=CACHE_MAX_ENTRIES

### Skipped (test files)

  src/components/Button.test.tsx  — 3 occurrences skipped
```

---

## Pipeline order

Apply extractions in this order to avoid one extraction interfering with another:

1. `secrets` — always first, flag security issues immediately
2. `urls` — before `repeated` (URL strings should be env vars, not constants)
3. `ports` — straightforward env vars
4. `featureFlags` — before repeated (booleans should be flags, not constants)
5. `timeouts`, `limits` — before `magic-numbers` (give context-derived names first)
6. `paths` — before `repeated`
7. `repeated` — catches everything remaining
8. `magic-numbers` — last, lowest confidence

---

## Edge cases and constraints

- **Secrets already in `.env.example`**: do not duplicate; flag that the secret was found hardcoded in source and needs to be removed from history
- **Next.js `NEXT_PUBLIC_*` prefix**: any URL or value used in client-side code must be prefixed `NEXT_PUBLIC_` in the env file; detect client-side usage by checking if the file is inside `app/`, `pages/` (non-API), or `src/components/`
- **Vite `import.meta.env`**: use `VITE_` prefix for client-exposed vars
- **Test files**: analyse to count occurrences for `repeated`, but never rewrite — test files should use their own literal values or test fixtures
- **String template literals**: if the entire literal is a URL, extract the base; if a URL is embedded in a larger template, extract only the domain as a variable and leave the template structure
- **Barrel files**: do not add imports to `index.ts` re-export files
- **Values used as types**: `type Status = 'pending' | 'active'` — literals here are type constraints, not runtime config; skip them
- **Duplicate proposed names**: if two different values would generate the same name, append `_2`, `_3` etc.
- **Values in JSON files** (e.g. `package.json`, `tsconfig.json`): analyse only, flag but do not rewrite — JSON config files are not TypeScript modules
- **`.env` files already present**: read existing keys to avoid proposing names that are already defined; warn if a hardcoded value matches an existing env var value (it should already be using `process.env`)
- **`as const` objects**: treat the values inside as candidates for extraction just like standalone literals
- **Uncommitted changes**: warn before running with `replace: true`; changes can be reverted with `git checkout .`

---

## Success criteria

- All extracted values are accessible at runtime through their new references
- `tsc --noEmit` passes after rewrites
- No real secret values appear in any committed file
- Dry-run produces no file writes
- Existing `.env.example` keys are never overwritten
- Report accurately lists every extraction and every security flag
