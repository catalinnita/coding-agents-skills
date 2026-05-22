#!/usr/bin/env node
'use strict';

/**
 * TypeScript type cleaner — modes: analyze | transform | validate | report | run
 * Requires: ts-morph  (auto-installed on first run)
 */

// ---------------------------------------------------------------------------
// Bootstrap — auto-install ts-morph if missing
// ---------------------------------------------------------------------------
const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function ensureDep(name) {
  try { require.resolve(name); return; } catch (_) {}
  console.error(`Installing ${name}...`);
  execSync(`npm install ${name}`, { cwd: __dirname, stdio: 'inherit' });
}
ensureDep('ts-morph');

const {
  Project, SyntaxKind, IndentationText, NewLineKind, QuoteKind,
} = require('ts-morph');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULTS = {
  target: '.',
  rules: 'all',
  exclude: ['node_modules', 'dist', 'build', '.git', 'coverage'],
  extensions: ['.ts', '.tsx'],
  dryRun: false,
  threshold: 0.8,
  enumStyle: 'enum',
  preferInterface: true,
  sortMembers: false,
  sortUnionMembers: false,
  anyPolicy: 'flag',
  report: true,
  reportPath: 'type-cleaner-report.md',
  rules_config: {},
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig(configPath, projectDir) {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));

  // Auto-discover config file
  let cfgFile = configPath ? path.resolve(configPath) : null;
  if (!cfgFile) {
    let dir = projectDir;
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'type-cleaner.config.json');
      if (fs.existsSync(candidate)) { cfgFile = candidate; break; }
      // Stop at git root
      if (fs.existsSync(path.join(dir, '.git'))) break;
      dir = path.dirname(dir);
    }
  }
  if (cfgFile && fs.existsSync(cfgFile) && fs.statSync(cfgFile).size > 0) {
    const user = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    Object.assign(cfg, user);
    cfg.rules_config = Object.assign({}, DEFAULTS.rules_config, user.rules_config || {});
  }
  return cfg;
}

function isRuleEnabled(cfg, ruleId) {
  if (Array.isArray(cfg.rules) && !cfg.rules.includes(ruleId)) return false;
  const rc = cfg.rules_config[ruleId];
  if (rc && rc.enabled === false) return false;
  return true;
}

function ruleOpt(cfg, ruleId, key, fallback) {
  const rc = cfg.rules_config[ruleId] || {};
  return key in rc ? rc[key] : fallback;
}

// ---------------------------------------------------------------------------
// Project setup
// ---------------------------------------------------------------------------
function buildProject(cfg, projectDir) {
  const tsConfigPath = path.join(projectDir, 'tsconfig.json');
  const projectOpts = fs.existsSync(tsConfigPath)
    ? { tsConfigFilePath: tsConfigPath, skipAddingFilesFromTsConfig: false }
    : { compilerOptions: { strict: true, target: 99, module: 99 } };

  const project = new Project({
    ...projectOpts,
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
      newLineKind: NewLineKind.LineFeed,
      quoteKind: QuoteKind.Single,
      usePrefixAndSuffixTextForRename: false,
    },
  });

  const exts = cfg.extensions;
  const excludes = cfg.exclude.map(e => path.join(projectDir, e));

  if (!fs.existsSync(tsConfigPath)) {
    const globs = exts.map(ext => path.join(projectDir, '**', `*${ext}`));
    project.addSourceFilesAtPaths(globs);
  }

  // Remove excluded files
  project.getSourceFiles().forEach(sf => {
    const fp = sf.getFilePath();
    if (excludes.some(ex => fp.startsWith(ex))) {
      project.removeSourceFile(sf);
    }
  });

  return project;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SK = SyntaxKind;

function isDeclarationFile(sf) {
  return sf.getFilePath().endsWith('.d.ts');
}

function getLineNumber(node) {
  return node.getStartLineNumber();
}

function relPath(filePath, projectDir) {
  return path.relative(projectDir, filePath);
}

