---
name: doc-generator
description: >
  Analyses an existing repository, scaffolds a Nextra documentation app in
  _docs/, auto-generates MDX pages for getting-started, scripts, API, and
  components sections, and produces Excalidraw diagram files for data flows and
  state management. Use when asked to generate documentation, create docs for
  this repo, scaffold a docs site, or create architecture diagrams.
compatibility: Requires Node.js 18+. Installs ts-morph automatically on first run.
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Analyse a repo, scaffold a Nextra docs app in `_docs/`, generate MDX content
for every section, and write Excalidraw diagrams for data flow and state
management — all from a single command.

## Inputs

| Input | Required | Description |
|---|---|---|
| `projectDir` | No | Root of the repo to document (default: `.`) |
| `outputDir` | No | Where to write the docs app (default: `_docs`) |
| `sections` | No | `all` or subset of `getting-started`, `scripts`, `api`, `components`, `diagrams` (default: `all`) |
| `title` | No | Site title (default: inferred from `package.json` `name`) |
| `description` | No | Site description (default: from `package.json` or README) |
| `baseUrl` | No | Base path for deployment (default: `/`) |
| `diagramFormats` | No | `excalidraw` (default) \| `mermaid` \| `both` |
| `dryRun` | No | Analyse and plan without writing (default: `false`) |

## Step 1 — Resolve config and analyse repo

Look for config in this order:
1. `--config <path>` flag
2. `doc-generator.config.json` in the project root
3. Built-in defaults

```bash
node .agents/skills/doc-generator/scripts/generator.js \
  --mode analyze \
  --project-dir <path-to-repo> \
  [--config doc-generator.config.json]
```

The analyser collects:
- `package.json` — name, description, scripts, dependencies, engines
- `README.md` — overview, installation, prerequisites
- Framework detection — Next.js, Vite, CRA, Express, Fastify, plain Node
- Package manager — npm / yarn / pnpm (from lockfile)
- TypeScript — tsconfig.json present
- State management — Redux/RTK, Zustand, Jotai, MobX, React Context
- Test runner — Jest, Vitest, Playwright, Cypress
- API routes — Next.js App/Pages Router, Express, Fastify, tRPC
- React components — `.tsx` / `.jsx` files with JSX return and Props type
- Storybook stories — `.stories.tsx` / `.stories.mdx`
- Environment variables — `.env.example` or `.env.local.example`

Writes `.doc-generator/analysis.json`. Prints a summary of what was found.

Warn if:
- No `package.json` found
- Existing `_docs/` directory — ask whether to overwrite, merge, or abort
- No components or API routes found — those sections will be skipped

## Step 2 — Scaffold Nextra app

```bash
node .agents/skills/doc-generator/scripts/generator.js \
  --mode scaffold \
  --project-dir <path>
```

Creates the Nextra app skeleton in `_docs/`:

```
_docs/
  package.json          ← next + nextra + nextra-theme-docs
  next.config.mjs       ← nextra() wrapper
  theme.config.tsx      ← logo, project link, footer
  tsconfig.json
  .gitignore
  pages/
    _app.mdx
    index.mdx           ← landing page with project overview
    getting-started/
    scripts/
    api/
    components/
  public/
    diagrams/
```

Runs `npm install` (or yarn / pnpm) inside `_docs/` after writing files.

## Step 3 — Generate content

```bash
node .agents/skills/doc-generator/scripts/generator.js \
  --mode generate \
  --project-dir <path>
```

Runs all enabled section generators in sequence.

### Getting Started

Pages: `getting-started/index.mdx`, `installation.mdx`, `configuration.mdx`

- **Overview** — project description + framework detected
- **Prerequisites** — Node version from `engines.node`, package manager, env vars
- **Installation** — clone → install → configure steps, with tabs per package manager
- **Running locally** — the `dev` or `start` script
- **Running tests** — the `test` script
- **Configuration** — table of every key in `.env.example` (key, required/optional, description from inline comment)

### Scripts

Page: `scripts/index.mdx`

One entry per `package.json` script with:
- Human-readable description derived from the command string (heuristics for tsc, vitest, jest, next, prisma, eslint, prettier, etc.)
- Compound commands split and explained step by step
- Code block with package-manager tabs (npm / yarn / pnpm)
- Scripts grouped by prefix (`db:*` → **Database**, `test:*` → **Testing**, etc.)

### API

One MDX page per route group under `api/`.

