---
name: claude-cost-tracker
description: >
  Records the token usage and USD cost of every Claude action (skill runs,
  agent phases, prompts) and persists them to a structured JSON file. Provides
  record, report, and reset modes. Use when asked to track Claude costs, record
  token usage, show Claude spend, summarise API costs, or how much an operation
  cost.
compatibility: Requires Node.js 18+. No external dependencies.
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Track Claude API token usage per named action and compute the USD cost using
built-in model pricing. All records are appended to `claude-costs.json` in the
project root.

## Config (`claude-cost-tracker.config.json`)

| Key | Default | Description |
|---|---|---|
| `outputFile` | `"claude-costs.json"` | Path (relative to project root) for the JSON store |
| `autoTrack` | `false` | When `true`, agents call this skill after each phase |
| `pricing` | built-in | Per-model price overrides (see Pricing section) |
| `sessionLabel` | ISO date | Label for the current tracking session |

## Step 1 — Record an action

Call after every significant Claude API call, passing the usage data from the
API response:

```bash
node .agents/skills/claude-cost-tracker/scripts/tracker.js \
  --mode record \
  --label "extract-components phase 2" \
  --model "claude-sonnet-4-6" \
  --input-tokens 12500 \
  --output-tokens 1800 \
  --cache-read-tokens 45000 \
  --cache-write-tokens 8000 \
  [--session-id "abc123"] \
  [--project-dir <path>]
```

All `*-tokens` flags are optional and default to `0`. Prints the appended
record as JSON to stdout on success.

## Step 2 — Report

```bash
node .agents/skills/claude-cost-tracker/scripts/tracker.js \
  --mode report \
  [--since "2026-05-01"] \
  [--top 10] \
  [--project-dir <path>]
```

Prints a formatted cost summary to stdout. Does not modify the file.

## Step 3 — Reset

```bash
node .agents/skills/claude-cost-tracker/scripts/tracker.js \
  --mode reset \
  [--yes] \
  [--project-dir <path>]
```

Clears all records. Asks for confirmation unless `--yes` is passed.

## Pricing (built-in, USD per million tokens)

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| `claude-opus-4-7` | $15.00 | $75.00 | $1.50 | $18.75 |
| `claude-sonnet-4-6` | $3.00 | $15.00 | $0.30 | $3.75 |
| `claude-haiku-4-5-20251001` | $0.80 | $4.00 | $0.08 | $1.00 |

Override any entry via `pricing` in the config file.

## Output file schema

```json
{
  "schema_version": 1,
  "summary": {
    "total_cost_usd": 1.2345,
    "total_input_tokens": 450000,
    "total_output_tokens": 85000,
    "total_cache_read_tokens": 1200000,
    "total_cache_write_tokens": 95000,
    "action_count": 47,
    "by_model": {}
  },
  "actions": [
    {
      "id": "<uuid>",
      "timestamp": "<ISO-8601>",
      "label": "...",
      "model": "claude-sonnet-4-6",
      "session_id": "...",
      "input_tokens": 0,
      "output_tokens": 0,
      "cache_read_tokens": 0,
      "cache_write_tokens": 0,
      "cost_usd": 0.0,
      "cost_breakdown": {
        "input_usd": 0.0,
        "output_usd": 0.0,
        "cache_read_usd": 0.0,
        "cache_write_usd": 0.0
      }
    }
  ]
}
```

`summary` is always recomputed from `actions[]` on every write — never the
source of truth.

## Available scripts

- **`scripts/tracker.js`** — main worker. Run with `--help` for full usage.

## Edge cases

- **Missing output file** — created automatically on first `record`
- **Invalid JSON in output file** — warns and asks whether to reset or abort
- **Unknown model** — records entry with `cost_usd: null`, prints warning
- **Negative token counts** — rejected with a validation error; entry not written
- **File write interrupted** — atomic write via `.tmp` rename prevents corruption
- **`claude-costs.json` not in `.gitignore`** — entry appended automatically
