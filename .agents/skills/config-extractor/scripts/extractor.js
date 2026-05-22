#!/usr/bin/env node
'use strict';

/**
 * Config extractor — modes: analyze | generate | replace | validate | report | run
 * Requires: ts-morph (auto-installed)
 */

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
function ensureDep(name) {
  try { require.resolve(name); return; } catch (_) {}
  console.error(`Installing ${name}...`);
  execSync(`npm install ${name}`, { cwd: __dirname, stdio: 'inherit' });
}
ensureDep('ts-morph');

const { Project, SyntaxKind: SK } = require('ts-morph');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULTS = {
  target: '.',
  exclude: ['node_modules', 'dist', 'build', '.git', 'coverage', '.next', 'out'],
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  categories: 'all',
  output: 'config',
  envFile: '.env.example',
  configModule: 'config/config.ts',
  flagsModule: 'config/feature-flags.ts',
  constantsModule: 'config/constants.ts',
  threshold: 2,
  dryRun: false,
  replace: true,
  framework: 'auto',
};

const SKIP_NUMERIC = new Set([0, 1, -1, 2, 3, 10, 100, 1000]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig(configPath, projectDir) {
  const cfg = { ...DEFAULTS };
  const cfgFile = configPath
    ? path.resolve(configPath)
    : path.join(projectDir, 'config-extractor.config.json');
  if (fs.existsSync(cfgFile) && fs.statSync(cfgFile).size > 0) {
    Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, 'utf8')));
  }
  return cfg;
}

function isCategoryEnabled(cfg, name) {
  if (cfg.categories === 'all') return true;
  const list = Array.isArray(cfg.categories) ? cfg.categories : [cfg.categories];
  return list.includes(name);
}

function detectFramework(projectDir) {
  const pkg = readJson(path.join(projectDir, 'package.json')) || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return 'nextjs';
  if (deps.vite) return 'vite';
  return 'node';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function toScreamingSnake(str) {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-.\s/]+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .toUpperCase()
    .replace(/^_+|_+$/g, '');
}

function shannonEntropy(s) {
  if (!s || s.length < 2) return 0;
  const freq = {};
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  let e = 0;
  for (const n of Object.values(freq)) {
    const p = n / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

function isTestFile(filePath) {
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filePath) ||
         /\/__tests__\//.test(filePath) ||
         /\/test\//.test(filePath);
}

function isDeclarationFile(filePath) {
  return filePath.endsWith('.d.ts');
}

function getAncestorContext(node) {
  let cur = node.getParent();
  const kinds = [];
  while (cur) {
    const k = cur.getKind();
    if (k === SK.VariableDeclaration) {
      const name = cur.getName?.();
      if (name) return name;
    }
    if (k === SK.PropertyAssignment) {
      const name = cur.getName?.();
      if (name) return name;
    }
    if (k === SK.Parameter) {
      const name = cur.getName?.();
      if (name) return name;
    }
    if (k === SK.CallExpression) {
      const expr = cur.getExpression?.();
      const text = expr?.getText?.() || '';
      kinds.push(text.split('.').pop() || '');
    }
    if (k === SK.ReturnStatement || k === SK.ArrowFunction ||
        k === SK.FunctionDeclaration || k === SK.MethodDeclaration) break;
    cur = cur.getParent();
  }
  return kinds.filter(Boolean).join('_') || '';
}

function isInTypePosition(node) {
  let cur = node.getParent();
  while (cur) {
    const k = cur.getKind();
    if (k === SK.LiteralType || k === SK.TypeAliasDeclaration ||
        k === SK.InterfaceDeclaration || k === SK.EnumDeclaration ||
        k === SK.TypeLiteral || k === SK.UnionType) return true;
    if (k === SK.VariableDeclaration || k === SK.FunctionDeclaration ||
        k === SK.CallExpression) return false;
    cur = cur.getParent();
  }
  return false;
}

function isClientFile(filePath, framework) {
  if (framework !== 'nextjs') return false;
  return /\/(app|pages|components|src\/components|src\/app|src\/pages)\//.test(filePath) &&
         !/\/api\//.test(filePath);
}

function makeVarName(base, taken, suffix = '') {
  const candidate = toScreamingSnake(base) + (suffix ? `_${suffix}` : '');
  if (!candidate || candidate === '_') return 'UNKNOWN_VALUE';
  if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  let i = 2;
  while (taken.has(`${candidate}_${i}`)) i++;
  taken.add(`${candidate}_${i}`);
  return `${candidate}_${i}`;
}

// ---------------------------------------------------------------------------
// Finders
// ---------------------------------------------------------------------------
const SECRET_PREFIXES = ['sk_live_', 'pk_live_', 'sk_test_', 'pk_test_',
  'Bearer ', 'ghp_', 'ghs_', 'xoxb-', 'xoxp-', 'xoxa-', 'SG.'];
const SECRET_KEYWORDS = ['key', 'secret', 'token', 'password', 'passwd', 'pwd',
  'auth', 'credential', 'apikey', 'api_key', 'accesstoken', 'access_token',
  'privatekey', 'private_key', 'clientsecret', 'client_secret'];
const TIMEOUT_KEYWORDS = ['timeout', 'delay', 'interval', 'ttl', 'expiry',
  'expiration', 'duration', 'wait', 'sleep', 'debounce', 'throttle'];
const LIMIT_KEYWORDS = ['limit', 'max', 'min', 'size', 'count', 'length',
  'threshold', 'batch', 'page', 'rate', 'retries', 'attempts', 'concurrency',
  'capacity', 'buffer', 'chunk', 'take', 'skip', 'offset'];
const FLAG_KEYWORDS = ['enable', 'disable', 'feature', 'flag', 'toggle',
  'show', 'hide', 'allow', 'block', 'use', 'is_', 'can_'];
const PORT_CONTEXTS = ['listen', 'port', 'PORT', 'createServer', 'connect'];

function findStringLiterals(sf) {
  const results = [];
  sf.forEachDescendant(node => {
    const k = node.getKind();
    if (k !== SK.StringLiteral && k !== SK.NoSubstitutionTemplateLiteral) return;
    if (isInTypePosition(node)) return;
    const val = node.getLiteralValue?.() ?? node.getText().slice(1, -1);
    if (!val || val.length < 2) return;
    results.push({ node, val });
  });
  return results;
}

function findNumericLiterals(sf) {
  const results = [];
  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.NumericLiteral) return;
    if (isInTypePosition(node)) return;
    const val = Number(node.getLiteralValue());
    if (isNaN(val)) return;
    results.push({ node, val });
  });
  return results;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------