function toPascalCase(str) {
  return str
    .replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, c => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Findings accumulator
// ---------------------------------------------------------------------------
function makeFinding(rule, sf, node, description, before, after, autoApply = true) {
  return {
    rule,
    file: sf.getFilePath(),
    line: node ? getLineNumber(node) : 0,
    description,
    before: before || '',
    after: after || '',
    autoApply,
  };
}

// ---------------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------------

// ── merge-declarations ──────────────────────────────────────────────────────
function ruleMergeDeclarations(sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const findings = [];
  const groups = new Map();

  sf.getInterfaces().forEach(iface => {
    const name = iface.getName();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(iface);
  });

  for (const [name, ifaces] of groups) {
    if (ifaces.length < 2) continue;
    // Skip module augmentations
    if (ifaces.some(i => i.getParent().getKind() === SK.ModuleDeclaration)) continue;

    const [first, ...rest] = ifaces;
    const allMembers = rest.flatMap(i => i.getMembers().map(m => m.getText()));
    const description = `Merge ${ifaces.length} declarations of interface '${name}'`;
    findings.push(makeFinding('merge-declarations', sf, first, description,
      rest.map(i => i.getText()).join('\n'), '(merged into first declaration)'));

    if (mode === 'transform') {
      allMembers.forEach(memberText => {
        first.addMember(memberText);
      });
      rest.forEach(i => i.remove());
    }
  }
  return findings;
}

// ── dedup-identical (within-file) ───────────────────────────────────────────
function ruleDedupIdentical(sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const findings = [];
  const fingerprints = new Map();

  const collectType = (name, typeText, node) => {
    const key = typeText.replace(/\s+/g, ' ').trim();
    if (fingerprints.has(key)) {
      const orig = fingerprints.get(key);
      findings.push(makeFinding('dedup-identical', sf, node,
        `'${name}' is structurally identical to '${orig.name}' — remove duplicate`,
        node.getText(), `// use ${orig.name}`));
      if (mode === 'transform') {
        node.remove();
      }
    } else {
      fingerprints.set(key, { name, node });
    }
  };

  sf.getTypeAliases().forEach(ta => {
    collectType(ta.getName(), ta.getTypeNode()?.getText() || '', ta);
  });
  sf.getInterfaces().forEach(iface => {
    const body = iface.getMembers().map(m => m.getText()).sort().join(';');
    collectType(iface.getName(), `{${body}}`, iface);
  });

  return findings;
}

// ── dedup-imports ────────────────────────────────────────────────────────────
function ruleDedupImports(sf, cfg, mode) {
  const findings = [];
  const byModule = new Map();

  sf.getImportDeclarations().forEach(imp => {
    const mod = imp.getModuleSpecifierValue();
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod).push(imp);
  });

  for (const [mod, imps] of byModule) {
    if (imps.length < 2) continue;
    const [first, ...rest] = imps;
    const allNamed = imps.flatMap(i => i.getNamedImports().map(n => n.getText()));
    const unique = [...new Set(allNamed)].sort();
    const isTypeOnly = imps.some(i => i.isTypeOnly());
    const description = `Merge ${imps.length} imports from '${mod}'`;
    findings.push(makeFinding('dedup-imports', sf, first, description,
      rest.map(i => i.getText()).join('\n'), `(merged into first import)`));

    if (mode === 'transform') {
      first.removeNamedImports();
      unique.forEach(n => first.addNamedImport(n));
      if (isTypeOnly) first.setIsTypeOnly(true);
      rest.forEach(i => i.remove());
    }
  }
  return findings;
}

// ── remove-optional-undefined ────────────────────────────────────────────────
function ruleRemoveOptionalUndefined(sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const findings = [];
  const nodes = [];

  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.PropertySignature) return;
    if (!node.hasQuestionToken()) return;
    const typeNode = node.getTypeNode();
    if (!typeNode || typeNode.getKind() !== SK.UnionType) return;
    const members = typeNode.getTypeNodes();
    const withoutUndef = members.filter(m => m.getKind() !== SK.UndefinedKeyword);
    if (withoutUndef.length === members.length) return;
    nodes.push({ node, typeNode, members, withoutUndef });
  });

  nodes.forEach(({ node, typeNode, withoutUndef }) => {
    const before = node.getText();
    const newType = withoutUndef.length === 1
      ? withoutUndef[0].getText()
      : withoutUndef.map(t => t.getText()).join(' | ');
    findings.push(makeFinding('remove-optional-undefined', sf, node,
      `Remove '| undefined' from optional property`,
      before, before.replace(typeNode.getText(), newType)));
    if (mode === 'transform') {
      typeNode.replaceWithText(newType);
    }
  });
  return findings;
}

// ── remove-never-union ───────────────────────────────────────────────────────
function ruleRemoveNeverUnion(sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const findings = [];

  const collect = [];
  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.UnionType) return;
    const members = node.getTypeNodes();
    const filtered = members.filter(m => m.getKind() !== SK.NeverKeyword);
    if (filtered.length === members.length) return;
    if (filtered.length === 0) return;
    collect.push({ node, filtered });
  });

  collect.forEach(({ node, filtered }) => {
    const before = node.getText();
    const after = filtered.length === 1
      ? filtered[0].getText()
      : filtered.map(t => t.getText()).join(' | ');
    findings.push(makeFinding('remove-never-union', sf, node,
      `Remove 'never' from union type`, before, after));
    if (mode === 'transform') {
      node.replaceWithText(after);
    }
  });
  return findings;
}

