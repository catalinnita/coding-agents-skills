---
name: create-skill
description: >
  Scaffold a new Agent Skill in the agentskills.io format. Use when asked to
  create a skill, add a skill, set up a skill folder, or build a new reusable
  agent capability. Generates a SKILL.md with correct YAML frontmatter, an
  optional scripts/ stub, and validates the result with skills-ref.
compatibility: Requires Python 3.8+. Validation requires Node.js (npx skills-ref).
metadata:
  author: the-morning-bell
  version: "1.0"
---

## What this skill produces

A new skill folder at `.agents/skills/<name>/` containing:

- `SKILL.md` — YAML frontmatter (`name`, `description`) + markdown instructions stub
- `scripts/template.py` — optional PEP 723 Python script stub (pass `--with-script`)

## Workflow

### Step 1 — Confirm inputs with the user

Collect before running the scaffold:

| Input | Constraint |
|---|---|
| `name` | Lowercase alphanumeric + hyphens only. No leading/trailing/consecutive hyphens. Max 64 chars. Must match folder name. |
| `description` | What it does AND when an agent should activate it. Max 1024 chars. |
| `purpose` | One-line summary for the body heading (e.g. "Fetches real-time stock prices"). |

### Step 2 — Run the scaffold script

```bash
python3 scripts/scaffold.py \
  --name <skill-name> \
  --description "<description>" \
  --purpose "<purpose>"
```

Optional flags:

| Flag | Effect |
|---|---|
| `--with-script` | Also generate `scripts/template.py` stub |
| `--output-dir <path>` | Place skill here instead of `.agents/skills/` |
| `--overwrite` | Replace an existing skill folder |

The script prints a JSON result to stdout:

```json
{"success": true, "skill_dir": ".agents/skills/<name>", "files": ["SKILL.md"]}
```

### Step 3 — Fill in the SKILL.md body

Open the generated `SKILL.md` and replace the stubs with real instructions:

- **Step-by-step workflow** — what the agent should do, in order
- **Code blocks** — exact commands, referencing bundled scripts with relative paths
- **Gotchas** — non-obvious constraints, environment requirements, edge cases

Keep the body under 500 lines / 5000 tokens. Move long reference material to `references/`.

### Step 4 — Validate

```bash
npx skills-ref validate .agents/skills/<skill-name>
```

Fix every reported issue before using the skill in any agent.

## Available scripts

- **`scripts/scaffold.py`** — Generates the skill folder structure. Run with `--help` for full usage.

## Name rules (quick reference)

```
create-skill     ✓  lowercase, hyphens
get-prices       ✓
PDF-Processor    ✗  uppercase not allowed
-prices          ✗  leading hyphen
get--prices      ✗  consecutive hyphens
```

## Good vs poor descriptions

```yaml
# Poor — too vague, no activation trigger
description: Helps with stock data.

# Good — describes what AND when
description: >
  Fetches current prices and fundamentals (P/E, ROE, margins) for given
  ticker symbols. Use when asked about stock prices, valuations, or
  fundamental analysis for any publicly listed company.
```

## Placement

| Scope | Path |
|---|---|
| Project-level (this repo) | `.agents/skills/<name>/` |
| User-level (all projects) | `~/.agents/skills/<name>/` |

Project-level skills take precedence over user-level on name collision.
