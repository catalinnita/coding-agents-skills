---
name: skill-test-generator
description: >
  Reads a target skill's SKILL.md and scripts, then generates exhaustive test
  cases with mocks covering happy paths, edge cases, boundary values, error
  conditions, and all documented gotchas. Use when asked to write tests for a
  skill, generate test cases for a skill, or create a test suite for an agent
  skill.
compatibility: Requires Python 3.10+. Generated tests use pytest. Node-based skills generate Jest tests.
metadata:
  author: the-morning-bell
  version: "1.0"
---

## Overview

Generate an exhaustive test suite for any agent skill by analysing its SKILL.md
and scripts, then producing fixture files, mocks, and test cases organised by
category.

## Inputs

| Input | Required | Description |
|---|---|---|
| `skill` | Yes | Skill name (e.g. `css-extract-variables`) or path to skill folder |
| `output` | No | Where to write the test suite (default: `.agents/tests/<skill-name>/`) |
| `framework` | No | Test framework: `pytest` (default) \| `jest` \| `vitest` |
| `coverage` | No | Categories to cover: `happy-path`, `edge-cases`, `errors`, `boundary`, `all` (default: `all`) |

## Step 1 — Locate and read the skill

Resolve the skill folder:
1. If `skill` is a path, use it directly
2. Otherwise search `.agents/skills/<skill>/` then `~/.agents/skills/<skill>/`

Read every file in the skill folder:
- `SKILL.md` — primary source of truth: inputs, step-by-step workflow, parsing rules, edge cases, gotchas, success criteria
- `scripts/*.py` (or `*.js` / `*.ts`) — implementation detail: function signatures, CLI flags, data structures, error paths
- Any `references/` docs

From these files extract and record:

| What to extract | Where to look |
|---|---|
| All named inputs and their types / defaults | Inputs table in SKILL.md |
| All CLI modes / subcommands | Step descriptions and script `--help` output |
| All value types handled | Parsing rules section |
| Normalisation rules and conversion formulas | Normalisation rules section |
| Approximation rules and algorithms | Approximation rules section |
| Named edge cases | Edge cases section |
| Named gotchas | Gotchas section |
| Success criteria | Success criteria section |
| External dependencies | Import statements and shell commands in scripts |
| Data structures (plan shape, config shape) | Code and SKILL.md examples |

Run `--help` on every script to capture all flags:

```bash
python3 <skill-folder>/scripts/<script>.py --help
```

## Step 2 — Enumerate test cases

For each extracted item produce one or more test cases. Organise them into categories:

### Category: happy-path

One test per documented workflow step and per CLI mode, using representative valid inputs:
- Default config (no options set)
- Fully populated config (all options set)
- Each `types` value in isolation
- Each CLI mode in the sequence the skill prescribes

### Category: boundary

Test the edges of every numeric or enumerable input:
- `threshold: 0`, `threshold: 1`, `threshold: 2`, very large threshold (no values extracted)
- `maxVariables: 1`, `maxVariables` equal to exact count, `maxVariables` lower than count (triggers auto-tightening)
- `maxIterations: 0`, `maxIterations: 1`
- Empty target directory (no matching files)
- Single file, single declaration, single occurrence
- Value that appears exactly at the threshold
- Config with every `types` entry disabled except one
- `prefix: ""`, `prefix: "--"`, `prefix: "--very-long-brand-name"`

### Category: edge-cases

One test per item in the skill's Edge cases and Gotchas sections, plus:
- Each documented value format (hex 3-digit, hex 6-digit, hex 8-digit, rgb, rgba, hsl, hsla, named color)
- Each documented unit (`px`, `rem`, `em`, `%`, `vh`, `vw`)
- Values inside CSS comments — must not be extracted
- Values that are already `var(--…)` references — must not be replaced
- Shorthand property where only some tokens have variables — leave intact, add comment
- `!important` — must be preserved after replacement
- `calc()` with single unit — convert term; `calc()` with mixed units — leave intact
- Gradient values — treat as atomic, extract only if repeated
- Media query values — must not be extracted unless `types` includes `breakpoints`
- CSS-in-JS file extensions — must be skipped
- Existing variable file — merge, never overwrite conflicting names
- File with zero extractable values — no output written

### Category: normalisation