// ── remove-unknown-intersection ──────────────────────────────────────────────
function ruleRemoveUnknownIntersection(sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const findings = [];
  const collect = [];

  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.IntersectionType) return;
    const members = node.getTypeNodes();
    const filtered = members.filter(m => m.getKind() !== SK.UnknownKeyword);
    if (filtered.length === members.length) return;
    if (filtered.length === 0) return;
    collect.push({ node, filtered });
  });

  collect.forEach(({ node, filtered }) => {
    const before = node.getText();
    const after = filtered.length === 1
      ? filtered[0].getText()
      : filtered.map(t => t.getText()).join(' & ');
    findings.push(makeFinding('remove-unknown-intersection', sf, node,
      `Remove 'unknown' from intersection type`, before, after));
    if (mode === 'transform') {
      node.replaceWithText(after);
    }
  });
  return findings;
}

// ── remove-duplicate-union-members ───────────────────────────────────────────
function ruleDedupUnionMembers(sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const findings = [];
  const collect = [];

  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.UnionType) return;
    const members = node.getTypeNodes();
    const seen = new Set();
    const deduped = members.filter(m => {
      const key = m.getText().replace(/\s+/g, '');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    if (deduped.length === members.length) return;
    collect.push({ node, deduped });
  });

  collect.forEach(({ node, deduped }) => {
    const before = node.getText();
    const after = deduped.map(t => t.getText()).join(' | ');
    findings.push(makeFinding('remove-duplicate-union-members', sf, node,
      `Remove duplicate members from union type`, before, after));
    if (mode === 'transform') {
      node.replaceWithText(after);
    }
  });
  return findings;
}

// ── flatten-nested-unions ─────────────────────────────────────────────────────
function ruleFlattenNestedUnions(sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const findings = [];
  const collect = [];

  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.UnionType) return;
    const members = node.getTypeNodes();
    const hasNested = members.some(m => m.getKind() === SK.UnionType ||
      (m.getKind() === SK.ParenthesizedType &&
       m.getTypeNode()?.getKind() === SK.UnionType));
    if (!hasNested) return;
    collect.push({ node, members });
  });

  collect.forEach(({ node, members }) => {
    const flattened = members.flatMap(m => {
      if (m.getKind() === SK.UnionType) {
        return m.getTypeNodes().map(t => t.getText());
      }
      if (m.getKind() === SK.ParenthesizedType &&
          m.getTypeNode()?.getKind() === SK.UnionType) {
        return m.getTypeNode().getTypeNodes().map(t => t.getText());
      }
      return [m.getText()];
    });
    const before = node.getText();
    const after = [...new Set(flattened)].join(' | ');
    findings.push(makeFinding('flatten-nested-unions', sf, node,
      `Flatten nested union type`, before, after));
    if (mode === 'transform') {
      node.replaceWithText(after);
    }
  });
  return findings;
}

// ── remove-noop-utility ───────────────────────────────────────────────────────
function ruleRemoveNoopUtility(sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const findings = [];
  const collect = [];

  const IDEMPOTENT = new Set(['Required', 'Readonly', 'Partial', 'NonNullable']);

  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.TypeReference) return;
    const name = node.getTypeName().getText();
    const typeArgs = node.getTypeArguments();

    // Required<Required<T>> etc.
    if (IDEMPOTENT.has(name) && typeArgs.length === 1) {
      const inner = typeArgs[0];
      if (inner.getKind() === SK.TypeReference &&
          inner.getTypeName().getText() === name) {
        collect.push({ node, replacement: node.getText().slice(name.length + 1, -1) });
        return;
      }
    }

    // Omit<T, never>
    if (name === 'Omit' && typeArgs.length === 2) {
      if (typeArgs[1].getKind() === SK.NeverKeyword) {
        collect.push({ node, replacement: typeArgs[0].getText() });
        return;
      }
    }
  });

  collect.forEach(({ node, replacement }) => {
    const before = node.getText();
    findings.push(makeFinding('remove-noop-utility', sf, node,
      `Remove no-op utility type`, before, replacement));
    if (mode === 'transform') {
      node.replaceWithText(replacement);
    }
  });
  return findings;
}

// ── remove-wrapper-types ──────────────────────────────────────────────────────
const WRAPPER_MAP = { Boolean: 'boolean', Number: 'number', String: 'string' };

function ruleRemoveWrapperTypes(sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const findings = [];
  const collect = [];

  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.TypeReference) return;
    const name = node.getTypeName().getText();
    if (!(name in WRAPPER_MAP)) return;
    if (node.getTypeArguments().length > 0) return;
    collect.push({ node, name });
  });

  collect.forEach(({ node, name }) => {
    const replacement = WRAPPER_MAP[name];
    findings.push(makeFinding('remove-wrapper-types', sf, node,
      `Replace wrapper type '${name}' with primitive '${replacement}'`,
      name, replacement));
    if (mode === 'transform') {
      node.replaceWithText(replacement);
    }
  });
  return findings;
}

