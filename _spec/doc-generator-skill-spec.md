# Skill Spec: Documentation Generator

## Goal

Analyse an existing repository, scaffold a Nextra documentation app in `_docs/`, auto-generate MDX content for getting started, scripts, API, and components sections, and produce Excalidraw diagram files for data flows and state management.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "generate documentation"
- "create docs for this repo"
- "scaffold a docs site"
- "document the API / components / scripts"
- "create excalidraw diagrams for this codebase"

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `projectDir` | No | Root of the repo to document (default: `.`) |
| `outputDir` | No | Where to write the docs app (default: `_docs`) |
| `sections` | No | Sections to generate: `all`, or any subset of `getting-started`, `scripts`, `api`, `components`, `diagrams` (default: `all`) |
| `title` | No | Documentation site title (default: inferred from `package.json` `name`) |
| `description` | No | Site description (default: inferred from `package.json` `description` or `README.md` first paragraph) |
| `baseUrl` | No | Base path for the deployed site (default: `/`) |
| `theme` | No | Nextra theme: `docs` (default) \| `blog` |
| `diagramFormats` | No | `excalidraw` (default) \| `mermaid` \| `both` |
| `dryRun` | No | Scaffold and analyse without writing (default: `false`) |

---

## Config file

The skill reads `doc-generator.config.json` from the project root, then falls back to built-in defaults. CLI flags override config file values.

**Full config with defaults:**

```json
{
  "projectDir": ".",
  "outputDir": "_docs",
  "sections": "all",
  "title": null,
  "description": null,
  "baseUrl": "/",
  "theme": "docs",
  "diagramFormats": "excalidraw",
  "dryRun": false,
  "api": {
    "sources": ["src/api", "src/routes", "app/api", "pages/api", "server"],
    "includeTypes": true,
    "includeExamples": true
  },
  "components": {
    "sources": ["src/components", "components", "src/ui", "ui"],
    "includeProps": true,
    "includeExamples": true,
    "includeStories": true
  },
  "diagrams": {
    "dataFlow": true,
    "stateManagement": true,
    "outputFormat": "excalidraw"
  }
}
```

---

## Output structure

```
_docs/
  package.json              ← Nextra + Next.js dependencies
  next.config.mjs           ← Nextra configuration
  theme.config.tsx          ← Nextra theme settings (title, logo, navbar)
  tsconfig.json
  .gitignore
  pages/
    _app.mdx                ← global layout
    index.mdx               ← landing page
    getting-started/
      index.mdx             ← overview + prerequisites
      installation.mdx      ← setup steps
      configuration.mdx     ← env vars, config files
    scripts/
      index.mdx             ← all scripts from package.json
    api/
      index.mdx             ← API overview
      <route-group>.mdx     ← one page per route group
    components/
      index.mdx             ← component library overview
      <ComponentName>.mdx   ← one page per component
  public/
    diagrams/
      data-flow.excalidraw
      state-management.excalidraw
  _meta.json                ← Nextra sidebar order and labels
```

---

## Behavior

### 1. Resolve config and analyse repo

Load config, then analyse the project:

- Read `package.json` — name, description, scripts, dependencies, devDependencies
- Read `README.md` — extract getting-started content, installation instructions, prerequisites
- Detect framework: Next.js, Vite, CRA, Express, Fastify, Hono, plain Node — from dependencies and config files
- Detect package manager: `npm` / `yarn` / `pnpm` — from lockfile
- Detect TypeScript: `tsconfig.json` present
- Detect state management: Redux (`redux`, `@reduxjs/toolkit`), Zustand, Jotai, MobX, Recoil, Context API
- Detect testing framework: Jest, Vitest, Playwright, Cypress
- Find API route files: Next.js `pages/api/` or `app/api/`, Express `routes/`, Fastify plugins
- Find component files: React (`.tsx`, `.jsx`), Vue (`.vue`), Svelte (`.svelte`)
- Find Storybook stories (`.stories.tsx`, `.stories.mdx`)

Report what was found before writing anything.

### 2. Scaffold Nextra app