**Detection:**
- Next.js App Router: `app/api/**/route.ts` — exported `GET`, `POST`, etc.
- Next.js Pages Router: `pages/api/**/*.ts` — default handler with `req.method` switch
- Express / Fastify: `routes/**/*.ts` — `.get()`, `.post()` etc. method chains
- tRPC: `src/server/routers/**/*.ts` — `.query()` and `.mutation()` calls

**Per-endpoint content:**
- HTTP method + path as heading
- Description from JSDoc `@description`
- Auth requirement (detected middleware)
- Query params / body type table from TypeScript types or Zod schema
- Response type block
- `curl` example

### Components

One MDX page per component under `components/`.

**Extraction via ts-morph:**
- Find default/named exports that are functions returning JSX
- Extract Props interface/type (first parameter type)
- Per-prop: name, type string, default value (from default params), required flag, JSDoc description
- Usage example: minimal JSX usage block
- Story examples: if `.stories.tsx` exists, include story code blocks

**Props table columns:** Prop · Type · Default · Required · Description

### Diagrams

**Data flow** (`public/diagrams/data-flow.excalidraw`):

Analyses codebase to map data movement:
- Detects `fetch`/`axios` calls → external API nodes
- Detects Prisma/Drizzle/Mongoose queries → database nodes
- Detects API route exports → API layer nodes
- Detects state store mutations → state nodes
- Detects service/repository patterns → service layer nodes

Layout: left-to-right, Client → API → Services → Data, 200px horizontal / 120px vertical spacing.

**State management** (`public/diagrams/state-management.excalidraw`):

Analyses state files:
- Redux/RTK: `createSlice` → slice name, initial state, action names; `createAsyncThunk` → thunk names
- Zustand: `create()` → store shape and actions
- Jotai: `atom()` calls → atom names and dependencies
- React Context: `createContext()` + `useContext()` → provider/consumer map

Layout: root store at top, slices/sub-stores below, actions at leaves.

**Excalidraw JSON structure:** valid `.excalidraw` v2 format — rectangles, text elements, and arrows with start/end bindings. Node colours distinguish Client (blue), API (green), Service (yellow), Database (orange), External (purple), State (pink).

## Step 4 — Validate

```bash
node .agents/skills/doc-generator/scripts/generator.js \
  --mode validate \
  --project-dir <path>
```

Runs `next build` inside `_docs/`. If it fails, prints the MDX files that have syntax errors. Validates each `.excalidraw` file is valid JSON.

## Step 5 — Report and run

Prints a summary of all pages and diagrams created, then the command to start the docs dev server:

```
Documentation generated → _docs/

Pages:
  getting-started/    3 pages
  scripts/            1 page   (14 scripts)
  api/                6 pages  (23 endpoints)
  components/        18 pages

Diagrams:
  data-flow.excalidraw          (12 nodes, 18 arrows)
  state-management.excalidraw   (8 nodes, 14 arrows)

Start dev server:
  cd _docs && npm run dev   →  http://localhost:3000
```

## Convenience: full pipeline

```bash
node .agents/skills/doc-generator/scripts/generator.js \
  --mode run \
  --project-dir <path> \
  [--config doc-generator.config.json] \
  [--dry-run]
```

Runs Steps 1–5 in sequence.

## Available scripts

- **`scripts/generator.js`** — main worker. Run with `--help` for full usage.

## Output structure

```
_docs/
  package.json
  next.config.mjs
  theme.config.tsx
  tsconfig.json
  .gitignore
  pages/
    _app.mdx
    index.mdx
    _meta.json
    getting-started/
      _meta.json
      index.mdx
      installation.mdx
      configuration.mdx
    scripts/
      index.mdx
    api/
      _meta.json
      index.mdx
      <route-group>.mdx    ← one per group
    components/
      _meta.json
      index.mdx
      <ComponentName>.mdx  ← one per component
  public/
    diagrams/
      data-flow.excalidraw
      state-management.excalidraw
```

## Edge cases

- **No README.md**: generate Getting Started from `package.json` alone
- **No TypeScript**: skip type extraction; document what can be inferred from JSDoc
- **No components found**: skip Components section, note in report
- **No API routes found**: skip API section, note in report
- **No state management detected**: skip state diagram, note in report
- **Monorepo**: if multiple `package.json` found, ask which package(s) before proceeding
- **Existing `_docs/`**: ask to overwrite / merge (add new pages only) / abort
- **Private keys**: never write `.env` values into docs — keys only
- **Large component library (50+ components)**: generate an index grouping by folder instead of one page per component
- **`.d.ts` files**: skip for component extraction (declaration files are not components)