// ── normalise-interface-type ──────────────────────────────────────────────────
function ruleNormaliseInterfaceType(sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const preferInterface = cfg.preferInterface !== false;
  if (!preferInterface) return []; // type→interface only for now
  const findings = [];
  const collect = [];

  sf.getTypeAliases().forEach(ta => {
    const typeNode = ta.getTypeNode();
    if (!typeNode) return;
    const kind = typeNode.getKind();
    // Only plain object literals — not mapped, conditional, union, intersection
    if (kind !== SK.TypeLiteral) return;
    const name = ta.getName();
    const typeParams = ta.getTypeParameters().map(p => p.getText()).join(', ');
    const members = typeNode.getMembers().map(m => m.getText());
    const body = members.join(';\n  ');
    const typeParamStr = typeParams ? `<${typeParams}>` : '';
    collect.push({ ta, name, typeParamStr, body });
  });

  collect.forEach(({ ta, name, typeParamStr, body }) => {
    const before = ta.getText();
    const after = `interface ${name}${typeParamStr} {\n  ${body}\n}`;
    findings.push(makeFinding('normalise-interface-type', sf, ta,
      `Convert type alias '${name}' to interface`, before, after));
    if (mode === 'transform') {
      ta.replaceWithText(after);
    }
  });
  return findings;
}

// ── normalise-array-type ──────────────────────────────────────────────────────
function ruleNormaliseArrayType(sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const findings = [];
  const collect = [];

  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.TypeReference) return;
    const name = node.getTypeName().getText();
    if (name !== 'Array') return;
    const args = node.getTypeArguments();
    if (args.length !== 1) return;
    const inner = args[0].getText();
    // Use shorthand only for simple types (no spaces, no angle brackets in the inner type)
    const isSimple = !inner.includes(' ') && !inner.includes('<') && !inner.includes('|');
    if (!isSimple) return;
    collect.push({ node, inner });
  });

  collect.forEach(({ node, inner }) => {
    const before = node.getText();
    const after = `${inner}[]`;
    findings.push(makeFinding('normalise-array-type', sf, node,
      `Convert Array<${inner}> to ${inner}[]`, before, after));
    if (mode === 'transform') {
      node.replaceWithText(after);
    }
  });
  return findings;
}

// ── extract-enum ──────────────────────────────────────────────────────────────
function ruleExtractEnum(project, sf, cfg, mode) {
  if (isDeclarationFile(sf)) return [];
  const enumStyle = cfg.enumStyle || 'enum';
  if (enumStyle === 'string-union') return [];
  const minMembers = ruleOpt(cfg, 'extract-enum', 'minMembers', 3);
  const findings = [];

  sf.getTypeAliases().forEach(ta => {
    const typeNode = ta.getTypeNode();
    if (!typeNode || typeNode.getKind() !== SK.UnionType) return;
    const members = typeNode.getTypeNodes();
    if (members.length < minMembers) return;

    // All members must be string literals
    const literals = members.map(m => {
      if (m.getKind() === SK.LiteralType) {
        const lit = m.getLiteral();
        if (lit.getKind() === SK.StringLiteral) {
          return lit.getLiteralValue();
        }
      }
      return null;
    });
    if (literals.some(l => l === null)) return;

    const name = ta.getName();
    const keyword = enumStyle === 'const-enum' ? 'const enum' : 'enum';
    const enumMembers = literals.map(l => {
      const memberName = toPascalCase(l);
      return `  ${memberName} = '${l}'`;
    }).join(',\n');
    const enumText = `${keyword} ${name} {\n${enumMembers}\n}`;

    findings.push(makeFinding('extract-enum', sf, ta,
      `Convert string union '${name}' to ${keyword}`,
      ta.getText(), enumText, false)); // requireConfirmation

    if (mode === 'transform') {
      ta.replaceWithText(enumText);
    }
  });
  return findings;
}