Create `_docs/` with the Nextra app scaffold.

**`_docs/package.json`:**

```json
{
  "name": "<project-name>-docs",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^14.0.0",
    "nextra": "^2.13.0",
    "nextra-theme-docs": "^2.13.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  }
}
```

**`_docs/next.config.mjs`:**

```js
import nextra from 'nextra'
const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.tsx',
})
export default withNextra({ basePath: '<baseUrl>' })
```

**`_docs/theme.config.tsx`:**

```tsx
export default {
  logo: <span><ProjectName> Docs</span>,
  project: { link: '<repo-url-from-package.json>' },
  docsRepositoryBase: '<repo-url>',
  useNextSeoProps() { return { titleTemplate: '%s – <ProjectName> Docs' } },
  footer: { text: 'Generated by doc-generator skill' },
}
```

Run `npm install` (or `yarn` / `pnpm`) inside `_docs/` after scaffolding.

### 3. Generate: Getting Started

**`pages/getting-started/index.mdx`** — synthesised from `README.md`, `package.json`, and detected framework:

Content sections:
- **Overview** — project description from `package.json.description` or first paragraph of README
- **Prerequisites** — Node.js version (from `engines.node`), package manager, any env vars in `.env.example`
- **Installation** — clone → install → env setup steps, using detected package manager
- **Running locally** — the `dev` or `start` script command
- **Running tests** — the `test` script if present

**`pages/getting-started/installation.mdx`** — step-by-step with code blocks, tabs per package manager if multiple are detected.

**`pages/getting-started/configuration.mdx`** — list every key from `.env.example` or `.env.local.example` as a table with name, required/optional, and description (parse inline comments).

### 4. Generate: Scripts

**`pages/scripts/index.mdx`** — one entry per script in `package.json.scripts`:

```mdx
## build
Compiles the application for production.

<Tab items={['npm', 'yarn', 'pnpm']}>
  <Tab>
    ```bash
    npm run build
    ```
  </Tab>
  ...
</Tab>
```

For each script:
- Derive a human-readable description by parsing the command string and applying known heuristics:
  - Commands containing `tsc` → "Type-check the project"
  - Commands containing `vitest` or `jest` → "Run the test suite"
  - Commands containing `lint` → "Lint source files"
  - Commands containing `prettier` → "Format source files"
  - Commands containing `next build` → "Build the Next.js application for production"
  - Commands containing `next dev` → "Start the Next.js development server"
  - Commands containing `prisma migrate` → "Run database migrations"
  - Compound commands (using `&&` or `&&`) → split and explain each step
  - Unknown commands → show command as-is with no description

- Group scripts by prefix if they share one (e.g. `db:migrate`, `db:seed`, `db:reset` → **Database** group)
- Show environment variables the script reads (detect `ENV_VAR=value` prefixes)

### 5. Generate: API

For each detected API route file:

**Auto-detection sources (in priority order):**
1. Next.js App Router: `app/api/**/route.ts` — parse exported `GET`, `POST`, `PUT`, `DELETE`, `PATCH` functions
2. Next.js Pages Router: `pages/api/**/*.ts` — parse default exported handler, detect method from `req.method` switch
3. Express / Fastify: `routes/**/*.ts`, `src/api/**/*.ts` — parse `.get()`, `.post()` etc. method calls
4. tRPC routers: `src/server/routers/**/*.ts` — parse `.query()` and `.mutation()` calls

For each endpoint, extract:
- HTTP method and path
- Input schema (Zod schema, TypeScript type, or query params)
- Output type (return type annotation or inferred)
- JSDoc `@description`, `@param`, `@returns`, `@example` if present
- Auth requirement (detect middleware like `withAuth`, `requireAuth`, JWT checks)

**`pages/api/<group>.mdx`** format:

```mdx
## GET /api/users

Returns a paginated list of users.

### Authentication
Requires a valid JWT in the `Authorization` header.

### Query Parameters
| Parameter | Type | Required | Description |
|---|---|---|---|
| `page` | number | No | Page number (default: 1) |
| `limit` | number | No | Items per page (default: 20) |

### Response
\`\`\`ts
type Response = {
  users: User[]
  total: number
  page: number
}
\`\`\`

### Example
\`\`\`bash
curl -H "Authorization: Bearer <token>" /api/users?page=1
\`\`\`
```

