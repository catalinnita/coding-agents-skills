#!/usr/bin/env node
'use strict';

/**
 * Documentation generator — modes: analyze | scaffold | generate | validate | run
 * Requires: ts-morph (auto-installed on first run)
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
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

const { Project, SyntaxKind } = require('ts-morph');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function findFiles(dir, extensions, exclude = []) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (!exclude.includes(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function toPascalCase(str) {
  return str.replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULTS = {
  outputDir: '_docs',
  sections: 'all',
  baseUrl: '/',
  theme: 'docs',
  diagramFormats: 'excalidraw',
  dryRun: false,
};

function loadConfig(configPath, projectDir) {
  const cfg = { ...DEFAULTS };
  let cfgFile = configPath ? path.resolve(configPath) : path.join(projectDir, 'doc-generator.config.json');
  if (fs.existsSync(cfgFile) && fs.statSync(cfgFile).size > 0) {
    Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, 'utf8')));
  }
  cfg.outputDir = path.resolve(projectDir, cfg.outputDir);
  return cfg;
}

function sectionEnabled(cfg, name) {
  if (cfg.sections === 'all') return true;
  const list = Array.isArray(cfg.sections) ? cfg.sections : [cfg.sections];
  return list.includes(name);
}

// ---------------------------------------------------------------------------
// STEP 1 — ANALYSE
// ---------------------------------------------------------------------------
function detectPackageManager(projectDir) {
  if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function detectFramework(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return 'nextjs';
  if (deps.vite) return 'vite';
  if (deps['react-scripts']) return 'cra';
  if (deps.nuxt) return 'nuxt';
  if (deps.fastify) return 'fastify';
  if (deps.express) return 'express';
  if (deps.hono) return 'hono';
  return 'node';
}

function detectStateManagement(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const found = [];
  if (deps['@reduxjs/toolkit'] || deps.redux) found.push('redux');
  if (deps.zustand) found.push('zustand');
  if (deps.jotai) found.push('jotai');
  if (deps.recoil) found.push('recoil');
  if (deps.mobx) found.push('mobx');
  return found;
}

function detectTestRunner(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vitest) return 'vitest';
  if (deps.jest) return 'jest';
  if (deps.playwright) return 'playwright';
  if (deps.cypress) return 'cypress';
  return null;
}

function parseReadme(readmePath) {
  const text = readText(readmePath);
  if (!text) return { overview: '', installation: '', sections: {} };

  const lines = text.split('\n');
  let overview = '';
  const sections = {};
  let currentSection = '';
  let buffer = [];

  // First non-heading, non-empty paragraph is the overview
  for (const line of lines) {
    if (line.startsWith('#')) {
      if (currentSection && buffer.length) {
        sections[currentSection.toLowerCase()] = buffer.join('\n').trim();
      }
      currentSection = line.replace(/^#+\s*/, '');
      buffer = [];
    } else {
      buffer.push(line);
      if (!overview && line.trim() && !line.startsWith('#')) {
        overview = line.trim();
      }
    }
  }
  if (currentSection && buffer.length) {
    sections[currentSection.toLowerCase()] = buffer.join('\n').trim();
  }

  const installation = sections['installation'] || sections['getting started'] ||
    sections['setup'] || sections['quick start'] || '';

  return { overview, installation, sections, raw: text };
}

function parseEnvExample(projectDir) {
  const candidates = ['.env.example', '.env.local.example', '.env.sample', '.env.template'];
  for (const name of candidates) {
    const fp = path.join(projectDir, name);
    if (!fs.existsSync(fp)) continue;
    const vars = [];
    for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        // Capture comment as description for next var
        continue;
      }
      const [rawKey] = trimmed.split('=');
      const key = rawKey.trim();
      if (!key) continue;
      // Find preceding comment lines
      const lineIdx = fs.readFileSync(fp, 'utf8').split('\n').indexOf(line);
      const prevLine = fs.readFileSync(fp, 'utf8').split('\n')[lineIdx - 1] || '';
      const description = prevLine.startsWith('#') ? prevLine.replace(/^#\s*/, '') : '';
      const required = !trimmed.includes('=') || trimmed.endsWith('=') ? 'required' : 'optional';
      vars.push({ key, required, description });
    }
    return vars;
  }
  return [];
}

function findApiRoutes(projectDir, framework) {
  const routes = [];

  // Next.js App Router
  const appApiDir = path.join(projectDir, 'app', 'api');
  const srcAppApiDir = path.join(projectDir, 'src', 'app', 'api');
  for (const base of [appApiDir, srcAppApiDir]) {
    for (const file of findFiles(base, ['.ts', '.js'], [])) {
      if (!file.endsWith('route.ts') && !file.endsWith('route.js')) continue;
      const rel = path.relative(base, file);
      const routePath = '/' + path.dirname(rel).replace(/\\/g, '/').replace(/\(.*?\)\//g, '');
      const content = readText(file);
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
        if (new RegExp(`export (async )?function ${method}|export const ${method}`).test(content)) {
          routes.push({ method, path: `/api${routePath}`, file, framework: 'nextjs-app' });
        }
      }
    }
  }

  // Next.js Pages Router
  for (const base of [path.join(projectDir, 'pages', 'api'), path.join(projectDir, 'src', 'pages', 'api')]) {
    for (const file of findFiles(base, ['.ts', '.js'], [])) {
      const rel = path.relative(base, file);
      const routePath = '/' + rel.replace(/\\/g, '/').replace(/\.(ts|js)x?$/, '').replace(/\/index$/, '');
      const content = readText(file);
      const methods = [];
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
        if (new RegExp(`['"]${method}['"]`).test(content) || new RegExp(`req\\.method\\s*===?\\s*['"]${method}`).test(content)) {
          methods.push(method);
        }
      }
      if (methods.length === 0) methods.push('GET'); // default
      methods.forEach(method => {
        routes.push({ method, path: `/api${routePath}`, file, framework: 'nextjs-pages' });
      });
    }
  }

  // Express / Fastify
  for (const routeDir of ['routes', 'src/routes', 'src/api', 'server/routes']) {
    for (const file of findFiles(path.join(projectDir, routeDir), ['.ts', '.js'], [])) {
      const content = readText(file);
      const methodRegex = /\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)/g;
      let match;
      while ((match = methodRegex.exec(content)) !== null) {
        routes.push({
          method: match[1].toUpperCase(),
          path: match[2],
          file,
          framework: framework === 'fastify' ? 'fastify' : 'express',
        });
      }
    }
  }

  return routes;
}