// ── remove-unused-types ───────────────────────────────────────────────────────
function ruleRemoveUnusedTypes(project, cfg, mode) {
  const findings = [];

  // Build reference set: all identifiers used across the project
  const usedNames = new Set();
  project.getSourceFiles().forEach(sf => {
    sf.getImportDeclarations().forEach(imp => {
      imp.getNamedImports().forEach(n => usedNames.add(n.getName()));
    });
    // Collect all type references
    sf.forEachDescendant(node => {
      if (node.getKind() === SK.TypeReference) {
        usedNames.add(node.getTypeName().getText());
      }
      if (node.getKind() === SK.Identifier) {
        usedNames.add(node.getText());
      }
    });
  });

  project.getSourceFiles().forEach(sf => {
    if (isDeclarationFile(sf)) return;
    // Skip barrel files (files that only re-export)
    const stmts = sf.getStatements();
    const isBarrel = stmts.length > 0 && stmts.every(s =>
      s.getKind() === SK.ExportDeclaration || s.getKind() === SK.ImportDeclaration);
    if (isBarrel) return;

    const collect = [];

    sf.getTypeAliases().forEach(ta => {
      const name = ta.getName();
      // Check if anything other than its own declaration uses this name
      let refCount = 0;
      project.getSourceFiles().forEach(other => {
        other.forEachDescendant(n => {
          if (n.getKind() === SK.TypeReference &&
              n.getTypeName().getText() === name &&
              n !== ta.getTypeNode()) {
            refCount++;
          }
        });
      });
      if (refCount === 0) collect.push({ node: ta, name });
    });

    sf.getInterfaces().forEach(iface => {
      const name = iface.getName();
      let refCount = 0;
      project.getSourceFiles().forEach(other => {
        other.forEachDescendant(n => {
          if (n.getKind() === SK.TypeReference &&
              n.getTypeName().getText() === name) refCount++;
          if (n.getKind() === SK.HeritageClause) {
            n.getTypeNodes().forEach(t => {
              if (t.getExpression().getText() === name) refCount++;
            });
          }
        });
      });
      if (refCount === 0) collect.push({ node: iface, name });
    });

    collect.forEach(({ node, name }) => {
      findings.push(makeFinding('remove-unused-types', sf, node,
        `Remove unused type '${name}'`, node.getText(), ''));
      if (mode === 'transform') node.remove();
    });
  });

  return findings;
}

// ── remove-unused-imports ─────────────────────────────────────────────────────
function ruleRemoveUnusedImports(sf, cfg, mode) {
  const findings = [];

  // Collect all non-import identifiers used in this file
  const used = new Set();
  sf.forEachDescendant(node => {
    if (node.getKind() === SK.ImportDeclaration) return;
    if (node.getKind() === SK.Identifier) used.add(node.getText());
    if (node.getKind() === SK.TypeReference) used.add(node.getTypeName().getText());
  });

  sf.getImportDeclarations().forEach(imp => {
    const toRemove = imp.getNamedImports().filter(n => !used.has(n.getName()));
    if (toRemove.length === 0) return;
    toRemove.forEach(n => {
      findings.push(makeFinding('remove-unused-imports', sf, imp,
        `Remove unused import '${n.getName()}'`,
        n.getText(), ''));
      if (mode === 'transform') n.remove();
    });
    // Remove empty import declaration
    if (mode === 'transform' && imp.getNamedImports().length === 0 &&
        !imp.getDefaultImport() && !imp.getNamespaceImport()) {
      imp.remove();
    }
  });

  return findings;
}

// ── flag-any ───────────────────────────────────────────────────────────────────
function ruleFlagAny(sf, cfg) {
  const skipGenericConstraints = ruleOpt(cfg, 'flag-any', 'skipGenericConstraints', true);
  const policy = cfg.anyPolicy || 'flag';
  const flags = [];

  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.AnyKeyword) return;
    // Skip generic constraints: T extends any
    if (skipGenericConstraints) {
      const parent = node.getParent();
      if (parent && parent.getKind() === SK.TypeParameter) return;
    }
    flags.push({
      rule: 'flag-any',
      file: sf.getFilePath(),
      line: getLineNumber(node),
      description: policy === 'replace-unknown'
        ? `Replace 'any' with 'unknown'`
        : `Found 'any' — consider using 'unknown' or a specific type`,
      context: node.getParent()?.getText().slice(0, 80) || '',
    });
  });

  return flags;
}

// ── flag-object-type ──────────────────────────────────────────────────────────
function ruleFlagObjectType(sf) {
  const flags = [];
  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.ObjectKeyword) return;
    flags.push({
      rule: 'flag-object-type',
      file: sf.getFilePath(),
      line: getLineNumber(node),
      description: `Found 'object' type — too broad, prefer a specific shape`,
      context: node.getParent()?.getText().slice(0, 80) || '',
    });
  });
  return flags;
}

// ── sort-imports ───────────────────────────────────────────────────────────────
function ruleSortImports(sf, cfg, mode) {
  const findings = [];

  sf.getImportDeclarations().forEach(imp => {
    const named = imp.getNamedImports();
    if (named.length < 2) return;
    const sorted = [...named].sort((a, b) => a.getName().localeCompare(b.getName()));
    const isSorted = named.every((n, i) => n.getName() === sorted[i].getName());
    if (isSorted) return;

    const before = `{ ${named.map(n => n.getText()).join(', ')} }`;
    const after = `{ ${sorted.map(n => n.getText()).join(', ')} }`;
    findings.push(makeFinding('sort-imports', sf, imp,
      `Sort named imports alphabetically`, before, after));

    if (mode === 'transform') {
      const texts = sorted.map(n => n.getText());
      imp.removeNamedImports();
      texts.forEach(t => imp.addNamedImport(t));
    }
  });
  return findings;
}