function claimNode(claimedNodes, sf, node) {
  const key = `${sf.getFilePath()}:${node.getStart()}`;
  if (claimedNodes.has(key)) return false;
  claimedNodes.add(key);
  return true;
}

function detectSecrets(sf, taken, findings, claimedNodes) {
  for (const { node, val } of findStringLiterals(sf)) {
    const ctx = getAncestorContext(node).toLowerCase();
    const isKnownPrefix = SECRET_PREFIXES.some(p => val.startsWith(p));
    const isSecretNamed = SECRET_KEYWORDS.some(k => ctx.includes(k));
    const isHighEntropy = val.length >= 20 && shannonEntropy(val) > 3.8;
    const isJwt = /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(val);

    if (!isKnownPrefix && !isSecretNamed && !isHighEntropy && !isJwt) continue;
    if (!claimNode(claimedNodes, sf, node)) continue;

    const confidence = isKnownPrefix || isJwt ? 'high' : isSecretNamed ? 'high' : 'medium';
    const varName = makeVarName(ctx || 'SECRET', taken);

    findings.push({
      category: 'secrets', value: val, type: 'string', varName,
      destination: 'env', confidence,
      occurrences: [occurrence(sf, node, val)],
    });
  }
}

function detectUrls(sf, taken, findings, claimedNodes) {
  for (const { node, val } of findStringLiterals(sf)) {
    if (!/^https?:\/\/|^wss?:\/\//.test(val)) continue;
    if (!claimNode(claimedNodes, sf, node)) continue;
    const ctx = getAncestorContext(node).toLowerCase();
    try {
      const u = new URL(val);
      const hostname = u.hostname.replace(/^www\./, '');
      const slug = hostname.split('.')[0];
      // Only append _URL suffix if the context name doesn't already contain "url"
      const suffix = ctx.includes('url') ? '' : 'URL';
      const varName = makeVarName(ctx || `${slug}_url`, taken, suffix);
      findings.push({
        category: 'urls', value: val, type: 'string', varName,
        destination: 'env', confidence: 'high',
        occurrences: [occurrence(sf, node, val)],
      });
    } catch { /* invalid URL */ }
  }
}

function detectPorts(sf, taken, findings, claimedNodes) {
  for (const { node, val } of findNumericLiterals(sf)) {
    if (val < 80 || val > 65535) continue;
    const raw = sf.getText().slice(
      Math.max(0, node.getStart() - 30), node.getStart()
    ).toLowerCase();
    if (!PORT_CONTEXTS.some(k => raw.includes(k.toLowerCase()))) continue;
    if (!claimNode(claimedNodes, sf, node)) continue;
    const varName = makeVarName('PORT', taken);
    findings.push({
      category: 'ports', value: val, type: 'number', varName,
      destination: 'env', confidence: 'high',
      occurrences: [occurrence(sf, node, String(val))],
    });
  }
}

function detectFeatureFlags(sf, taken, findings, claimedNodes) {
  // const ENABLE_X = true/false
  sf.getVariableDeclarations().forEach(decl => {
    const init = decl.getInitializer();
    if (!init) return;
    const k = init.getKind();
    if (k !== SK.TrueKeyword && k !== SK.FalseKeyword) return;
    const name = decl.getName();
    const lower = name.toLowerCase();
    if (!FLAG_KEYWORDS.some(kw => lower.includes(kw) || lower.startsWith(kw))) return;
    const varName = makeVarName(name, taken);
    const rawVal = k === SK.TrueKeyword;
    findings.push({
      category: 'feature-flags', value: rawVal, type: 'boolean', varName,
      destination: 'flags', confidence: 'high',
      declarationName: name,
      occurrences: [occurrence(sf, decl, `const ${name} = ${rawVal}`)],
    });
  });
}

function detectTimeouts(sf, taken, findings, claimedNodes) {
  for (const { node, val } of findNumericLiterals(sf)) {
    if (val <= 0) continue;
    const ctx = getAncestorContext(node).toLowerCase();
    const surrounding = sf.getText().slice(
      Math.max(0, node.getStart() - 60), node.getEnd() + 20
    ).toLowerCase();
    if (!TIMEOUT_KEYWORDS.some(k => ctx.includes(k) || surrounding.includes(k))) continue;
    if (!claimNode(claimedNodes, sf, node)) continue;
    // Only append unit suffix when unambiguous — explicit 'ms' in surrounding text
    // or context already contains a time unit word
    const hasExplicitMs = surrounding.includes('ms') || ctx.includes('ms');
    const hasExplicitS  = surrounding.includes(' s)') || surrounding.includes(' s,');
    const unit = hasExplicitMs ? 'MS' : hasExplicitS ? 'S' : 'MS';
    const varName = makeVarName(ctx || 'timeout', taken, unit);
    findings.push({
      category: 'timeouts', value: val, type: 'number', varName,
      destination: 'config', confidence: 'medium',
      occurrences: [occurrence(sf, node, String(val))],
    });
  }
}

function detectLimits(sf, taken, findings, claimedNodes) {
  for (const { node, val } of findNumericLiterals(sf)) {
    if (val <= 0 || SKIP_NUMERIC.has(val)) continue;
    const ctx = getAncestorContext(node).toLowerCase();
    const surrounding = sf.getText().slice(
      Math.max(0, node.getStart() - 60), node.getEnd() + 20
    ).toLowerCase();
    if (!LIMIT_KEYWORDS.some(k => ctx.includes(k) || surrounding.includes(k))) continue;
    if (!claimNode(claimedNodes, sf, node)) continue;
    const varName = makeVarName(ctx || 'limit', taken);
    findings.push({
      category: 'limits', value: val, type: 'number', varName,
      destination: 'config', confidence: 'medium',
      occurrences: [occurrence(sf, node, String(val))],
    });
  }
}

function detectPaths(sf, taken, findings, claimedNodes) {
  for (const { node, val } of findStringLiterals(sf)) {
    if (val.length < 3) continue;
    // Absolute paths with 2+ segments, or common path patterns
    if (!(/^\/[a-zA-Z0-9_./-]{3,}\//.test(val) ||
          val.startsWith('/var/') || val.startsWith('/tmp/') ||
          val.startsWith('/etc/') || val.startsWith('/home/'))) continue;
    if (!claimNode(claimedNodes, sf, node)) continue;
    const ctx = getAncestorContext(node).toLowerCase();
    const varName = makeVarName(ctx || val.replace(/\//g, '_').replace(/^_/, ''), taken);
    findings.push({
      category: 'paths', value: val, type: 'string', varName,
      destination: 'constants', confidence: 'medium',
      occurrences: [occurrence(sf, node, val)],
    });
  }
}

function detectRepeated(sf, countMap) {
  for (const { node, val } of findStringLiterals(sf)) {
    if (val.length < 3) continue;
    if (/^https?:\/\//.test(val)) continue; // already caught by urls
    const key = `str:${val}`;
    if (!countMap.has(key)) countMap.set(key, { val, type: 'string', files: [], nodes: [] });
    countMap.get(key).files.push(sf.getFilePath());
    countMap.get(key).nodes.push({ sf, node });
  }
  for (const { node, val } of findNumericLiterals(sf)) {
    if (SKIP_NUMERIC.has(val) || val < 0) continue;
    const key = `num:${val}`;
    if (!countMap.has(key)) countMap.set(key, { val, type: 'number', files: [], nodes: [] });
    countMap.get(key).files.push(sf.getFilePath());
    countMap.get(key).nodes.push({ sf, node });
  }
}

function detectMagicNumbers(sf, taken, claimedValues, findings) {
  for (const { node, val } of findNumericLiterals(sf)) {
    if (SKIP_NUMERIC.has(val) || val < 0) continue;
    if (claimedValues.has(`num:${val}`)) continue;
    const ctx = getAncestorContext(node).toLowerCase();
    if (ctx) continue; // has context — would have been caught by timeouts/limits
    findings.push({
      category: 'magic-numbers', value: val, type: 'number',
      varName: `MAGIC_NUMBER_${val}`.replace('.', '_'),
      destination: 'constants', confidence: 'low',
      occurrences: [occurrence(sf, node, String(val))],
    });
  }
}

function occurrence(sf, node, raw) {
  return {
    file: sf.getFilePath(),
    line: node.getStartLineNumber(),
    offset: node.getStart(),
    length: node.getWidth(),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Analysis orchestration
// ---------------------------------------------------------------------------
function cmdAnalyze(cfg, projectDir) {
  const framework = cfg.framework === 'auto' ? detectFramework(projectDir) : cfg.framework;
  const exclude = cfg.exclude;
  const extensions = cfg.extensions;

  const project = new Project({
    compilerOptions: { allowJs: true, jsx: 1, target: 99 },
    skipAddingFilesFromTsConfig: true,
  });

  // Add files
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!exclude.includes(entry.name)) walk(full);
      } else if (extensions.some(e => entry.name.endsWith(e))) {
        if (!isDeclarationFile(full)) project.addSourceFileAtPath(full);
      }
    }
  };
  walk(path.resolve(projectDir));

  const sourceFiles = project.getSourceFiles();
  console.error(`  Scanning ${sourceFiles.length} files...`);

  const findings = [];
  const taken = new Set();
  const countMap = new Map();

  // claimedNodes prevents the same literal node being claimed by two categories
  const claimedNodes = new Set(); // key: `${filePath}:${offset}`

  for (const sf of sourceFiles) {
    const fp = sf.getFilePath();
    if (isTestFile(fp)) continue;

    if (isCategoryEnabled(cfg, 'secrets'))       detectSecrets(sf, taken, findings, claimedNodes);
    if (isCategoryEnabled(cfg, 'urls'))           detectUrls(sf, taken, findings, claimedNodes);
    if (isCategoryEnabled(cfg, 'ports'))          detectPorts(sf, taken, findings, claimedNodes);
    if (isCategoryEnabled(cfg, 'feature-flags'))  detectFeatureFlags(sf, taken, findings, claimedNodes);
    if (isCategoryEnabled(cfg, 'timeouts'))       detectTimeouts(sf, taken, findings, claimedNodes);
    if (isCategoryEnabled(cfg, 'limits'))         detectLimits(sf, taken, findings, claimedNodes);
    if (isCategoryEnabled(cfg, 'paths'))          detectPaths(sf, taken, findings, claimedNodes);
    if (isCategoryEnabled(cfg, 'repeated'))       detectRepeated(sf, countMap);
  }

  // Process repeated counts
  const threshold = cfg.threshold || 2;
  const claimedValues = new Set(findings.map(f =>
    `${f.type === 'string' ? 'str' : 'num'}:${f.value}`
  ));

  if (isCategoryEnabled(cfg, 'repeated')) {
    for (const [key, entry] of countMap) {
      if (entry.files.length < threshold) continue;
      if (claimedValues.has(key)) continue;
      const ctx = getAncestorContext(entry.nodes[0]?.node).toLowerCase() || '';
      const varName = makeVarName(
        ctx || String(entry.val).replace(/[^a-zA-Z0-9]/g, '_'),
        taken
      );
      const occs = entry.nodes.map(({ sf, node }) =>
        occurrence(sf, node, JSON.stringify(entry.val))
      );
      findings.push({
        category: 'repeated', value: entry.val, type: entry.type, varName,
        destination: 'constants', confidence: 'medium',
        occurrences: occs,
      });
      claimedValues.add(key);
    }
  }

  // Magic numbers — after all other categories claimed their values
  if (isCategoryEnabled(cfg, 'magic-numbers')) {
    for (const sf of sourceFiles) {
      if (isTestFile(sf.getFilePath())) continue;
      detectMagicNumbers(sf, taken, claimedValues, findings);
    }
  }

  // Deduplicate findings with same value+category (across files)
  const merged = mergeFindings(findings);

  const outDir = path.join(projectDir, '.config-extractor');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'findings.json'),
    JSON.stringify({ framework, findings: merged, stats: stats(merged) }, null, 2)
  );

  printSummary(merged);
  return { framework, findings: merged };
}