### 6. Generate: Components

For each detected component file:

**Extraction strategy:**
1. Parse the file with the TypeScript compiler
2. Find the default export or named exports that are functions returning JSX
3. Extract the Props interface or type (the first argument type)
4. Extract JSDoc comments from the function and each prop
5. Find Storybook story files and extract story examples
6. Find usage examples within the codebase (grep for `<ComponentName`)

**`pages/components/<ComponentName>.mdx`** format:

```mdx
# Button

Primary interaction element. Supports multiple variants and sizes.

## Usage
\`\`\`tsx
import { Button } from '@/components/Button'

<Button variant="primary" onClick={() => {}}>
  Click me
</Button>
\`\`\`

## Props
| Prop | Type | Default | Required | Description |
|---|---|---|---|---|
| `variant` | `'primary' \| 'secondary' \| 'ghost'` | `'primary'` | No | Visual style |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | No | Size preset |
| `disabled` | `boolean` | `false` | No | Disables interaction |
| `onClick` | `() => void` | — | No | Click handler |
| `children` | `ReactNode` | — | Yes | Button label |

## Examples

### Primary
\`\`\`tsx live
<Button variant="primary">Save</Button>
\`\`\`

### Disabled state
\`\`\`tsx live
<Button disabled>Cannot click</Button>
\`\`\`
```

For components with no JSDoc or Storybook stories, generate a minimal page with the props table and a basic usage example.

### 7. Generate: Excalidraw diagrams

#### 7a. Data flow diagram

Analyse the codebase to map how data moves through the system:

**Sources to analyse:**
- API route handlers → what they read and write
- Service / repository layer function calls
- State mutations (Redux dispatches, Zustand `set`, Context `setState`)
- External API calls (`fetch`, `axios`, SDK clients)
- Database queries (Prisma, Drizzle, Knex, raw SQL)
- WebSocket handlers
- Queue producers/consumers

**Diagram elements:**