function analyzeComponents(projectDir, cfg) {
  const componentDirs = ['src/components', 'components', 'src/ui', 'ui', 'src/features', 'src/app'].map(d => path.join(projectDir, d));
  const allFiles = componentDirs.flatMap(d => findFiles(d, ['.tsx', '.jsx'], ['__tests__', 'test', 'stories']));

  if (allFiles.length === 0) return [];

  const project = new Project({
    compilerOptions: { jsx: 1, target: 99, allowJs: true },
    skipAddingFilesFromTsConfig: true,
  });
  allFiles.forEach(f => project.addSourceFileAtPath(f));

  const components = [];

  project.getSourceFiles().forEach(sf => {
    if (sf.getFilePath().endsWith('.d.ts')) return;

    const name = extractComponentName(sf);
    if (!name) return;

    const props = extractProps(sf, project);
    const description = extractComponentJsDoc(sf);
    const storyFile = allFiles.find(f => f.includes(name + '.stories'));

    components.push({
      name,
      file: sf.getFilePath(),
      description,
      props,
      hasStories: !!storyFile,
      storyFile: storyFile || null,
    });
  });

  return components.sort((a, b) => a.name.localeCompare(b.name));
}

function extractComponentName(sf) {
  // Try default export name
  const defaultExport = sf.getDefaultExportSymbol();
  if (defaultExport) {
    const name = defaultExport.getName();
    if (name && name !== 'default' && /^[A-Z]/.test(name)) return name;
  }
  // Try exported function declarations starting with uppercase
  for (const fn of sf.getFunctions()) {
    if (fn.isExported() && /^[A-Z]/.test(fn.getName() || '')) {
      const body = fn.getText();
      if (body.includes('return') && (body.includes('<') || body.includes('jsx'))) {
        return fn.getName();
      }
    }
  }
  // Infer from filename
  const base = path.basename(sf.getFilePath(), path.extname(sf.getFilePath()));
  if (/^[A-Z]/.test(base) && base !== 'index') return base;
  return null;
}

function extractProps(sf, project) {
  const props = [];

  // Find Props interface or type
  const propsInterface = sf.getInterface(i => /Props$/.test(i.getName())) ||
    sf.getInterfaces()[0];
  if (propsInterface) {
    propsInterface.getProperties().forEach(prop => {
      props.push({
        name: prop.getName(),
        type: prop.getTypeNode()?.getText() || 'unknown',
        required: !prop.hasQuestionToken(),
        defaultValue: extractDefaultValue(sf, prop.getName()),
        description: prop.getJsDocs().map(j => j.getComment()).filter(Boolean).join(' '),
      });
    });
    return props;
  }

  // Try type alias
  const propsType = sf.getTypeAlias(t => /Props$/.test(t.getName()));
  if (propsType) {
    const typeNode = propsType.getTypeNode();
    if (typeNode && typeNode.getKind() === SyntaxKind.TypeLiteral) {
      typeNode.getMembers().forEach(m => {
        if (m.getKind() === SyntaxKind.PropertySignature) {
          const p = m;
          props.push({
            name: p.getName(),
            type: p.getTypeNode()?.getText() || 'unknown',
            required: !p.hasQuestionToken(),
            defaultValue: null,
            description: '',
          });
        }
      });
    }
  }

  return props;
}