function mergeFindings(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = `${f.category}:${JSON.stringify(f.value)}`;
    if (!map.has(key)) {
      map.set(key, { ...f, occurrences: [...f.occurrences] });
    } else {
      map.get(key).occurrences.push(...f.occurrences);
    }
  }
  return [...map.values()];
}

function stats(findings) {
  const byCategory = {};
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  }
  return { total: findings.length, byCategory };
}

function printSummary(findings) {
  const DEST_LABELS = {
    env: '.env.example', config: 'config/config.ts',
    flags: 'config/feature-flags.ts', constants: 'config/constants.ts',
  };
  const byCategory = {};
  for (const f of findings) {
    if (!byCategory[f.category]) byCategory[f.category] = { count: 0, dest: DEST_LABELS[f.destination] };
    byCategory[f.category].count++;
  }
  console.log('\n' + '─'.repeat(62));
  console.log(`${'Category'.padEnd(18)} ${'Findings'.padEnd(10)} ${'Destination'.padEnd(28)} Auto`);
  console.log('─'.repeat(62));
  for (const [cat, { count, dest }] of Object.entries(byCategory)) {
    const auto = cat === 'magic-numbers' ? 'confirm' : 'yes';
    console.log(`${cat.padEnd(18)} ${String(count).padEnd(10)} ${dest.padEnd(28)} ${auto}`);
  }
  console.log('─'.repeat(62));
  console.log(`${'Total'.padEnd(18)} ${findings.length}`);
}

