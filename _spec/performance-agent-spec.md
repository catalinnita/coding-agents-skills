# Agent Spec: Performance

## Goal

Orchestrate the three performance skills — Lighthouse Tests, Bundle Sizes, and
Page Render — from a single `performance.config.json`, run them in the right
order, and produce a unified summary report that combines all findings into one
actionable overview.

---

## Trigger conditions

Invoke this agent when the user asks to:
- "run performance tests"
- "check performance"
- "run the performance suite"
- "measure performance"
- "run lighthouse, bundle and render checks"
- "generate a performance report"

---

## Inputs

Read entirely from `performance.config.json` in the project root. The agent
does not accept ad-hoc inputs — all configuration lives in that file.

| Config section | Skill it feeds |
|---|---|
| `lighthouse` | `lighthouse-tests` |
| `bundleSizes` | `bundle-sizes` |
| `pageRender` | `page-render` |
| `outputDir` | Shared by all three; where the combined report is written |

Optional CLI flags that override config:
- `--only lighthouse|bundle|render` — run only the named skill(s)
- `--ci` — exit non-zero if any threshold fails across all skills; suppress HTML reports
- `--no-build` — skip the build step in `bundle-sizes` (use the existing output dir)

---

## Behavior

### Phase 0 — Pre-flight

Before running any skill:

- Confirm `performance.config.json` exists; if not, offer to generate a default one and stop
- Validate the config structure: required keys, numeric thresholds > 0, valid URLs
- Detect which skills are effectively enabled:
  - `lighthouse-tests`: enabled if `lighthouse.urls` is non-empty
  - `bundle-sizes`: enabled if a build command can be detected or is configured
  - `page-render`: enabled if `pageRender.urls` is non-empty
- Warn about any disabled skill and explain why

### Phase 1 — Bundle Sizes

Run first because it requires a build, which may start a server or generate
assets that subsequent skills depend on.

```bash
python3 .agents/skills/bundle-sizes/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Wait for completion. If the build fails, abort the full run — subsequent skills
depend on a working build.

**Output consumed:** `.performance/bundle-report.json`

### Phase 2 — Lighthouse Tests and Page Render (parallel)

Once the build succeeds, run Lighthouse and Page Render in parallel — they are
independent and both measure the running app, not the build artefacts:

```bash
python3 .agents/skills/lighthouse-tests/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project>

python3 .agents/skills/page-render/scripts/runner.py \
  --mode run \
  --config performance.config.json \
  --project-dir <path-to-project>
```

Wait for both to complete before proceeding.

**Outputs consumed:**
- `.performance/lighthouse-report.json`
- `.performance/render-report.json`

### Phase 3 — Combined report

Read the three JSON reports and produce a unified summary.

Write `<outputDir>/performance-report.html` — self-contained HTML:

```
Performance Report — 2026-05-22 14:32

┌─────────────────────────────────────────────────────┐
│  PASS  Bundle Sizes   JS 260KB gz  CSS 22KB gz      │
│  PASS  Lighthouse     Score 94/100  LCP 1.82s       │
│  WARN  Page Render    Render 148ms  Origin reqs: 3  │
└─────────────────────────────────────────────────────┘
```

**Sections:**

1. **Executive summary** — one-line status per skill (pass / warn / fail) with the
   most important metric for each
2. **Regressions** — any metric that worsened since the previous run, across all
   three skills, listed at the top with 🔴
3. **Lighthouse** — Core Web Vitals table, asset sizes, score history chart
4. **Bundle Sizes** — total sizes by category, largest chunks, bundle treemap, size history
5. **Page Render** — render time, TTFB, origin vs CDN request breakdown, render time history
6. **Thresholds** — full table of every configured threshold vs current value

Also write `<outputDir>/performance-report.json` — merged machine-readable
summary with all three skill results and a top-level `status` field:
`"pass"` | `"warn"` | `"fail"`.

### Phase 4 — CI exit code (when `--ci` flag is set)

Exit with code `0` if all thresholds across all three skills pass.
Exit with code `1` if any threshold fails.
Print a compact text summary to stdout (no HTML):

```
FAIL  bundle-sizes   largestChunk 248KB > threshold 200KB
PASS  lighthouse     score 94 >= threshold 90
PASS  page-render    renderTime 148ms < threshold 500ms
```

---

## Skills used

| Skill | Phase | Purpose |
|---|---|---|
| `bundle-sizes` | 1 | Build the project and measure output asset sizes |
| `lighthouse-tests` | 2 (parallel) | Audit Core Web Vitals and performance scores |
| `page-render` | 2 (parallel) | Measure SSR render time and origin request counts |

---

## Decision rules

- Always run `bundle-sizes` first; abort the run if the build fails
- Run `lighthouse-tests` and `page-render` in parallel after a successful build
- If `--only` is specified, run only the named skill(s); skip the others entirely
- If `--no-build` is specified, skip the build step and use whatever is already in `buildOutputDir`
- Combined report status is the worst of the three individual statuses (fail > warn > pass)
- In CI mode, stdout must be machine-parseable — no progress spinners or colour codes

---

## Output structure

```
performance.config.json         ← single shared config (project root)

.performance/
  performance-report.html       ← combined report (open this)
  performance-report.json       ← combined machine-readable results
  lighthouse-report.html
  lighthouse-report.json
  bundle-report.html
  bundle-report.json
  render-report.html
  render-report.json
  history/
    lighthouse/
      <url-slug>/
        <timestamp>.json
    bundle/
      <timestamp>.json
    render/
      <url-slug>/
        <timestamp>.json
```

---

## Edge cases

- **`performance.config.json` missing**: offer to write a default config file and
  stop — do not run with hardcoded defaults silently
- **All URLs unreachable**: abort with a clear error after Phase 0; do not write
  partial reports
- **Only one or two skills enabled**: run only the enabled skills; the combined
  report includes only the sections for skills that ran; note which skills were
  skipped and why
- **Lighthouse and Page Render target different URLs than bundleSizes**: this is
  expected — bundle-sizes measures the build output, not a running server
- **`serveCommand` needed**: if `pageRender.serveCommand` is set, the `page-render`
  skill starts and stops the server within its own run; the agent does not manage
  the server lifecycle

---

## Success criteria

- All three skill reports are written to `outputDir`
- Combined report accurately reflects the worst status across all skills
- History files accumulate across runs for trend analysis
- `performance-report.html` links to (or embeds) individual skill reports
- CI exit code correctly reflects the overall pass/fail result
- The agent never silently falls back to defaults — misconfiguration is always reported
