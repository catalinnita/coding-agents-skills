# AI Agents

A collection of Claude Code agents and skills for automated codebase improvement. Each agent orchestrates one or more skills to accomplish a focused goal; each skill is a single-responsibility tool that can also be invoked directly.

See [skills-map.excalidraw](skills-map.excalidraw) for a visual overview of how everything connects.

---

## Agents

Agents are orchestrators that run multiple skills in sequence, make decisions between steps, and deliver a consolidated result. They live in `.agents/agents/`.

| Agent | What it does |
|---|---|
| **tdd-agent** | Full TDD loop from acceptance criteria or a coverage-gaps report through to passing tests. Generates Gherkin scenarios, normalises test infrastructure, implements tests, and iterates the run-fix cycle. |
| **css-refactor** | Extracts hardcoded CSS values into custom properties, validates visually with screenshot regression, and auto-corrects any visual diffs before reporting. |
| **performance-report** | Measures bundle sizes, Lighthouse Core Web Vitals, and SSR render times. Produces versioned history and a unified HTML report. Read-only — no fixes applied. |
| **improve-client-performance** | Pulls the latest Lighthouse report (or generates one), applies auto-fixable audits with `lighthouse-fix`, runs visual regression after each pass, and loops until both the score is stable and all routes pass visually. |
| **code-cleanup** | Sequential, test-gated pipeline: CSS variable extraction → TypeScript cleanup → config extraction → accessibility fixes → SEO fixes → security hardening. Tests must pass after every step or that step is reverted. |

---

## Skills

Skills are single-responsibility tools. They can be invoked by agents or run directly. They live in `.agents/skills/`.

### Standards

| Skill | What it does |
|---|---|
| `accessibility` | Audits for WCAG 2.1 violations (alt text, ARIA, keyboard nav, colour contrast). Fixes markup and attributes when `--fix true`. |
| `seo` | Audits for SEO issues (metadata, headings, crawlability, structured data, Core Web Vitals heuristics). Fixes safe markup changes when `--fix true`. |
| `security` | Audits for OWASP Top 10, committed secrets, CVEs in dependencies, and missing HTTP security headers. Applies safe targeted fixes when `--fix true`. |

### Performance

| Skill | What it does |
|---|---|
| `lighthouse-tests` | Runs Lighthouse CLI against configured URLs, averages N iterations, persists versioned JSON history, and produces time-series comparison reports. |
| `lighthouse-fix` | Reads the latest Lighthouse results and implements auto-fixable recommendations: `defer` on scripts, preconnects, LCP preloads, `font-display: swap`, image sizing, WebP conversion, text compression config. |
| `bundle-sizes` | Builds the project, measures every output asset in raw and gzip sizes, checks thresholds, and produces an SVG treemap with size history. |
| `page-render` | Measures SSR render time (via `Server-Timing`) and classifies each page request as origin hit vs CDN hit. Persists history and produces trend charts. |

### Code Quality

| Skill | What it does |
|---|---|
| `type-cleaner` | Deduplicates TypeScript declarations, removes redundant types and unused imports, normalises `interface` vs `type`, and flags `any` usage. |
| `css-extract-variables` | Scans CSS/SCSS for hardcoded values and extracts them into custom properties with configurable normalisation, approximation, and a variable-count cap. |
| `config-extractor` | Finds hardcoded environment-specific values (URLs, keys, magic numbers) and moves them to a centralised config or environment variables. |

### Testing

| Skill | What it does |
|---|---|
| `visual-regression` | Screenshots the current branch and `main` via git worktrees, compares pixel-by-pixel and via SSIM, and produces a self-contained HTML diff report. |
| `coverage-gaps` | Runs the test suite with coverage, identifies uncovered files/functions/branches, and produces a prioritised gap report that `tdd-agent` reads to create tests one by one. |
| `cucumber-scenarios` | Converts acceptance criteria or informal descriptions into Gherkin, validates coverage against the source code, and fills gaps as `@generated` scenarios. |
| `test-conventions` | Detects the dominant test pattern across the suite (framework, hook style, naming, async style) and normalises deviating files. Writes `test-conventions.json` for `tdd-agent`. |
| `unified-mocks` | Finds duplicate inline mock objects, consolidates them into typed factory functions (`createUserMock(overrides?)`), and replaces inline literals throughout the suite. |
| `global-mocks` | Promotes frequently repeated per-file mocks to `__mocks__/` or `setupFiles` and wires up `afterEach` reset to prevent state leaks. |