| Node type | Shape | Color |
|---|---|---|
| External user / client | Rectangle | Blue (#dbeafe) |
| API route | Rectangle | Green (#dcfce7) |
| Service / business logic | Rectangle | Yellow (#fef9c3) |
| Database | Cylinder (rectangle with double top) | Orange (#ffedd5) |
| External API / third party | Rectangle | Purple (#f3e8ff) |
| State store | Diamond | Pink (#fce7f3) |
| Queue / event bus | Parallelogram (rectangle) | Grey (#f3f4f6) |

**Arrow labels** describe the data or action: "POST /api/orders", "createOrder(data)", "INSERT orders", "emit('order.created')", etc.

**Layout:** left-to-right, grouped by layer (Client → API → Services → Data).

**Output:** `_docs/public/diagrams/data-flow.excalidraw`

#### 7b. State management diagram

Analyse state management files:

**Redux / RTK:**
- Parse `createSlice` calls → extract slice name, `initialState` shape, action names
- Parse `createAsyncThunk` → extract thunk names and what they fetch
- Build a tree: Store → Slice → Actions → Reducers

**Zustand:**
- Parse `create<StoreType>()` calls → extract store shape and actions

**Jotai:**
- Parse `atom()` calls → build atom dependency graph

**React Context:**
- Parse `createContext()` and `useContext()` → map providers to consumers

**Diagram elements:**

| Node type | Shape | Color |
|---|---|---|
| Root store | Large rectangle | Blue (#dbeafe) |
| Slice / sub-store | Rectangle | Green (#dcfce7) |
| Action | Pill / rounded rectangle | Yellow (#fef9c3) |
| Async thunk | Rounded rectangle with border | Orange (#ffedd5) |
| Selector | Diamond | Purple (#f3e8ff) |
| Component that reads | Rectangle (dashed border) | Grey (#f3f4f6) |

**Arrow labels:** "dispatches", "reads", "updates", "selects".

**Output:** `_docs/public/diagrams/state-management.excalidraw`

#### Excalidraw file format

Every diagram is a valid `.excalidraw` JSON file:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "doc-generator-skill",
  "elements": [
    {
      "id": "<uuid>",
      "type": "rectangle",
      "x": 100,
      "y": 100,
      "width": 160,
      "height": 60,
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#dbeafe",
      "fillStyle": "solid",
      "strokeWidth": 1,
      "roughness": 0,
      "opacity": 100,
      "text": ""
    },
    {
      "id": "<uuid>",
      "type": "text",
      "x": 120,
      "y": 120,
      "width": 120,
      "height": 20,
      "text": "API Route",
      "fontSize": 14,
      "fontFamily": 1,
      "textAlign": "center",
      "verticalAlign": "middle"
    },
    {
      "id": "<uuid>",
      "type": "arrow",
      "x": 260,
      "y": 130,
      "width": 100,
      "height": 0,
      "startBinding": { "elementId": "<source-id>", "focus": 0, "gap": 4 },
      "endBinding": { "elementId": "<target-id>", "focus": 0, "gap": 4 }
    }
  ],
  "appState": {
    "viewBackgroundColor": "#ffffff",
    "gridSize": 20
  }
}
```

Layout algorithm: top-down or left-to-right grid, with 200px horizontal spacing and 120px vertical spacing between nodes. Arrows connect node centres.

### 8. Sidebar navigation

**`_docs/pages/_meta.json`:**

```json
{
  "index": "Introduction",
  "getting-started": "Getting Started",
  "scripts": "Scripts",
  "api": "API Reference",
  "components": "Components",
  "diagrams": {
    "title": "Architecture",
    "href": "/public/diagrams/data-flow.excalidraw"
  }
}
```

Each section also gets its own `_meta.json` to define page order and labels within the section.

### 9. Validation

After writing all files:
- Run `npm install` inside `_docs/`
- Run `next build` inside `_docs/` and confirm it exits 0
- If build fails, print the error and list which generated MDX files have syntax issues
- Validate each `.excalidraw` file is valid JSON

### 10. Report

Print a summary:

```
Documentation generated → _docs/

Pages created:
  getting-started/    3 pages
  scripts/            1 page   (14 scripts documented)
  api/                6 pages  (23 endpoints)
  components/        18 pages

Diagrams:
  data-flow.excalidraw          (12 nodes, 18 arrows)
  state-management.excalidraw   (8 nodes, 14 arrows)

Run the docs site:
  cd _docs && npm run dev
  → http://localhost:3000
```

---

## Edge cases and constraints

- **Monorepo**: if multiple `package.json` files are found, ask the user which package(s) to document before proceeding; allow documenting multiple packages with a shared Nextra site using Nextra's multi-source setup
- **No README.md**: generate a minimal Getting Started page from `package.json` alone
- **No TypeScript**: parse JSDoc from `.js` files; skip type extraction
- **No components found**: skip the Components section entirely; mention it in the report
- **No API routes found**: skip the API section; mention it in the report
- **No state management**: skip the state management diagram; mention it in the report
- **Existing `_docs/` folder**: if it already exists, ask whether to overwrite, merge (add new pages without touching existing ones), or abort
- **Private packages**: do not include `package.json` secrets or `.env` values in generated docs — only document keys, never values
- **Large component libraries (50+ components)**: generate an index overview page grouping components by folder, rather than one page per component
- **Circular dependencies in state**: detect and label circular references in the state diagram rather than causing an infinite loop
- **JSX in MDX**: ensure component examples in MDX are wrapped in code blocks, not rendered inline, unless the project uses Nextra's live code playground

---

## Success criteria

- `cd _docs && npm run build` exits 0
- Every `package.json` script has a dedicated entry in the Scripts section
- Every detected API endpoint has a page with at minimum the HTTP method, path, and any extractable types
- Every detected component has a page with at minimum a props table
- Both `.excalidraw` files are valid JSON that can be opened in excalidraw.com
- No `.env` values are written into documentation files
- Dry-run produces no file writes