One test per conversion pair and per documented rule:
- `hex` → `hsl`, `hex` → `rgb`, `hex` → `oklch`
- `rgb` → `hsl`, `hsl` → `hex`
- Named color → each target format
- Short hex `#fff` → expanded before conversion
- Color with alpha channel → verify alpha preserved in output
- Color with alpha + `hex` target → fall back to `rgba`
- `px` → `rem` (with `baseFontSize: 16` and custom `baseFontSize`)
- `rem` → `px`
- `em` → `rem` with warning emitted
- Non-convertible unit (`%`, `vh`) → left unchanged, reported as skipped
- `ms` → `s`, `s` → `ms`
- Unitless `line-height` → left as-is
- Values inside `calc()` — per-term conversion where possible

### Category: approximation

One test per snapping rule and per documented algorithm step:
- Grid snap: value on a grid boundary, value between steps, value rounds up, value rounds down
- Grid snap with `roundingMode: floor`, `ceil`, `round`
- `minValue` guard — value below min kept as-is and warning emitted
- `maxValue` guard — value above max kept as-is
- Custom scale — value snaps to nearest entry
- Color ΔE within tolerance — merged into one variable
- Color ΔE above tolerance — kept as separate variables
- Alpha difference > `alphaTolerance` — not merged even if RGB channels are within tolerance
- `strategy: nearest` vs `strategy: centroid` — verify output value differs
- Font weight `350` → snapped to `400`; `450` → snapped to `500`
- Modular type scale — value snaps to nearest scale step
- Duration grid snap — `180ms` with `step: 50` → `200ms`
- `maxVariables` cap — count reduced to cap after auto-tightening
- `maxVariables` unreachable after `maxIterations` — warning emitted, best result returned
- Global `maxVariables` cap applied across all groups combined

### Category: errors

One test per external failure mode:
- Config file not found — informative error, no files written
- Config file is invalid JSON — informative error
- Target path does not exist — informative error
- Target path has no matching files — report zero files, no crash
- Plan file not found when running `write-variables` or `replace` — informative error
- Source file unreadable (permissions) — skip file, emit warning, continue
- Output directory not writable — informative error
- Script run with missing required flag — print usage hint
- Malformed CSS (unclosed block, invalid declaration) — skip declaration, emit warning, continue

### Category: dry-run

- `dryRun: true` — plan is produced but no files are written; verify by asserting filesystem is unchanged after run
- `dryRun: false` followed by `dryRun: true` re-run — second run produces an identical plan, no additional writes

### Category: idempotency

- Running extract + write + replace twice on the same files — second run produces no changes (variables already in place, `var()` refs already in source)
- Running write-variables twice — second run writes nothing (all names already exist in the file)

## Step 3 — Generate fixtures

For each test case that requires file input, generate the minimum fixture that exercises exactly the behaviour under test. Write fixtures to `tests/fixtures/`.

**Fixture naming convention:** `<category>__<what-it-tests>.css` (or `.scss`, `.json`)

Examples:
- `happy-path__full-config.css` — representative file with colors, spacing, typography
- `edge-cases__values-in-comments.css` — declarations inside `/* … */` blocks
- `edge-cases__existing-var-refs.css` — properties already using `var(--…)`
- `boundary__single-occurrence.css` — every value appears exactly once
- `normalisation__hex-to-hsl.css` — various hex colors for conversion testing
- `approximation__grid-snap.css` — spacing values near grid boundaries
- `errors__malformed.css` — unclosed blocks, invalid declarations

Config fixtures go in `tests/fixtures/configs/`:
- `default.json` — empty config (exercises all defaults)
- `full.json` — every option set to a non-default value
- `scss.json` — `scss: true`
- `dry-run.json` — `dryRun: true`
- `normalize-hsl.json`, `normalize-rem.json`, etc.
- `approximate-grid.json`, `approximate-scale.json`, etc.

## Step 4 — Generate mocks

Identify every external dependency from the scripts (file I/O, subprocesses, network calls, third-party libraries). For each, generate the appropriate mock.

**File system** — use `tmp_path` (pytest) or `memfs` (Jest):
- Provide helpers that write fixture files into a temp directory before each test
- Assert file contents after the test rather than relying on real paths

**Subprocesses** — mock `subprocess.run` / `child_process.exec`:
- Return predefined stdout/stderr and exit codes
- Cover success, non-zero exit, and timeout