// ---------------------------------------------------------------------------
// Generate config files
// ---------------------------------------------------------------------------
function cmdGenerate(cfg, projectDir) {
  const findingsPath = path.join(projectDir, '.config-extractor', 'findings.json');
  if (!fs.existsSync(findingsPath)) {
    console.error('Run --mode analyze first.');
    process.exit(1);
  }
  const { findings } = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));

  const envPath    = path.resolve(projectDir, cfg.envFile);
  const cfgPath    = path.resolve(projectDir, cfg.configModule);
  const flagsPath  = path.resolve(projectDir, cfg.flagsModule);
  const constPath  = path.resolve(projectDir, cfg.constantsModule);

  generateEnvFile(findings.filter(f => f.destination === 'env'), envPath);
  generateConfigModule(findings.filter(f => f.destination === 'config'), cfgPath);
  generateFlagsModule(findings.filter(f => f.destination === 'flags'), flagsPath);
  generateConstantsModule(findings.filter(f => f.destination === 'constants'), constPath);

  console.log(`\nConfig files written:`);
  console.log(`  ${envPath}`);
  console.log(`  ${cfgPath}`);
  console.log(`  ${flagsPath}`);
  console.log(`  ${constPath}`);
}

function mergeOrCreate(filePath, newContent, mergeKey) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, newContent, 'utf8');
    return;
  }
  const existing = fs.readFileSync(filePath, 'utf8');
  // Only append entries that don't already exist
  const lines = newContent.split('\n').filter(l => {
    const key = l.match(mergeKey)?.[1];
    if (!key) return false;
    return !existing.includes(key);
  });
  if (lines.length) {
    fs.writeFileSync(filePath, existing.trimEnd() + '\n\n' + lines.join('\n') + '\n', 'utf8');
  }
}