// ── sort-members ───────────────────────────────────────────────────────────────
function ruleSortMembers(sf, cfg, mode) {
  if (!cfg.sortMembers) return [];
  if (isDeclarationFile(sf)) return [];
  const requiredFirst = ruleOpt(cfg, 'sort-members', 'requiredFirst', true);
  const findings = [];

  const sortProps = (members) => {
    return [...members].sort((a, b) => {
      const aOpt = a.hasQuestionToken?.() ?? false;
      const bOpt = b.hasQuestionToken?.() ?? false;
      if (requiredFirst && aOpt !== bOpt) return aOpt ? 1 : -1;
      const aName = a.getName?.() ?? a.getText();
      const bName = b.getName?.() ?? b.getText();
      return aName.localeCompare(bName);
    });
  };

  sf.getInterfaces().forEach(iface => {
    const members = iface.getProperties();
    if (members.length < 2) return;
    const sorted = sortProps(members);
    const isSorted = members.every((m, i) =>
      (m.getName?.() ?? '') === (sorted[i].getName?.() ?? ''));
    if (isSorted) return;
    findings.push(makeFinding('sort-members', sf, iface,
      `Sort members of interface '${iface.getName()}' alphabetically`,
      members.map(m => m.getName()).join(', '),
      sorted.map(m => m.getName()).join(', ')));
    if (mode === 'transform') {
      const texts = sorted.map(m => m.getText());
      iface.getProperties().forEach((m, i) => m.replaceWithText(texts[i]));
    }
  });

  return findings;
}