**Third-party libraries** (e.g. `colormath`):
- Provide a lightweight stub that returns deterministic values
- Test the skill's behaviour when the library raises an exception

**Environment** — mock `os.getcwd()`, `Path.home()`, `.gitignore` content:
- Test skill running from project root, a subdirectory, and a path with spaces

Write mocks to `tests/mocks/` as importable modules or Jest `__mocks__` files.

## Step 5 — Write test files

Write the test files to `.agents/tests/<skill-name>/` (or `output` if set). Tests live **outside the skill folder** so skills remain self-contained and tests can be managed, run, and CI'd independently.

```
.agents/
  skills/
    css-extract-variables/      ← skill untouched
      SKILL.md
      scripts/
  tests/
    css-extract-variables/      ← generated test suite lives here
      run_tests.py              ← executable runner script
      helpers.py
      conftest.py
      test_happy_path.py
      test_boundary.py
      test_edge_cases.py
      test_normalisation.py
      test_approximation.py
      test_errors.py
      test_dry_run.py
      test_idempotency.py
      fixtures/
        happy-path__full-config.css
        edge-cases__values-in-comments.css
        ...
        configs/
          default.json
          full.json
          ...
      mocks/
        filesystem.py
        subprocess.py
```

Each test function must:
- Have a name that describes the exact scenario: `test_hex_color_normalised_to_hsl_preserves_alpha`
- Set up fixtures via the mock helpers, not by touching real files
- Assert the specific output relevant to the case (variable name, value, file content, warning message, exit code)
- Be independent — no shared mutable state between tests

`conftest.py` provides:
- `skill_dir` fixture — resolved path to the skill under test
- `run_mode(mode, config, fixtures)` helper — writes fixtures to `tmp_path`, runs the script, returns stdout/stderr/exit code and the resulting filesystem state
- Shared config factory functions

## Step 6 — Verify and report

After writing all files, run the happy-path category via the runner script to confirm the generated tests are syntactically valid:

```bash
python3 .agents/tests/<skill-name>/run_tests.py --category happy-path -v
```

Report to the user:

```
Generated test suite for: css-extract-variables
Output:  .agents/tests/css-extract-variables/
Runner:  .agents/tests/css-extract-variables/run_tests.py

Categories:
  happy-path       12 tests
  boundary         18 tests
  edge-cases       24 tests
  normalisation    21 tests
  approximation    19 tests
  errors           11 tests
  dry-run           4 tests
  idempotency       4 tests
  ─────────────────────────
  Total           113 tests

Fixtures:  31 files
Mocks:      4 modules

Run:
  python3 .agents/tests/css-extract-variables/run_tests.py
  python3 .agents/tests/css-extract-variables/run_tests.py --category happy-path
  python3 .agents/tests/css-extract-variables/run_tests.py --category edge-cases --verbose

Smoke run (happy-path only):
  12 passed in 1.4s

Gaps (spec documented but not yet implemented in script):
  shorthand-review-comment  → marked @xfail in test_edge_cases.py
```

Flag any generated tests that could not be verified (script not yet implemented, missing dependency) and explain what needs to be in place for them to pass.

## Gotchas

- **Read the full script, not just SKILL.md**: SKILL.md describes intent; the script reveals what is actually implemented. If a rule is documented in the spec but absent from the script, generate a failing test for it marked `@pytest.mark.xfail(reason="not yet implemented")` and surface it in the report.
- **One assertion per test**: resist generating omnibus tests that check everything at once. A narrow failure message is far more useful than a broad one.
- **Fixture minimalism**: each fixture should contain the minimum CSS to exercise exactly one scenario. A fixture that exercises five things at once makes failures hard to diagnose.
- **No real filesystem writes in unit tests**: all file I/O must go through `tmp_path` or equivalent. Tests that write to the real project tree are fragile and unsafe.
- **Deterministic mock values**: mocks must return the same value every call. Non-deterministic mocks (random colours, random IDs) make tests flaky.
- **Test the plan, not just the files**: for `extract` mode, assert on the plan JSON (variable names, values, source locations, skipped list, warnings) — not only on what was written to disk.
- **Idempotency tests are mandatory**: if a skill modifies files, there must be at least one test confirming a second run produces no further changes.
- **Gap reporting**: surface every `@xfail` test prominently in the report so the user knows what the script does not yet implement.