function generateEnvFile(findings, envPath) {
  if (!findings.length) return;
  const groups = { secrets: [], urls: [], ports: [] };
  for (const f of findings) {
    groups[f.category]?.push(f) || groups.urls.push(f);
  }
  const lines = [];
  if (groups.urls.length) {
    lines.push('# URLs');
    groups.urls.forEach(f => lines.push(`${f.varName}=${f.value}`));
  }
  if (groups.secrets.length) {
    lines.push('\n# Secrets (never commit real values)');
    groups.secrets.forEach(f => lines.push(`${f.varName}=`));
  }
  if (groups.ports.length) {
    lines.push('\n# Ports');
    groups.ports.forEach(f => lines.push(`${f.varName}=${f.value}`));
  }
  mergeOrCreate(envPath, lines.join('\n') + '\n', /^([A-Z_]+)=/);
}

function generateConfigModule(findings, cfgPath) {
  if (!findings.length) return;
  const entries = findings.map(f => {
    const def = JSON.stringify(f.value);
    return `  ${f.varName}: Number(process.env.${f.varName}) || ${def},`;
  }).join('\n');
  const content = `export const config = {\n${entries}\n} as const\n\nexport type Config = typeof config\n`;
  mergeOrCreate(cfgPath, content, /^\s{2}([A-Z_]+):/);
}