function extractDefaultValue(sf, propName) {
  // Look for destructuring defaults: { propName = defaultValue }
  // Must be preceded by space or comma to avoid matching `onClick = ...` inside a body
  const text = sf.getText();
  const regex = new RegExp(`(?:,|\\{|\\s)${propName}\\s*=\\s*([^,}\\n]+?)(?=\\s*[,}])`);
  const match = regex.exec(text);
  if (!match) return null;
  const val = match[1].trim();
  // Only accept simple literal defaults: strings, booleans, numbers
  if (!/^(['"`].*['"`]|true|false|\d+(\.\d+)?)$/.test(val)) return null;
  return val;
}

function extractComponentJsDoc(sf) {
  for (const fn of [...sf.getFunctions(), ...sf.getVariableDeclarations()]) {
    const docs = fn.getJsDocs?.();
    if (docs && docs.length) {
      return docs.map(d => d.getComment()).filter(Boolean).join(' ');
    }
  }
  return '';
}

function analyzeStateManagement(projectDir, stateLibs) {
  const stateInfo = { stores: [], slices: [], atoms: [], contexts: [] };

  if (stateLibs.includes('redux')) {
    // Find createSlice calls
    for (const file of findFiles(path.join(projectDir, 'src'), ['.ts', '.tsx', '.js'], ['node_modules'])) {
      const content = readText(file);
      const sliceMatches = content.matchAll(/createSlice\s*\(\s*\{[^}]*?name:\s*['"]([^'"]+)['"]/gs);
      for (const m of sliceMatches) {
        // Extract actions from the file
        const actions = [];
        const actionMatches = content.matchAll(/\b(increment|decrement|set\w+|add\w+|remove\w+|update\w+|reset\w+|toggle\w+|fetch\w+)\b/g);
        for (const am of actionMatches) actions.push(am[1]);
        stateInfo.slices.push({ name: m[1], file, actions: [...new Set(actions)].slice(0, 8) });
      }
    }
  }

  if (stateLibs.includes('zustand')) {
    for (const file of findFiles(path.join(projectDir, 'src'), ['.ts', '.tsx'], ['node_modules'])) {
      const content = readText(file);
      if (!content.includes('create(') && !content.includes('create<')) continue;
      const name = path.basename(file, path.extname(file));
      stateInfo.stores.push({ name, file });
    }
  }

  if (stateLibs.includes('jotai')) {
    for (const file of findFiles(path.join(projectDir, 'src'), ['.ts', '.tsx'], ['node_modules'])) {
      const content = readText(file);
      const atomMatches = content.matchAll(/(?:export\s+const\s+)(\w+)\s*=\s*atom[(<]/g);
      for (const m of atomMatches) {
        stateInfo.atoms.push({ name: m[1], file });
      }
    }
  }

  // React Context
  for (const file of findFiles(path.join(projectDir, 'src'), ['.tsx', '.ts'], ['node_modules'])) {
    const content = readText(file);
    const ctxMatches = content.matchAll(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*createContext/g);
    for (const m of ctxMatches) {
      stateInfo.contexts.push({ name: m[1], file });
    }
  }

  return stateInfo;
}

function analyzeDataFlow(projectDir, apiRoutes) {
  const nodes = [];
  const edges = [];

  // API layer from detected routes
  const routeGroups = {};
  apiRoutes.forEach(r => {
    const group = r.path.split('/')[2] || 'root';
    if (!routeGroups[group]) routeGroups[group] = [];
    routeGroups[group].push(r);
  });

  Object.entries(routeGroups).slice(0, 8).forEach(([group, routes]) => {
    nodes.push({ id: `api-${group}`, label: `API /${group}`, type: 'api', methods: routes.map(r => r.method) });
  });

  // Database usage
  const hasDB = { prisma: false, drizzle: false, mongoose: false };
  for (const file of findFiles(path.join(projectDir, 'src'), ['.ts', '.js'], ['node_modules']).slice(0, 50)) {
    const content = readText(file);
    if (content.includes('prisma.') || content.includes('@prisma/client')) hasDB.prisma = true;
    if (content.includes('drizzle(') || content.includes('drizzle-orm')) hasDB.drizzle = true;
    if (content.includes('mongoose.') || content.includes('Model.find')) hasDB.mongoose = true;
  }

  if (hasDB.prisma) nodes.push({ id: 'db-prisma', label: 'Prisma DB', type: 'database' });
  if (hasDB.drizzle) nodes.push({ id: 'db-drizzle', label: 'Drizzle DB', type: 'database' });
  if (hasDB.mongoose) nodes.push({ id: 'db-mongo', label: 'MongoDB', type: 'database' });

  // External fetch calls
  const externalApis = new Set();
  for (const file of findFiles(path.join(projectDir, 'src'), ['.ts', '.tsx', '.js'], ['node_modules']).slice(0, 50)) {
    const content = readText(file);
    const fetchMatches = content.matchAll(/fetch\s*\(['"`](https?:\/\/[^'"`\s]+)/g);
    for (const m of fetchMatches) {
      try { externalApis.add(new URL(m[1]).hostname); } catch { /* skip */ }
    }
    const axiosMatches = content.matchAll(/axios\.\w+\s*\(['"`](https?:\/\/[^'"`\s]+)/g);
    for (const m of axiosMatches) {
      try { externalApis.add(new URL(m[1]).hostname); } catch { /* skip */ }
    }
  }
  [...externalApis].slice(0, 4).forEach((host, i) => {
    nodes.push({ id: `ext-${i}`, label: host, type: 'external' });
  });

  // Client node
  nodes.unshift({ id: 'client', label: 'Client', type: 'client' });

  // Wire edges: client → api, api → db
  const apiNodes = nodes.filter(n => n.type === 'api');
  const dbNodes = nodes.filter(n => n.type === 'database');
  const extNodes = nodes.filter(n => n.type === 'external');

  apiNodes.forEach(api => {
    edges.push({ from: 'client', to: api.id, label: api.methods?.join('/') || 'HTTP' });
    dbNodes.forEach(db => edges.push({ from: api.id, to: db.id, label: 'query' }));
    extNodes.forEach(ext => edges.push({ from: api.id, to: ext.id, label: 'fetch' }));
  });

  return { nodes, edges };
}

function cmdAnalyze(cfg, projectDir) {
  const pkg = readJson(path.join(projectDir, 'package.json')) || {};
  const readme = parseReadme(path.join(projectDir, 'README.md'));
  const framework = detectFramework(pkg);
  const pkgManager = detectPackageManager(projectDir);
  const hasTS = fs.existsSync(path.join(projectDir, 'tsconfig.json'));
  const stateLibs = detectStateManagement(pkg);
  const testRunner = detectTestRunner(pkg);
  const envVars = parseEnvExample(projectDir);
  const apiRoutes = findApiRoutes(projectDir, framework);

  const title = cfg.title || pkg.name?.replace(/-/g, ' ').replace(/\b./g, c => c.toUpperCase()) || 'Project';
  const description = cfg.description || pkg.description || readme.overview || '';

  console.error('\nAnalysis complete:');
  console.error(`  Project:     ${title}`);
  console.error(`  Framework:   ${framework}`);
  console.error(`  Pkg manager: ${pkgManager}`);
  console.error(`  TypeScript:  ${hasTS}`);
  console.error(`  State:       ${stateLibs.join(', ') || 'none detected'}`);
  console.error(`  API routes:  ${apiRoutes.length}`);
  console.error(`  Env vars:    ${envVars.length}`);

  const analysis = { pkg, readme, framework, pkgManager, hasTS, stateLibs, testRunner, envVars, apiRoutes, title, description };

  const outDir = path.join(projectDir, '.doc-generator');
  fs.mkdirSync(outDir, { recursive: true });
  writeFile(path.join(outDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
  return analysis;
}

// ---------------------------------------------------------------------------
// STEP 2 — SCAFFOLD
// ---------------------------------------------------------------------------
function cmdScaffold(cfg, projectDir, analysis) {
  const { title, description, pkg } = analysis;
  const repoUrl = pkg.repository?.url || pkg.repository || '';
  const od = cfg.outputDir;

  console.error(`\nScaffolding Nextra app in ${od}...`);

  // package.json
  writeFile(path.join(od, 'package.json'), JSON.stringify({
    name: `${pkg.name || 'project'}-docs`,
    version: '0.1.0',
    private: true,
    scripts: { dev: 'next dev --port 3001', build: 'next build', start: 'next start' },
    dependencies: {
      next: '^14.2.0',
      nextra: '^2.13.4',
      'nextra-theme-docs': '^2.13.4',
      react: '^18.3.0',
      'react-dom': '^18.3.0',
    },
  }, null, 2));

  // next.config.mjs
  writeFile(path.join(od, 'next.config.mjs'), `import nextra from 'nextra'

const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.tsx',
  defaultShowCopyCode: true,
})

export default withNextra({
  basePath: '${cfg.baseUrl === '/' ? '' : cfg.baseUrl}',
  output: 'export',
  images: { unoptimized: true },
})
`);

  // theme.config.tsx
  writeFile(path.join(od, 'theme.config.tsx'), `import React from 'react'
import type { DocsThemeConfig } from 'nextra-theme-docs'

const config: DocsThemeConfig = {
  logo: <span style={{ fontWeight: 700 }}>${title} Docs</span>,
  ${repoUrl ? `project: { link: '${repoUrl.replace('git+', '').replace('.git', '')}' },` : ''}
  docsRepositoryBase: '${repoUrl || 'https://github.com/'}',
  useNextSeoProps() {
    return { titleTemplate: '%s – ${title} Docs' }
  },
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="description" content="${description.replace(/"/g, "'")}" />
    </>
  ),
  footer: { text: <span>Generated by doc-generator skill</span> },
}

export default config
`);

  // tsconfig.json
  writeFile(path.join(od, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'es2017', lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true, skipLibCheck: true, strict: true,
      forceConsistentCasingInFileNames: true, noEmit: true,
      esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler',
      resolveJsonModule: true, isolatedModules: true, jsx: 'preserve', incremental: true,
    },
    include: ['**/*.ts', '**/*.tsx'],
    exclude: ['node_modules'],
  }, null, 2));

  // .gitignore
  writeFile(path.join(od, '.gitignore'), `node_modules\n.next\nout\n`);

  // _app.mdx
  writeFile(path.join(od, 'pages', '_app.mdx'), `import { useEffect } from 'react'

export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />
}
`);

  // Root _meta.json
  writeFile(path.join(od, 'pages', '_meta.json'), JSON.stringify({
    index: 'Introduction',
    'getting-started': 'Getting Started',
    scripts: 'Scripts',
    api: 'API Reference',
    components: 'Components',
  }, null, 2));

  // Landing page
  writeFile(path.join(od, 'pages', 'index.mdx'), `# ${title}

${description}

## Quick Start

\`\`\`bash
${analysis.pkgManager === 'pnpm' ? 'pnpm install' : analysis.pkgManager === 'yarn' ? 'yarn' : 'npm install'}
\`\`\`

## Documentation

- [Getting Started](/getting-started) — Installation and setup
- [Scripts](/scripts) — All available npm scripts
- [API Reference](/api) — REST API endpoints
- [Components](/components) — UI component library
`);

  // Create placeholder dirs
  ['getting-started', 'scripts', 'api', 'components'].forEach(dir => {
    fs.mkdirSync(path.join(od, 'pages', dir), { recursive: true });
  });
  fs.mkdirSync(path.join(od, 'public', 'diagrams'), { recursive: true });

  console.error(`  Created Nextra app structure`);

  // Install dependencies
  const pm = detectPackageManager(od) === 'pnpm' ? 'pnpm' : analysis.pkgManager === 'yarn' ? 'yarn' : 'npm';
  const installCmd = pm === 'npm' ? 'npm install' : pm === 'yarn' ? 'yarn' : 'pnpm install';
  console.error(`  Running ${installCmd}...`);
  try {
    execSync(installCmd, { cwd: od, stdio: 'pipe' });
    console.error(`  ✓ Dependencies installed`);
  } catch (e) {
    console.error(`  ⚠ Install failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// STEP 3 — GENERATE CONTENT
// ---------------------------------------------------------------------------

// ── Getting Started ──────────────────────────────────────────────────────────
function generateGettingStarted(analysis, od) {
  const { pkg, readme, framework, pkgManager, envVars, testRunner } = analysis;
  const pm = pkgManager;
  const installCmd = pm === 'pnpm' ? 'pnpm install' : pm === 'yarn' ? 'yarn' : 'npm install';
  const devCmd = pkg.scripts?.dev ? `${pm === 'npm' ? 'npm run' : pm} dev`
    : pkg.scripts?.start ? `${pm === 'npm' ? 'npm run' : pm} start` : null;
  const testCmd = pkg.scripts?.test ? `${pm === 'npm' ? 'npm run' : pm} test` : null;
  const nodeReq = pkg.engines?.node ? `Node.js ${pkg.engines.node}` : 'Node.js 18+';

  // _meta.json
  writeFile(path.join(od, 'pages', 'getting-started', '_meta.json'), JSON.stringify({
    index: 'Overview',
    installation: 'Installation',
    configuration: 'Configuration',
  }, null, 2));

  // index.mdx
  writeFile(path.join(od, 'pages', 'getting-started', 'index.mdx'), `# Getting Started

${readme.overview || pkg.description || `Welcome to ${analysis.title}.`}

## Prerequisites

- ${nodeReq}
- ${pm === 'pnpm' ? 'pnpm' : pm === 'yarn' ? 'Yarn' : 'npm'} package manager
${envVars.filter(v => v.required === 'required').length ? `- Environment variables (see [Configuration](/getting-started/configuration))` : ''}

## Quick Start

\`\`\`bash
# Clone the repository
git clone <repo-url>
cd ${pkg.name || 'project'}

# Install dependencies
${installCmd}

${envVars.length ? `# Set up environment variables
cp .env.example .env.local\n` : ''}${devCmd ? `# Start the development server
${devCmd}` : ''}
\`\`\`
${devCmd && framework === 'nextjs' ? '\nOpen [http://localhost:3000](http://localhost:3000) in your browser.' : ''}
${testCmd ? `\n## Running Tests\n\n\`\`\`bash\n${testCmd}\n\`\`\`` : ''}
`);

  // installation.mdx
  const installationContent = readme.sections?.installation || readme.sections?.['getting started'] || '';
  writeFile(path.join(od, 'pages', 'getting-started', 'installation.mdx'), `# Installation

## Prerequisites

- ${nodeReq}
${pkg.engines ? Object.entries(pkg.engines).filter(([k]) => k !== 'node').map(([k, v]) => `- ${k} ${v}`).join('\n') : ''}

## Install

import { Tabs, Tab } from 'nextra/components'

<Tabs items={['npm', 'yarn', 'pnpm']}>
  <Tab>
    \`\`\`bash
    npm install
    \`\`\`
  </Tab>
  <Tab>
    \`\`\`bash
    yarn
    \`\`\`
  </Tab>
  <Tab>
    \`\`\`bash
    pnpm install
    \`\`\`
  </Tab>
</Tabs>
${installationContent ? `\n## Additional Steps\n\n${installationContent}` : ''}
`);

  // configuration.mdx
  const envRows = envVars.map(v =>
    `| \`${v.key}\` | ${v.required} | ${v.description || '—'} |`
  ).join('\n');

  writeFile(path.join(od, 'pages', 'getting-started', 'configuration.mdx'), `# Configuration

${envVars.length ? `## Environment Variables

Copy \`.env.example\` to \`.env.local\` and fill in the values:

\`\`\`bash
cp .env.example .env.local
\`\`\`

| Variable | Required | Description |
|---|---|---|
${envRows || '| — | — | No environment variables documented |'}
` : 'This project does not require environment variable configuration.'}

## Config Files

${framework === 'nextjs' ? '- `next.config.mjs` — Next.js configuration\n- `tsconfig.json` — TypeScript compiler options' : ''}
${framework === 'vite' ? '- `vite.config.ts` — Vite configuration' : ''}
`);
}

// ── Scripts ───────────────────────────────────────────────────────────────────
function describeScript(name, command) {
  const c = command.toLowerCase();
  if (c.includes('next build') || c.includes('vite build')) return 'Build the application for production';
  if (c.includes('next dev') || c.includes('vite dev') || c.includes('vite --watch')) return 'Start the development server with hot reload';
  if (c.includes('next start')) return 'Start the production server';
  if (c.includes('next lint') || (c.includes('eslint') && name.includes('lint'))) return 'Lint source files with ESLint';
  if (c.includes('tsc ') || c === 'tsc') return 'Type-check the project with TypeScript';
  if (c.includes('vitest')) return 'Run the test suite with Vitest';
  if (c.includes('jest')) return 'Run the test suite with Jest';
  if (c.includes('playwright')) return 'Run end-to-end tests with Playwright';
  if (c.includes('cypress')) return 'Run end-to-end tests with Cypress';
  if (c.includes('prettier')) return 'Format source files with Prettier';
  if (c.includes('prisma migrate')) return 'Run database migrations with Prisma';
  if (c.includes('prisma generate')) return 'Regenerate the Prisma client';
  if (c.includes('prisma studio')) return 'Open Prisma Studio database browser';
  if (c.includes('prisma db seed') || c.includes('prisma seed')) return 'Seed the database with initial data';
  if (c.includes('drizzle-kit push') || c.includes('drizzle-kit migrate')) return 'Push schema changes to the database';
  if (c.includes('storybook')) return 'Start Storybook component explorer';
  if (c.includes('build-storybook')) return 'Build Storybook for deployment';
  if (c.includes('docker')) return 'Manage Docker containers';
  if (name === 'prepare' || c.includes('husky')) return 'Set up Git hooks';
  return null;
}

function groupScripts(scripts) {
  const groups = {};
  Object.entries(scripts).forEach(([name, cmd]) => {
    const parts = name.split(':');
    const group = parts.length > 1 ? parts[0] : 'general';
    const label = {
      db: 'Database', test: 'Testing', build: 'Build',
      dev: 'Development', lint: 'Linting', storybook: 'Storybook',
      docker: 'Docker', general: 'General',
    }[group] || toPascalCase(group);
    if (!groups[label]) groups[label] = [];
    groups[label].push({ name, cmd });
  });
  return groups;
}

function generateScripts(analysis, od) {
  const { pkg, pkgManager: pm } = analysis;
  const scripts = pkg.scripts || {};

  const groups = groupScripts(scripts);

  const sections = Object.entries(groups).map(([groupName, items]) => {
    const itemSections = items.map(({ name, cmd }) => {
      const description = describeScript(name, cmd) || '';
      const steps = cmd.includes(' && ') ? cmd.split(' && ').map((s, i) => `${i + 1}. \`${s.trim()}\``) : null;
      return `### \`${name}\`

${description}

${steps ? `**Steps:**\n${steps.join('\n')}\n` : ''}
\`\`\`bash
${pm === 'npm' ? `npm run ${name}` : pm === 'yarn' ? `yarn ${name}` : `pnpm ${name}`}
\`\`\`

> **Command:** \`${cmd}\`
`;
    }).join('\n');
    return `## ${groupName}\n\n${itemSections}`;
  }).join('\n---\n\n');

  writeFile(path.join(od, 'pages', 'scripts', 'index.mdx'), `# Scripts

All available scripts from \`package.json\`.

${sections || '_No scripts found in package.json._'}
`);
}

// ── API ───────────────────────────────────────────────────────────────────────
function generateApi(analysis, od) {
  const { apiRoutes } = analysis;

  if (apiRoutes.length === 0) {
    writeFile(path.join(od, 'pages', 'api', 'index.mdx'), `# API Reference\n\nNo API routes were detected in this project.\n`);
    return;
  }

  // Group by path segment
  const groups = {};
  apiRoutes.forEach(route => {
    const parts = route.path.split('/').filter(Boolean);
    const group = parts[1] || 'root';
    if (!groups[group]) groups[group] = [];
    groups[group].push(route);
  });

  // _meta.json
  const meta = { index: 'Overview', ...Object.fromEntries(Object.keys(groups).map(g => [g, `/${g}`])) };
  writeFile(path.join(od, 'pages', 'api', '_meta.json'), JSON.stringify(meta, null, 2));

  // Overview page
  const allRoutes = apiRoutes.map(r => `| \`${r.method}\` | \`${r.path}\` |`).join('\n');
  writeFile(path.join(od, 'pages', 'api', 'index.mdx'), `# API Reference

This project exposes ${apiRoutes.length} API endpoint${apiRoutes.length !== 1 ? 's' : ''}.

## Endpoints

| Method | Path |
|---|---|
${allRoutes}
`);

  // Group pages
  Object.entries(groups).forEach(([group, routes]) => {
    const content = routes.map(route => {
      const fileContent = readText(route.file);
      // Try to extract JSDoc description
      const descMatch = fileContent.match(/@description\s+(.+)/);
      const description = descMatch ? descMatch[1] : `Handle \`${route.method}\` requests to \`${route.path}\`.`;

      const hasAuth = /withAuth|requireAuth|getServerSession|verifyToken|jwt\.verify|Authorization/.test(fileContent);

      return `## ${route.method} ${route.path}

${description}

${hasAuth ? '### Authentication\n\nThis endpoint requires authentication.\n' : ''}
### Example

\`\`\`bash
curl -X ${route.method} http://localhost:3000${route.path}
\`\`\`
`;
    }).join('\n---\n\n');

    writeFile(path.join(od, 'pages', 'api', `${slugify(group)}.mdx`), `# /${group}\n\n${content}`);
  });
}

// ── Components ────────────────────────────────────────────────────────────────
function generateComponents(analysis, od, components) {
  if (components.length === 0) {
    writeFile(path.join(od, 'pages', 'components', 'index.mdx'), `# Components\n\nNo React components were detected in this project.\n`);
    return;
  }

  // _meta.json
  const meta = { index: 'Overview' };
  const useIndex = components.length > 50;

  components.forEach(c => { meta[slugify(c.name)] = c.name; });
  writeFile(path.join(od, 'pages', 'components', '_meta.json'), JSON.stringify(meta, null, 2));

  // Overview
  const componentList = components.map(c =>
    `| [\`${c.name}\`](/components/${slugify(c.name)}) | ${c.description || '—'} | ${c.props.length} props |`
  ).join('\n');
  writeFile(path.join(od, 'pages', 'components', 'index.mdx'), `# Components

This project contains ${components.length} documented component${components.length !== 1 ? 's' : ''}.

| Component | Description | Props |
|---|---|---|
${componentList}
`);

  // Individual component pages
  if (!useIndex) {
    components.forEach(comp => {
      const propsTable = comp.props.length > 0
        ? `## Props\n\n| Prop | Type | Default | Required | Description |\n|---|---|---|---|---|\n${
            comp.props.map(p => `| \`${p.name}\` | \`${p.type.replace(/\|/g, '\\|')}\` | ${p.defaultValue ? `\`${p.defaultValue}\`` : '—'} | ${p.required ? 'Yes' : 'No'} | ${p.description || '—'} |`).join('\n')
          }`
        : '';

      // Generate minimal usage example
      const requiredProps = comp.props.filter(p => p.required);
      const exampleProps = requiredProps.slice(0, 3).map(p => {
        const val = p.type === 'string' ? `"value"` : p.type === 'boolean' ? `{true}` : p.type === '() => void' ? `{() => {}}` : `{/* ${p.type} */}`;
        return `  ${p.name}=${val}`;
      }).join('\n');

      writeFile(path.join(od, 'pages', 'components', `${slugify(comp.name)}.mdx`), `# ${comp.name}

${comp.description || `The \`${comp.name}\` component.`}

## Usage

\`\`\`tsx
import { ${comp.name} } from '...'

<${comp.name}${exampleProps ? `\n${exampleProps}\n` : ' '}>
  {/* children */}
</${comp.name}>
\`\`\`

${propsTable}
`);
    });
  }
}

// ---------------------------------------------------------------------------
// STEP 3 — DIAGRAMS
// ---------------------------------------------------------------------------
const NODE_COLORS = {
  client:   '#dbeafe',
  api:      '#dcfce7',
  service:  '#fef9c3',
  database: '#ffedd5',
  external: '#f3e8ff',
  state:    '#fce7f3',
  store:    '#dbeafe',
  slice:    '#dcfce7',
  action:   '#fef9c3',
  atom:     '#f3e8ff',
  context:  '#fce7f3',
};

function makeRect(id, x, y, w, h, bg = '#f9fafb') {
  return {
    id, type: 'rectangle', x, y, width: w, height: h, angle: 0,
    strokeColor: '#374151', backgroundColor: bg, fillStyle: 'solid',
    strokeWidth: 1, roughness: 0, opacity: 100, groupIds: [],
    frameId: null, roundness: { type: 3 }, seed: Math.floor(Math.random() * 1e6),
    version: 1, versionNonce: Math.floor(Math.random() * 1e6),
    isDeleted: false, boundElements: [], updated: 1, link: null, locked: false,
  };
}

function makeText(id, x, y, w, h, text, fontSize = 14) {
  return {
    id, type: 'text', x, y, width: w, height: h, angle: 0,
    strokeColor: '#1f2937', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 1, roughness: 0, opacity: 100, groupIds: [],
    frameId: null, roundness: null,
    seed: Math.floor(Math.random() * 1e6), version: 1,
    versionNonce: Math.floor(Math.random() * 1e6),
    isDeleted: false, boundElements: [], updated: 1, link: null, locked: false,
    text, fontSize, fontFamily: 1, textAlign: 'center', verticalAlign: 'middle',
    containerId: null, originalText: text, lineHeight: 1.25,
  };
}

function makeArrow(id, x1, y1, x2, y2, label, startId, endId) {
  return {
    id, type: 'arrow', x: x1, y: y1,
    width: x2 - x1, height: y2 - y1, angle: 0,
    strokeColor: '#6b7280', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 1.5, roughness: 0, opacity: 100, groupIds: [],
    frameId: null, roundness: { type: 2 },
    seed: Math.floor(Math.random() * 1e6), version: 1,
    versionNonce: Math.floor(Math.random() * 1e6),
    isDeleted: false, updated: 1, link: null, locked: false,
    points: [[0, 0], [x2 - x1, y2 - y1]],
    lastCommittedPoint: null, startBinding: startId ? { elementId: startId, focus: 0, gap: 6 } : null,
    endBinding: endId ? { elementId: endId, focus: 0, gap: 6 } : null,
    startArrowhead: null, endArrowhead: 'arrow',
    boundElements: label ? [{ type: 'text', id: `${id}-label` }] : [],
  };
}

function buildExcalidraw(elements) {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'doc-generator-skill',
    elements,
    appState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
    files: {},
  }, null, 2);
}

function layoutNodesInColumns(nodeGroups) {
  const COL_GAP = 220, ROW_GAP = 100, NODE_W = 160, NODE_H = 56;
  const elements = [];
  const nodePositions = {};

  nodeGroups.forEach((group, colIdx) => {
    group.forEach((node, rowIdx) => {
      const x = colIdx * COL_GAP + 40;
      const y = rowIdx * (NODE_H + ROW_GAP) + 60;
      const rectId = node.id;
      const textId = `${node.id}-text`;
      const color = NODE_COLORS[node.type] || '#f9fafb';

      elements.push(makeRect(rectId, x, y, NODE_W, NODE_H, color));
      elements.push(makeText(textId, x, y, NODE_W, NODE_H, node.label));
      nodePositions[node.id] = { x: x + NODE_W / 2, y: y + NODE_H / 2, rectId };
    });
  });

  return { elements, nodePositions, NODE_W, NODE_H };
}

function generateDataFlowDiagram(dataFlow, outputPath) {
  const { nodes, edges } = dataFlow;

  // Group nodes by type into columns
  const order = ['client', 'api', 'service', 'state', 'database', 'external'];
  const columns = order.map(type => nodes.filter(n => n.type === type)).filter(g => g.length > 0);
  // Add any remaining types
  const placed = new Set(columns.flat().map(n => n.id));
  const remainder = nodes.filter(n => !placed.has(n.id));
  if (remainder.length) columns.push(remainder);

  const { elements, nodePositions, NODE_W, NODE_H } = layoutNodesInColumns(columns);

  // Arrows
  edges.forEach(edge => {
    const from = nodePositions[edge.from];
    const to = nodePositions[edge.to];
    if (!from || !to) return;
    const arrowId = uuid();
    elements.push(makeArrow(
      arrowId,
      from.x, from.y, to.x, to.y,
      edge.label, from.rectId, to.rectId,
    ));
    if (edge.label) {
      elements.push(makeText(`${arrowId}-label`,
        (from.x + to.x) / 2 - 40, (from.y + to.y) / 2 - 10,
        80, 20, edge.label, 11));
    }
  });

  writeFile(outputPath, buildExcalidraw(elements));
  return { nodes: nodes.length, edges: edges.length };
}

function generateStateDiagram(stateInfo, outputPath) {
  const elements = [];
  const nodePositions = {};
  const COL_GAP = 200, ROW_GAP = 90, NODE_W = 160, NODE_H = 52;

  const allNodes = [
    { id: 'store-root', label: 'State Store', type: 'store', x: 0, y: 0 },
    ...stateInfo.slices.map((s, i) => ({
      id: `slice-${i}`, label: s.name, type: 'slice',
      x: 1, y: i,
      actions: s.actions,
    })),
    ...stateInfo.stores.map((s, i) => ({
      id: `zustand-${i}`, label: s.name, type: 'store',
      x: 1, y: stateInfo.slices.length + i,
    })),
    ...stateInfo.atoms.slice(0, 6).map((a, i) => ({
      id: `atom-${i}`, label: a.name, type: 'atom',
      x: 1, y: stateInfo.slices.length + stateInfo.stores.length + i,
    })),
    ...stateInfo.contexts.slice(0, 4).map((c, i) => ({
      id: `ctx-${i}`, label: c.name, type: 'context',
      x: 1, y: stateInfo.slices.length + stateInfo.stores.length + stateInfo.atoms.length + i,
    })),
  ];

  // Add action nodes for slices
  const actionNodes = [];
  stateInfo.slices.forEach((s, si) => {
    s.actions.slice(0, 3).forEach((action, ai) => {
      actionNodes.push({
        id: `action-${si}-${ai}`, label: action, type: 'action',
        sliceIdx: si, actionIdx: ai,
      });
    });
  });

  // Layout
  allNodes.forEach(node => {
    const x = node.x * COL_GAP + 40;
    const y = node.y * (NODE_H + ROW_GAP) + 60;
    const color = NODE_COLORS[node.type] || '#f9fafb';
    elements.push(makeRect(node.id, x, y, NODE_W, NODE_H, color));
    elements.push(makeText(`${node.id}-text`, x, y, NODE_W, NODE_H, node.label));
    nodePositions[node.id] = { x: x + NODE_W / 2, y: y + NODE_H / 2, rectId: node.id };
  });

  actionNodes.forEach((node, i) => {
    const x = 2 * COL_GAP + 40;
    const y = node.sliceIdx * (NODE_H + ROW_GAP) + node.actionIdx * 30 + 60;
    const color = NODE_COLORS.action;
    elements.push(makeRect(node.id, x, y, 140, 36, color));
    elements.push(makeText(`${node.id}-text`, x, y, 140, 36, node.label, 12));
    nodePositions[node.id] = { x: x + 70, y: y + 18, rectId: node.id };
  });

  // Edges: root → slices/stores, slices → actions
  const root = nodePositions['store-root'];
  [...stateInfo.slices.map((_, i) => `slice-${i}`),
   ...stateInfo.stores.map((_, i) => `zustand-${i}`),
   ...stateInfo.atoms.slice(0, 6).map((_, i) => `atom-${i}`),
   ...stateInfo.contexts.slice(0, 4).map((_, i) => `ctx-${i}`),
  ].forEach(targetId => {
    const to = nodePositions[targetId];
    if (!root || !to) return;
    elements.push(makeArrow(uuid(), root.x, root.y, to.x, to.y, '', root.rectId, to.rectId));
  });

  stateInfo.slices.forEach((s, si) => {
    const slicePos = nodePositions[`slice-${si}`];
    s.actions.slice(0, 3).forEach((_, ai) => {
      const actionPos = nodePositions[`action-${si}-${ai}`];
      if (!slicePos || !actionPos) return;
      elements.push(makeArrow(uuid(), slicePos.x, slicePos.y, actionPos.x, actionPos.y, '', `slice-${si}`, `action-${si}-${ai}`));
    });
  });

  writeFile(outputPath, buildExcalidraw(elements));
  return { nodes: allNodes.length + actionNodes.length, edges: elements.filter(e => e.type === 'arrow').length };
}

function cmdGenerate(cfg, projectDir, analysis) {
  const od = cfg.outputDir;
  const components = sectionEnabled(cfg, 'components')
    ? analyzeComponents(projectDir, cfg) : [];

  if (sectionEnabled(cfg, 'getting-started')) {
    console.error('  Generating: Getting Started...');
    generateGettingStarted(analysis, od);
  }

  if (sectionEnabled(cfg, 'scripts')) {
    console.error('  Generating: Scripts...');
    generateScripts(analysis, od);
  }

  if (sectionEnabled(cfg, 'api')) {
    console.error('  Generating: API Reference...');
    generateApi(analysis, od);
  }

  if (sectionEnabled(cfg, 'components')) {
    console.error(`  Generating: Components (${components.length} found)...`);
    generateComponents(analysis, od, components);
  }

  if (sectionEnabled(cfg, 'diagrams')) {
    console.error('  Generating: Diagrams...');

    const dataFlow = analyzeDataFlow(projectDir, analysis.apiRoutes);
    const dataFlowStats = generateDataFlowDiagram(
      dataFlow,
      path.join(od, 'public', 'diagrams', 'data-flow.excalidraw'),
    );

    const stateInfo = analyzeStateManagement(projectDir, analysis.stateLibs);
    const hasStateInfo = stateInfo.slices.length || stateInfo.stores.length ||
      stateInfo.atoms.length || stateInfo.contexts.length;

    if (hasStateInfo) {
      const stateStats = generateStateDiagram(
        stateInfo,
        path.join(od, 'public', 'diagrams', 'state-management.excalidraw'),
      );
      console.error(`    state-management.excalidraw (${stateStats.nodes} nodes, ${stateStats.edges} arrows)`);
    }
    console.error(`    data-flow.excalidraw (${dataFlowStats.nodes} nodes, ${dataFlowStats.edges} arrows)`);
  }

  return components;
}

// ---------------------------------------------------------------------------
// STEP 4 — VALIDATE
// ---------------------------------------------------------------------------
function cmdValidate(cfg) {
  const od = cfg.outputDir;
  console.error('\nValidating docs build...');

  if (!fs.existsSync(path.join(od, 'node_modules'))) {
    console.error('  ⚠  node_modules missing — run npm install in _docs/');
    return false;
  }

  const result = spawnSync('npm', ['run', 'build'], { cwd: od, encoding: 'utf8' });
  if (result.status === 0) {
    console.log('  ✓ next build passed');
    return true;
  }
  console.error('  ✗ next build failed:');
  const output = (result.stdout || '') + (result.stderr || '');
  console.error(output.split('\n').slice(0, 30).join('\n'));
  return false;
}

// ---------------------------------------------------------------------------
// FULL PIPELINE
// ---------------------------------------------------------------------------
function cmdRun(cfg, projectDir, dryRun) {
  console.error('─'.repeat(50));
  console.error('Step 1 — Analyse');
  const analysis = cmdAnalyze(cfg, projectDir);

  if (dryRun || cfg.dryRun) {
    console.log('\ndryRun=true — no files written.');
    return;
  }

  // Check for existing _docs
  if (fs.existsSync(cfg.outputDir)) {
    console.error(`\n⚠  ${cfg.outputDir} already exists.`);
    console.error('   Overwriting existing files. Pass --output-dir to choose a different path.');
  }

  console.error('\n' + '─'.repeat(50));
  console.error('Step 2 — Scaffold Nextra app');
  cmdScaffold(cfg, projectDir, analysis);

  console.error('\n' + '─'.repeat(50));
  console.error('Step 3 — Generate content');
  const components = cmdGenerate(cfg, projectDir, analysis);

  console.error('\n' + '─'.repeat(50));
  console.error('Step 4 — Validate');
  cmdValidate(cfg);

  // Report
  const od = cfg.outputDir;
  console.log(`
${'─'.repeat(50)}
Documentation generated → ${path.relative(process.cwd(), od)}

Pages:
  getting-started/    3 pages
  scripts/            1 page   (${Object.keys(analysis.pkg.scripts || {}).length} scripts)
  api/                ${new Set(analysis.apiRoutes.map(r => r.path.split('/')[2])).size + 1} pages  (${analysis.apiRoutes.length} endpoints)
  components/         ${components.length} pages

Diagrams:
  data-flow.excalidraw
  ${analysis.stateLibs.length ? 'state-management.excalidraw' : '(no state management detected)'}

Start dev server:
  cd ${path.relative(process.cwd(), od)} && npm run dev
  → http://localhost:3001
`);
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
Usage: node generator.js --mode <mode> [options]

Modes:
  analyze     Scan repo and write .doc-generator/analysis.json
  scaffold    Create _docs/ Nextra app skeleton
  generate    Generate all MDX pages and diagrams
  validate    Run next build to check for errors
  run         Full pipeline (analyze → scaffold → generate → validate)

Options:
  --project-dir <path>   Root of the project to document (default: .)
  --config <path>        Path to doc-generator.config.json
  --output-dir <path>    Override output directory (default: _docs)
  --dry-run              Analyse only, no writes
  --help                 Show this help
`);
    process.exit(0);
  }

  const mode = args.mode;
  if (!mode) {
    console.error('Error: --mode is required. Use --help for usage.');
    process.exit(1);
  }

  const projectDir = path.resolve(args.projectDir || args['project-dir'] || '.');
  const cfg = loadConfig(args.config, projectDir);
  if (args.outputDir || args['output-dir']) {
    cfg.outputDir = path.resolve(args.outputDir || args['output-dir']);
  }
  if (args.dryRun || args['dry-run']) cfg.dryRun = true;

  switch (mode) {
    case 'analyze':
      cmdAnalyze(cfg, projectDir);
      break;
    case 'scaffold': {
      const analysis = cmdAnalyze(cfg, projectDir);
      cmdScaffold(cfg, projectDir, analysis);
      break;
    }
    case 'generate': {
      const analysisPath = path.join(projectDir, '.doc-generator', 'analysis.json');
      const analysis = fs.existsSync(analysisPath)
        ? JSON.parse(fs.readFileSync(analysisPath, 'utf8'))
        : cmdAnalyze(cfg, projectDir);
      cmdGenerate(cfg, projectDir, analysis);
      break;
    }
    case 'validate':
      cmdValidate(cfg);
      break;
    case 'run':
      cmdRun(cfg, projectDir, cfg.dryRun);
      break;
    default:
      console.error(`Unknown mode: ${mode}`);
      process.exit(1);
  }
}

main();
