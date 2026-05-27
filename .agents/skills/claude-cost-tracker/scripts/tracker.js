#!/usr/bin/env node
'use strict';

/**
 * Claude Cost Tracker — modes: record | report | reset
 * No external dependencies required.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Pricing table (USD per million tokens)
// ---------------------------------------------------------------------------
const BUILT_IN_PRICING = {
  'claude-opus-4-7':           { input: 15.00, output: 75.00, cache_read:  1.50, cache_write: 18.75 },
  'claude-sonnet-4-6':         { input:  3.00, output: 15.00, cache_read:  0.30, cache_write:  3.75 },
  'claude-haiku-4-5-20251001': { input:  0.80, output:  4.00, cache_read:  0.08, cache_write:  1.00 },
};

const EMPTY_STORE = () => ({
  schema_version: 1,
  summary: {
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    action_count: 0,
    by_model: {},
  },
  actions: [],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      args[key] = (next && !next.startsWith('--')) ? argv[++i] : true;
    }
  }
  return args;
}

function loadConfig(projectDir) {
  const cfgPath = path.join(projectDir, 'claude-cost-tracker.config.json');
  if (!fs.existsSync(cfgPath)) return {};
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch { return {}; }
}

function resolvePricing(cfg) {
  const pricing = { ...BUILT_IN_PRICING };
  if (cfg.pricing) {
    for (const [model, p] of Object.entries(cfg.pricing)) {
      pricing[model] = {
        input:       p.input_per_mtok  ?? pricing[model]?.input,
        output:      p.output_per_mtok ?? pricing[model]?.output,
        cache_read:  p.cache_read_per_mtok  ?? pricing[model]?.cache_read,
        cache_write: p.cache_write_per_mtok ?? pricing[model]?.cache_write,
      };
    }
  }
  return pricing;
}

// Atomic write: write to .tmp then rename
function writeAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadStore(outputFile) {
  if (!fs.existsSync(outputFile)) return EMPTY_STORE();
  const raw = fs.readFileSync(outputFile, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return null; // signal invalid JSON
  }
}

function recomputeSummary(actions) {
  const summary = {
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    action_count: actions.length,
    by_model: {},
  };

  for (const a of actions) {
    if (a.cost_usd != null) summary.total_cost_usd += a.cost_usd;
    summary.total_input_tokens       += a.input_tokens       || 0;
    summary.total_output_tokens      += a.output_tokens      || 0;
    summary.total_cache_read_tokens  += a.cache_read_tokens  || 0;
    summary.total_cache_write_tokens += a.cache_write_tokens || 0;

    if (!summary.by_model[a.model]) {
      summary.by_model[a.model] = { cost_usd: 0, action_count: 0 };
    }
    const m = summary.by_model[a.model];
    if (a.cost_usd != null) m.cost_usd += a.cost_usd;
    m.action_count++;
  }

  summary.total_cost_usd = round6(summary.total_cost_usd);
  for (const m of Object.values(summary.by_model)) {
    m.cost_usd = round6(m.cost_usd);
  }
  return summary;
}

function ensureGitignore(projectDir, entry) {
  const giPath = path.join(projectDir, '.gitignore');
  if (!fs.existsSync(giPath)) return;
  const content = fs.readFileSync(giPath, 'utf8');
  const lines = content.split('\n');
  if (lines.some(l => l.trim() === entry)) return;
  fs.appendFileSync(giPath, `\n${entry}\n`);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
function cmdRecord(args, cfg, projectDir) {
  const label    = args.label    || '(unlabelled)';
  const model    = args.model    || 'unknown';
  const sessionId = args.sessionId || null;

  const inputTokens      = parseInt(args.inputTokens      || '0', 10);
  const outputTokens     = parseInt(args.outputTokens     || '0', 10);
  const cacheReadTokens  = parseInt(args.cacheReadTokens  || '0', 10);
  const cacheWriteTokens = parseInt(args.cacheWriteTokens || '0', 10);

  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].some(n => n < 0)) {
    console.error('Error: token counts must be non-negative.');
    process.exit(1);
  }

  const pricing = resolvePricing(cfg);
  const p = pricing[model];
  let costUsd = null;
  let breakdown = null;

  if (p) {
    const inputUsd      = round6((inputTokens      / 1e6) * p.input);
    const outputUsd     = round6((outputTokens     / 1e6) * p.output);
    const cacheReadUsd  = round6((cacheReadTokens  / 1e6) * p.cache_read);
    const cacheWriteUsd = round6((cacheWriteTokens / 1e6) * p.cache_write);
    costUsd = round6(inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd);
    breakdown = {
      input_usd:       inputUsd,
      output_usd:      outputUsd,
      cache_read_usd:  cacheReadUsd,
      cache_write_usd: cacheWriteUsd,
    };
  } else {
    console.error(`Warning: no pricing found for model "${model}". Entry recorded without cost.`);
  }

  const outputFile = path.join(projectDir, cfg.outputFile || 'claude-costs.json');

  let store = loadStore(outputFile);
  if (store === null) {
    console.error(`Error: ${outputFile} contains invalid JSON. Run --mode reset to clear it, or fix it manually.`);
    process.exit(1);
  }

  const record = {
    id: uuid(),
    timestamp: new Date().toISOString(),
    label,
    model,
    session_id: sessionId,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    cost_usd: costUsd,
    cost_breakdown: breakdown,
  };

  store.actions.push(record);
  store.summary = recomputeSummary(store.actions);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  writeAtomic(outputFile, store);
  ensureGitignore(projectDir, path.relative(projectDir, outputFile));

  console.log(JSON.stringify(record, null, 2));
}

function cmdReport(args, cfg, projectDir) {
  const outputFile = path.join(projectDir, cfg.outputFile || 'claude-costs.json');
  const store = loadStore(outputFile);

  if (store === null) {
    console.error(`Error: ${outputFile} contains invalid JSON.`);
    process.exit(1);
  }

  let actions = store.actions;

  if (args.since) {
    const since = new Date(args.since);
    if (isNaN(since)) { console.error('Error: invalid --since date.'); process.exit(1); }
    actions = actions.filter(a => new Date(a.timestamp) >= since);
  }

  const summary = recomputeSummary(actions);
  const topN = parseInt(args.top || '5', 10);
  const topActions = [...actions]
    .filter(a => a.cost_usd != null)
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, topN);

  const firstDate = actions.length ? actions[0].timestamp.slice(0, 10) : '—';
  const lastDate  = actions.length ? actions[actions.length - 1].timestamp.slice(0, 10) : '—';

  const fmt = (n, d = 4) => n == null ? 'n/a' : `$${n.toFixed(d)}`;
  const fmtTok = n => n.toLocaleString();
  const pad = (s, w) => String(s).padEnd(w);
  const line = '─'.repeat(56);

  console.log(`\nClaude Cost Report`);
  console.log(line);
  console.log(`Total cost:      ${fmt(summary.total_cost_usd)}`);
  console.log(`Total actions:   ${summary.action_count}`);
  console.log(`Period:          ${firstDate} → ${lastDate}`);

  console.log(`\nBy model:`);
  for (const [model, data] of Object.entries(summary.by_model)) {
    console.log(`  ${pad(model, 34)} ${fmt(data.cost_usd)}  (${data.action_count} action${data.action_count !== 1 ? 's' : ''})`);
  }

  console.log(`\nBy token type:`);
  console.log(`  Input:        ${pad(fmtTok(summary.total_input_tokens), 14)} tokens`);
  console.log(`  Output:       ${pad(fmtTok(summary.total_output_tokens), 14)} tokens`);
  console.log(`  Cache read:   ${pad(fmtTok(summary.total_cache_read_tokens), 14)} tokens`);
  console.log(`  Cache write:  ${pad(fmtTok(summary.total_cache_write_tokens), 14)} tokens`);

  if (topActions.length) {
    console.log(`\nTop ${Math.min(topN, topActions.length)} most expensive actions:`);
    topActions.forEach((a, i) => {
      const date = a.timestamp.slice(0, 10);
      const label = a.label.length > 38 ? a.label.slice(0, 35) + '...' : a.label;
      console.log(`  ${i + 1}. ${fmt(a.cost_usd)}  ${pad(label, 40)} ${pad(a.model, 22)} ${date}`);
    });
  }

  console.log(line + '\n');
}

function cmdReset(args, cfg, projectDir) {
  const outputFile = path.join(projectDir, cfg.outputFile || 'claude-costs.json');

  if (!args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Reset ${outputFile}? This will delete all records. Type "yes" to confirm: `, answer => {
      rl.close();
      if (answer.trim().toLowerCase() !== 'yes') {
        console.log('Reset cancelled.');
        process.exit(0);
      }
      doReset(outputFile);
    });
  } else {
    doReset(outputFile);
  }
}

function doReset(outputFile) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  writeAtomic(outputFile, EMPTY_STORE());
  console.log(`Reset complete. ${outputFile} cleared.`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(`
Usage: node tracker.js --mode <mode> [options]

Modes:
  record    Append one action entry with token usage and computed cost
  report    Print a cost summary (does not modify the file)
  reset     Clear all records (asks for confirmation)

Record options:
  --label <text>              Human-readable name for this action
  --model <id>                Claude model ID (e.g. claude-sonnet-4-6)
  --input-tokens <n>          Input token count (default: 0)
  --output-tokens <n>         Output token count (default: 0)
  --cache-read-tokens <n>     Cache read token count (default: 0)
  --cache-write-tokens <n>    Cache write token count (default: 0)
  --session-id <id>           Optional session identifier

Report options:
  --since <date>              Only include actions on or after this date (YYYY-MM-DD)
  --top <n>                   Number of most-expensive actions to show (default: 5)

Reset options:
  --yes                       Skip confirmation prompt

Global options:
  --project-dir <path>        Project root (default: current directory)
  --help                      Show this help
`);
    process.exit(0);
  }

  const mode = args.mode;
  if (!mode) {
    console.error('Error: --mode is required. Use --help for usage.');
    process.exit(1);
  }

  const projectDir = path.resolve(args.projectDir || args['project-dir'] || '.');
  const cfg = loadConfig(projectDir);

  switch (mode) {
    case 'record': cmdRecord(args, cfg, projectDir); break;
    case 'report': cmdReport(args, cfg, projectDir); break;
    case 'reset':  cmdReset(args, cfg, projectDir);  break;
    default:
      console.error(`Unknown mode: "${mode}". Use record | report | reset.`);
      process.exit(1);
  }
}

main();