// ── sort-union-members ────────────────────────────────────────────────────────
function ruleSortUnionMembers(sf, cfg, mode) {
  if (!cfg.sortUnionMembers) return [];
  if (isDeclarationFile(sf)) return [];
  const PRIMITIVE_ORDER = ['null', 'undefined', 'boolean', 'number', 'string'];
  const findings = [];
  const collect = [];

  sf.forEachDescendant(node => {
    if (node.getKind() !== SK.UnionType) return;
    const members = node.getTypeNodes();
    if (members.length < 2) return;

    const sorted = [...members].sort((a, b) => {
      const at = a.getText();
      const bt = b.getText();
      const ai = PRIMITIVE_ORDER.indexOf(at);
      const bi = PRIMITIVE_ORDER.indexOf(bt);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return at.localeCompare(bt);
    });
    const isSorted = members.every((m, i) => m.getText() === sorted[i].getText());
    if (isSorted) return;
    collect.push({ node, sorted });
  });

  collect.forEach(({ node, sorted }) => {
    const before = node.getText();
    const after = sorted.map(t => t.getText()).join(' | ');
    findings.push(makeFinding('sort-union-members', sf, node,
      `Sort union members`, before, after));
    if (mode === 'transform') node.replaceWithText(after);
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
const RULE_PIPELINE = [
  // Stage 1 — consolidate declarations
  (project, sf, cfg, mode) => ruleMergeDeclarations(sf, cfg, mode),
  // Stage 2 — dedup exact
  (project, sf, cfg, mode) => ruleDedupIdentical(sf, cfg, mode),
  // Stage 3 — redundancy removal
  (project, sf, cfg, mode) => ruleRemoveOptionalUndefined(sf, cfg, mode),
  (project, sf, cfg, mode) => ruleRemoveNeverUnion(sf, cfg, mode),
  (project, sf, cfg, mode) => ruleRemoveUnknownIntersection(sf, cfg, mode),
  (project, sf, cfg, mode) => ruleDedupUnionMembers(sf, cfg, mode),
  (project, sf, cfg, mode) => ruleFlattenNestedUnions(sf, cfg, mode),
  // Stage 4 — substitutions
  (project, sf, cfg, mode) => ruleRemoveNoopUtility(sf, cfg, mode),
  (project, sf, cfg, mode) => ruleRemoveWrapperTypes(sf, cfg, mode),
  // Stage 5 — normalisation
  (project, sf, cfg, mode) => ruleNormaliseInterfaceType(sf, cfg, mode),
  (project, sf, cfg, mode) => ruleNormaliseArrayType(sf, cfg, mode),
  // Stage 6 — extraction
  (project, sf, cfg, mode) => ruleExtractEnum(project, sf, cfg, mode),
  // Stage 7 — organisation
  (project, sf, cfg, mode) => ruleSortMembers(sf, cfg, mode),
  (project, sf, cfg, mode) => ruleSortUnionMembers(sf, cfg, mode),
  // Stage 8 — import cleanup
  (project, sf, cfg, mode) => ruleSortImports(sf, cfg, mode),
  (project, sf, cfg, mode) => ruleRemoveUnusedImports(sf, cfg, mode),
  (project, sf, cfg, mode) => ruleDedupImports(sf, cfg, mode),
];

const RULE_IDS = [
  'merge-declarations', 'dedup-identical',
  'remove-optional-undefined', 'remove-never-union', 'remove-unknown-intersection',
  'remove-duplicate-union-members', 'flatten-nested-unions',
  'remove-noop-utility', 'remove-wrapper-types',
  'normalise-interface-type', 'normalise-array-type',
  'extract-enum',
  'sort-members', 'sort-union-members',
  'sort-imports', 'remove-unused-imports', 'dedup-imports',
];

function runRules(project, cfg, mode) {
  const allFindings = [];
  const allFlags = [];

  // Per-file rules (in pipeline order)
  project.getSourceFiles().forEach(sf => {
    RULE_PIPELINE.forEach((ruleFn, i) => {
      const ruleId = RULE_IDS[i];
      if (!isRuleEnabled(cfg, ruleId)) return;
      try {
        const results = ruleFn(project, sf, cfg, mode);
        allFindings.push(...results);
      } catch (e) {
        console.error(`  [${ruleId}] Error on ${path.basename(sf.getFilePath())}: ${e.message}`);
      }
    });
  });

  // Project-level rules
  if (isRuleEnabled(cfg, 'remove-unused-types')) {
    try {
      allFindings.push(...ruleRemoveUnusedTypes(project, cfg, mode));
    } catch (e) {
      console.error(`  [remove-unused-types] Error: ${e.message}`);
    }
  }

  // Flag-only rules
  project.getSourceFiles().forEach(sf => {
    if (isRuleEnabled(cfg, 'flag-any')) {
      allFlags.push(...ruleFlagAny(sf, cfg));
    }
    if (isRuleEnabled(cfg, 'flag-object-type')) {
      allFlags.push(...ruleFlagObjectType(sf));
    }
  });

  return { findings: allFindings, flags: allFlags };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
function cmdAnalyze(cfg, projectDir) {
  console.error('\nScanning TypeScript files...');
  const project = buildProject(cfg, projectDir);
  const files = project.getSourceFiles();
  console.error(`  Found ${files.length} files`);

  const { findings, flags } = runRules(project, cfg, 'analyze');

  // Stats
  const byRule = {};
  findings.forEach(f => {
    byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  });

  // Save findings
  const outDir = path.join(projectDir, '.type-cleaner');
  fs.mkdirSync(outDir, { recursive: true });
  const findingsData = {
    files: files.length,
    findings,
    flags,
    stats: { byRule },
  };
  fs.writeFileSync(path.join(outDir, 'findings.json'), JSON.stringify(findingsData, null, 2));

  // Print summary
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`${'Rule'.padEnd(35)} ${'Findings'.padEnd(10)} Auto-apply`);
  console.log(`${'─'.repeat(55)}`);
  RULE_IDS.forEach(id => {
    if (!isRuleEnabled(cfg, id)) return;
    const count = byRule[id] || 0;
    if (count === 0) return;
    const auto = ['extract-enum', 'dedup-partial'].includes(id) ? 'confirm' : 'yes';
    console.log(`${id.padEnd(35)} ${String(count).padEnd(10)} ${auto}`);
  });
  if (flags.length) {
    const flagByRule = {};
    flags.forEach(f => { flagByRule[f.rule] = (flagByRule[f.rule] || 0) + 1; });
    Object.entries(flagByRule).forEach(([rule, count]) => {
      console.log(`${rule.padEnd(35)} ${String(count).padEnd(10)} flag only`);
    });
  }
  console.log(`${'─'.repeat(55)}`);
  const total = findings.length;
  console.log(`Total findings: ${total}   Flags: ${flags.length}`);
  console.log(`\nFindings written to .type-cleaner/findings.json`);

  return findingsData;
}

function cmdTransform(cfg, projectDir) {
  console.error('\nApplying transformations...');
  const project = buildProject(cfg, projectDir);
  const { findings } = runRules(project, cfg, 'transform');
  project.saveSync();

  const byRule = {};
  findings.forEach(f => { byRule[f.rule] = (byRule[f.rule] || 0) + 1; });

  console.log('\nTransformations applied:');
  Object.entries(byRule).forEach(([rule, count]) => {
    console.log(`  ${rule}: ${count} change(s)`);
  });

  // Persist results for report
  const outDir = path.join(projectDir, '.type-cleaner');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'applied.json'), JSON.stringify({ findings, byRule }, null, 2));

  return { findings, byRule };
}

function cmdValidate(cfg, projectDir) {
  console.error('\nValidating with tsc --noEmit...');
  if (!fs.existsSync(path.join(projectDir, 'tsconfig.json'))) {
    console.error('  ⚠  No tsconfig.json — skipping tsc validation');
    return true;
  }
  const tscPath = path.join(projectDir, 'node_modules', '.bin', 'tsc');
  const tsc = fs.existsSync(tscPath) ? tscPath : 'tsc';
  const result = spawnSync(tsc, ['--noEmit', '--project', projectDir], {
    cwd: projectDir, encoding: 'utf8',
  });

  if (result.status === 0) {
    console.log('  ✓ tsc --noEmit passed — no type errors');
    return true;
  }
  console.error('  ✗ tsc --noEmit reported errors:');
  console.error((result.stdout || result.stderr || '').split('\n').slice(0, 30).join('\n'));
  console.error('\n  To revert: git checkout .');
  return false;
}

function cmdReport(cfg, projectDir) {
  const outDir = path.join(projectDir, '.type-cleaner');
  const appliedPath = path.join(outDir, 'applied.json');
  const findingsPath = path.join(outDir, 'findings.json');

  let applied = { findings: [], byRule: {} };
  let findingsData = { flags: [] };

  if (fs.existsSync(appliedPath)) {
    applied = JSON.parse(fs.readFileSync(appliedPath, 'utf8'));
  }
  if (fs.existsSync(findingsPath)) {
    findingsData = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  }

  const date = new Date().toISOString().slice(0, 10);
  const modifiedFiles = new Set(applied.findings.map(f => f.file)).size;

  const ruleRows = Object.entries(applied.byRule)
    .map(([rule, count]) => `| \`${rule}\` | ${count} |`)
    .join('\n');

  const flagSummary = (() => {
    const byRule = {};
    (findingsData.flags || []).forEach(f => {
      byRule[f.rule] = (byRule[f.rule] || 0) + 1;
    });
    return Object.entries(byRule)
      .map(([r, c]) => `- \`${r}\`: ${c} occurrence(s)`)
      .join('\n');
  })();

  const flagDetails = (findingsData.flags || [])
    .slice(0, 50)
    .map(f => `- \`${path.relative(projectDir, f.file)}:${f.line}\` — ${f.description}`)
    .join('\n');

  const report = `# Type Cleaner Report

Date: ${date}
Files scanned: ${findingsData.files || '?'}
Files modified: ${modifiedFiles}
Rules applied: ${Object.keys(applied.byRule).length}

## Changes by rule

| Rule | Changes |
|---|---|
${ruleRows || '| — | no changes |'}

## Flags (require manual review)

${flagSummary || '_(none)_'}

### Flag details

${flagDetails || '_(none)_'}
`;

  const reportPath = path.resolve(projectDir, cfg.reportPath || 'type-cleaner-report.md');
  fs.writeFileSync(reportPath, report);
  console.log(`\n  Report written to ${reportPath}`);
}

function cmdRun(cfg, projectDir, dryRun) {
  // Pre-flight warnings
  if (!fs.existsSync(path.join(projectDir, 'tsconfig.json'))) {
    console.error('  ⚠  No tsconfig.json found — using default compiler options');
  }
  const gitStatus = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectDir, encoding: 'utf8',
  });
  if (gitStatus.stdout?.trim()) {
    console.error('  ⚠  Uncommitted changes detected. Commit or stash before running.');
    console.error('      Changes can be reverted with: git checkout .');
  }

  cmdAnalyze(cfg, projectDir);
  if (dryRun || cfg.dryRun) {
    console.log('\ndryRun=true — no files written.');
    return;
  }

  cmdTransform(cfg, projectDir);
  const valid = cmdValidate(cfg, projectDir);
  if (cfg.report !== false) cmdReport(cfg, projectDir);

  if (!valid) {
    process.exit(1);
  }
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
Usage: node cleaner.js --mode <mode> [options]

Modes:
  analyze       Scan files and collect findings (read-only)
  transform     Apply findings to files
  validate      Run tsc --noEmit to check for errors
  report        Write type-cleaner-report.md
  run           Full pipeline (analyze → transform → validate → report)

Options:
  --project-dir <path>   Root of the TypeScript project (default: .)
  --config <path>        Path to type-cleaner.config.json
  --dry-run              Preview only, no writes
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
  if (args.dryRun || args['dry-run']) cfg.dryRun = true;

  switch (mode) {
    case 'analyze':   cmdAnalyze(cfg, projectDir); break;
    case 'transform': cmdTransform(cfg, projectDir); break;
    case 'validate':  cmdValidate(cfg, projectDir); break;
    case 'report':    cmdReport(cfg, projectDir); break;
    case 'run':       cmdRun(cfg, projectDir, cfg.dryRun); break;
    default:
      console.error(`Unknown mode: ${mode}`);
      process.exit(1);
  }
}

main();