### Documentation

| Skill | What it does |
|---|---|
| `doc-generator` | Analyses the repo and scaffolds a Nextra documentation site with API reference, component docs, and architecture diagrams. |
| `changes-report` | After any skill applies fixes, generates a human-readable change log at the configured developer level (`absolute-beginner`, `junior`, or `senior`) with links to authoritative further reading. |

### Tooling

| Skill | What it does |
|---|---|
| `create-skill` | Scaffolds a new skill folder in the agentskills.io format — `SKILL.md` with correct frontmatter and an optional Python script stub. |
| `skill-test-generator` | Reads a skill's `SKILL.md` and scripts, then generates exhaustive tests covering all modes and edge cases. |

---

## Config files

Each skill reads its own config file from the project root. Drop the relevant file into any project to customise behaviour:

| File | Used by |
|---|---|
| `performance.config.json` | `lighthouse-tests`, `lighthouse-fix`, `bundle-sizes`, `page-render`, `performance-report` agent, `improve-client-performance` agent |
| `css-extract-variables.config.json` | `css-extract-variables`, `css-refactor` agent |
| `type-cleaner.config.json` | `type-cleaner` |
| `config-extractor.config.json` | `config-extractor` |
| `changes-report.config.json` | `changes-report` — set `devLevel` here |
| `code-cleanup.config.json` | `code-cleanup` agent — controls step order and test gating |
| `visual-regression.config.json` | `visual-regression`, `css-refactor` agent, `improve-client-performance` agent |

---

## Invoking a skill

Every skill exposes a `scripts/runner.py` with a consistent `--mode` interface:

```bash
# Audit only (no changes)
python3 .agents/skills/<skill-name>/scripts/runner.py \
  --mode run \
  --project-dir .

# Apply fixes
python3 .agents/skills/<skill-name>/scripts/runner.py \
  --mode run \
  --fix true \
  --project-dir .
```

Common modes across all skills: `preflight` · `analyze` · `fix` · `report` · `run` (full pipeline).

---

## Invoking an agent

Agents are described in `AGENT.md` and are executed by Claude Code as a set of instructions. There is no single runner script — the agent reads its `AGENT.md` and orchestrates the underlying skill scripts itself.

To run an agent, ask Claude Code:

```
run the tdd-agent for src/services/auth.ts using the AC in JIRA-123.md
run css-refactor on this project
run code-cleanup
improve-client-performance until the Lighthouse score is above 90
```

---

## Developer level in changes-report

The `changes-report` skill generates explanations at three levels. Set in `changes-report.config.json`:

| Level | Style | Link targets |
|---|---|---|
| `absolute-beginner` | ~200 words, defines every term, real-world impact | web.dev, WebAIM, CSS-Tricks |
| `junior` | ~80 words, assumes basic vocab, cites the standard | MDN, official docs, OWASP |
| `senior` | ~30 words, rule ID + rationale + trade-off | W3C specs, RFCs |

---

## Adding a new skill

```bash
python3 .agents/skills/create-skill/scripts/scaffold.py \
  --name my-skill \
  --description "What it does and when to invoke it." \
  --purpose "One-line body heading" \
  --with-script
```

Then fill in `.agents/skills/my-skill/SKILL.md` following the patterns in existing skills.

---

## Repository structure

```
.agents/
  agents/               ← orchestrating agents (AGENT.md)
    code-cleanup/
    css-refactor/
    improve-client-performance/
    performance-report/
    tdd-agent/
  skills/               ← single-responsibility skills (SKILL.md + scripts/)
    accessibility/  bundle-sizes/  changes-report/  config-extractor/
    coverage-gaps/  create-skill/  css-extract-variables/  cucumber-scenarios/
    doc-generator/  global-mocks/  lighthouse-fix/  lighthouse-tests/
    page-render/    security/      seo/             skill-test-generator/
    test-conventions/  type-cleaner/  unified-mocks/  visual-regression/

_spec/                  ← design specs written before implementation
  *-skill-spec.md
  *-agent-spec.md

*.config.json           ← per-skill config files (copy into target projects)
skills-map.excalidraw   ← visual dependency map of all agents and skills
src/styles/             ← shared CSS variables
```