function generateFlagsModule(findings, flagsPath) {
  if (!findings.length) return;
  const entries = findings.map(f => {
    const def = JSON.stringify(f.value);
    return `  ${f.varName}: process.env.${f.varName} === 'true' || ${def},`;
  }).join('\n');
  const content = `export const flags = {\n${entries}\n} as const\n\nexport type Flags = typeof flags\n`;
  mergeOrCreate(flagsPath, content, /^\s{2}([A-Z_]+):/);
}

function generateConstantsModule(findings, constPath) {
  if (!findings.length) return;
  const pathFindings = findings.filter(f => f.category === 'paths');
  const otherFindings = findings.filter(f => f.category !== 'paths');

  const lines = [];
  for (const f of otherFindings) {
    lines.push(`export const ${f.varName} = ${JSON.stringify(f.value)}`);
  }
  if (pathFindings.length) {
    lines.push('');
    lines.push('export const paths = {');
    pathFindings.forEach(f => lines.push(`  ${f.varName}: ${JSON.stringify(f.value)},`));
    lines.push('} as const');
  }
  mergeOrCreate(constPath, lines.join('\n') + '\n', /^export const ([A-Z_a-z]+)/);
}

// ---------------------------------------------------------------------------
// Replace source files
// ---------------------------------------------------------------------------
function cmdReplace(cfg, projectDir, framework) {
  const findingsPath = path.join(projectDir, '.config-extractor', 'findings.json');
  if (!fs.existsSync(findingsPath)) {
    console.error('Run --mode analyze first.');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  const findings = data.findings;
  const fw = framework || data.framework || 'node';

  // Group replacements by file
  const fileReplacements = new Map();
  const fileImports = new Map();

  for (const finding of findings) {
    for (const occ of finding.occurrences) {
      if (isTestFile(occ.file)) continue;

      const replacement = buildReplacement(finding, occ.file, fw, cfg);
      if (!replacement) continue;

      if (!fileReplacements.has(occ.file)) fileReplacements.set(occ.file, []);
      fileReplacements.get(occ.file).push({
        offset: occ.offset, length: occ.length,
        replacement: replacement.text,
      });

      // Track imports needed
      if (replacement.importFrom) {
        if (!fileImports.has(occ.file)) fileImports.set(occ.file, new Map());
        const imp = fileImports.get(occ.file);
        if (!imp.has(replacement.importFrom)) imp.set(replacement.importFrom, new Set());
        if (replacement.importName) imp.get(replacement.importFrom).add(replacement.importName);
      }
    }
  }

  // Handle feature flag declaration removal separately
  const flagFindings = findings.filter(f => f.category === 'feature-flags');
  for (const f of flagFindings) {
    for (const occ of f.occurrences) {
      if (isTestFile(occ.file)) continue;
      if (!fileReplacements.has(occ.file)) fileReplacements.set(occ.file, []);
      // Mark the full declaration for removal
      fileReplacements.get(occ.file).push({
        offset: occ.offset, length: occ.length,
        replacement: '', isDeclaration: true,
      });
    }
  }

  let modifiedCount = 0;
  for (const [filePath, replacements] of fileReplacements) {
    if (!fs.existsSync(filePath)) continue;

    let content = fs.readFileSync(filePath, 'utf8');
    // Sort by offset descending to preserve positions
    const sorted = [...replacements].sort((a, b) => b.offset - a.offset);
    for (const { offset, length, replacement } of sorted) {
      content = content.slice(0, offset) + replacement + content.slice(offset + length);
    }

    // Add imports
    const imports = fileImports.get(filePath);
    if (imports) {
      for (const [from, names] of imports) {
        const nameList = [...names].sort().join(', ');
        const stmt = `import { ${nameList} } from '${from}'`;
        if (content.includes(stmt)) continue;
        // Check if the module is already imported and we just need to add names
        const existingRe = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
        const match = existingRe.exec(content);
        if (match) {
          const existing = match[1].split(',').map(s => s.trim()).filter(Boolean);
          const merged = [...new Set([...existing, ...names])].sort().join(', ');
          content = content.replace(match[0], `import { ${merged} } from '${from}'`);
        } else {
          // Insert after last import
          const lastImportEnd = findLastImportEnd(content);
          content = content.slice(0, lastImportEnd) + stmt + '\n' + content.slice(lastImportEnd);
        }
      }
    }

    fs.writeFileSync(filePath, content, 'utf8');
    modifiedCount++;
    console.error(`  ✓ ${path.relative(projectDir, filePath)}`);
  }
  console.log(`\nModified ${modifiedCount} file(s)`);
}

function buildReplacement(finding, filePath, framework, cfg) {
  const alias = getModuleAlias(cfg, finding.destination);
  const varName = finding.varName;

  switch (finding.destination) {
    case 'env': {
      const isClient = isClientFile(filePath, framework);
      if (framework === 'vite') {
        const prefix = isClient ? 'VITE_' : '';
        return { text: `import.meta.env.${prefix}${varName}`, importFrom: null };
      }
      const prefix = isClient ? 'NEXT_PUBLIC_' : '';
      const envKey = prefix ? varName.replace(/^NEXT_PUBLIC_/, prefix) : varName;
      return { text: `process.env.${envKey}!`, importFrom: null };
    }
    case 'config':
      return {
        text: `config.${varName}`,
        importFrom: alias, importName: 'config',
      };
    case 'flags':
      if (finding.category === 'feature-flags') {
        // Usages replaced with flags.VARNAME; declaration handled separately
        return { text: `flags.${varName}`, importFrom: alias, importName: 'flags' };
      }
      return { text: `flags.${varName}`, importFrom: alias, importName: 'flags' };
    case 'constants':
      return { text: varName, importFrom: alias, importName: varName };
    default:
      return null;
  }
}

function getModuleAlias(cfg, destination) {
  const aliases = {
    config: '@/config/config',
    flags: '@/config/feature-flags',
    constants: '@/config/constants',
  };
  return aliases[destination] || null;
}

function findLastImportEnd(content) {
  const lines = content.split('\n');
  let lastImportLine = 0;
  lines.forEach((line, i) => {
    if (/^import\s/.test(line) || /^}\s*from\s*['"]/.test(line)) {
      lastImportLine = i;
    }
  });
  // Return the character offset after the last import line
  let offset = 0;
  for (let i = 0; i <= lastImportLine; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }
  return offset;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------
function cmdValidate(projectDir) {
  console.error('\nValidating with tsc --noEmit...');
  if (!fs.existsSync(path.join(projectDir, 'tsconfig.json'))) {
    console.error('  ⚠  No tsconfig.json — skipping TypeScript validation');
    return true;
  }
  const tscPath = path.join(projectDir, 'node_modules', '.bin', 'tsc');
  const tsc = fs.existsSync(tscPath) ? tscPath : 'tsc';
  const result = spawnSync(tsc, ['--noEmit'], { cwd: projectDir, encoding: 'utf8' });
  if (result.status === 0) {
    console.log('  ✓ tsc --noEmit passed');
    return true;
  }
  console.error('  ✗ Type errors after extraction:');
  console.error((result.stdout || result.stderr || '').split('\n').slice(0, 20).join('\n'));
  console.error('\n  To revert: git checkout .');
  return false;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function cmdReport(cfg, projectDir) {
  const findingsPath = path.join(projectDir, '.config-extractor', 'findings.json');
  if (!fs.existsSync(findingsPath)) return;
  const { findings } = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));

  const date = new Date().toISOString().slice(0, 10);
  const byCategory = {};
  for (const f of findings) {
    const k = f.category;
    if (!byCategory[k]) byCategory[k] = { count: 0, dest: f.destination };
    byCategory[k].count++;
  }

  const DEST = { env: '.env.example', config: 'config/config.ts', flags: 'config/feature-flags.ts', constants: 'config/constants.ts' };
  const tableRows = Object.entries(byCategory)
    .map(([cat, { count, dest }]) => `| \`${cat}\` | ${count} | ${DEST[dest] || dest} |`)
    .join('\n');

  const secrets = findings.filter(f => f.category === 'secrets');
  const secretLines = secrets.map(f =>
    f.occurrences.map(o => `- \`${path.relative(projectDir, o.file)}:${o.line}\` — proposed: \`${f.varName}\``)
  ).flat().join('\n');

  const lowConf = findings.filter(f => f.confidence === 'low');
  const lowLines = lowConf.map(f =>
    `- value \`${f.value}\` → proposed \`${f.varName}\` (${f.occurrences[0]?.file?.replace(projectDir, '')}:${f.occurrences[0]?.line})`
  ).join('\n');

  const report = `# Config Extractor Report

Date: ${date}

## Extracted by category

| Category | Count | Destination |
|---|---|---|
${tableRows}

## Security flags

${secrets.length ? `⚠ The following hardcoded secrets were found. Remove from git history if ever committed:\n\n${secretLines}` : '_No secrets found._'}

## Manual review needed (low confidence)

${lowConf.length ? lowLines : '_None._'}
`;

  const reportPath = path.join(projectDir, '.config-extractor', 'report.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`\nReport written to ${reportPath}`);
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------
function cmdRun(cfg, projectDir) {
  // Pre-flight warnings
  const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' });
  if (gitStatus.stdout?.trim()) {
    console.error('  ⚠  Uncommitted changes — revert with: git checkout .');
  }

  console.error('\n── Analyze ─────────────────────────────');
  const { framework, findings } = cmdAnalyze(cfg, projectDir);

  if (cfg.dryRun) { console.log('\ndryRun=true — stopping after analysis.'); return; }

  console.error('\n── Generate ────────────────────────────');
  cmdGenerate(cfg, projectDir);

  if (cfg.replace !== false) {
    console.error('\n── Replace ─────────────────────────────');
    cmdReplace(cfg, projectDir, framework);
  }

  console.error('\n── Validate ────────────────────────────');
  cmdValidate(projectDir);

  console.error('\n── Report ──────────────────────────────');
  cmdReport(cfg, projectDir);

  const byDest = {};
  for (const f of findings) byDest[f.destination] = (byDest[f.destination] || 0) + 1;
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Extraction complete`);
  console.log(`  .env.example       ${byDest.env || 0} variables`);
  console.log(`  config/config.ts   ${byDest.config || 0} variables`);
  console.log(`  config/flags.ts    ${byDest.flags || 0} flags`);
  console.log(`  config/constants   ${byDest.constants || 0} constants`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(`
Usage: node extractor.js --mode <mode> [options]

Modes:
  analyze    Scan repo and write .config-extractor/findings.json
  generate   Write config files from findings
  replace    Rewrite source files with config references
  validate   Run tsc --noEmit
  report     Write .config-extractor/report.md
  run        Full pipeline

Options:
  --project-dir <path>   Root of the project (default: .)
  --config <path>        Path to config-extractor.config.json
  --dry-run              Analyze only, no writes
  --no-replace           Skip source file rewriting
  --help                 Show this help
`);
    process.exit(0);
  }

  const mode = args.mode;
  if (!mode) { console.error('Error: --mode is required.'); process.exit(1); }

  const projectDir = path.resolve(args.projectDir || args['project-dir'] || '.');
  const cfg = loadConfig(args.config, projectDir);
  if (args.dryRun || args['dry-run']) cfg.dryRun = true;
  if (args['no-replace']) cfg.replace = false;

  switch (mode) {
    case 'analyze':  cmdAnalyze(cfg, projectDir); break;
    case 'generate': cmdGenerate(cfg, projectDir); break;
    case 'replace':  cmdReplace(cfg, projectDir); break;
    case 'validate': cmdValidate(projectDir); break;
    case 'report':   cmdReport(cfg, projectDir); break;
    case 'run':      cmdRun(cfg, projectDir); break;
    default: console.error(`Unknown mode: ${mode}`); process.exit(1);
  }
}

main();
