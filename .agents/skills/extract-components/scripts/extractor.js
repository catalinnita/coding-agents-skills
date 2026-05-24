#!/usr/bin/env node
'use strict';

/**
 * extract-components extractor — modes: scan | fingerprint | run
 * Requires: ts-morph (auto-installed)
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
function ensureDep(name) {
  try { require.resolve(name); return; } catch (_) {}
  console.error(`Installing ${name}...`);
  execSync(`npm install ${name}`, { cwd: __dirname, stdio: 'inherit' });
}
ensureDep('ts-morph');

const { Project, SyntaxKind: SK, Node } = require('ts-morph');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
function hasFlag(flag) { return args.includes(flag); }

const MODE            = getArg('--mode', 'run');
const TARGET          = getArg('--target', 'src');
const OUTPUT_PLAN     = getArg('--output-plan', '.extract-components/plan.json');
const MIN_OCCURRENCES = parseInt(getArg('--min-occurrences', '3'), 10);
const MIN_DEPTH       = parseInt(getArg('--min-depth', '2'), 10);
const OUTPUT_DIR      = getArg('--output-dir', 'src/components');
const DRY_RUN         = hasFlag('--dry-run');
const INTERACTIVE     = !hasFlag('--no-interactive');
const SELECT_ARG      = getArg('--select', '');
const PROJECT_DIR     = getArg('--project-dir', process.cwd());

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git', '.turbo', '__tests__', '_docs']);
const SKIP_EXT  = /(\.test\.|\.spec\.|\.stories\.)/;

// ---------------------------------------------------------------------------
// Step 1 — Scan files
// ---------------------------------------------------------------------------
function scanFiles(targetPath) {
  const abs = path.resolve(PROJECT_DIR, targetPath);
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      const ext = path.extname(entry.name);
      if (!['.tsx', '.jsx'].includes(ext)) continue;
      if (SKIP_EXT.test(entry.name)) continue;
      files.push(path.join(dir, entry.name));
    }
  }

  if (fs.existsSync(abs)) {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) walk(abs);
    else if (!SKIP_EXT.test(abs)) files.push(abs);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Step 2 — Parse and fingerprint
// ---------------------------------------------------------------------------

/** Estimate nesting depth of a JSX element node.
 *  Traverses the FULL syntax tree (including SyntaxList wrappers) so nested
 *  JSX elements are found regardless of how ts-morph wraps them.
 */
function jsxDepth(node) {
  let max = 0;
  function walk(n, jsxD) {
    if (jsxD > max) max = jsxD;
    for (const child of n.getChildren()) {
      const k = child.getKind();
      const isJsx = k === SK.JsxElement || k === SK.JsxSelfClosingElement || k === SK.JsxFragment;
      walk(child, isJsx ? jsxD + 1 : jsxD);
    }
  }
  // Start children at depth 0; first JSX child will be depth 1
  for (const child of node.getChildren()) {
    const k = child.getKind();
    const isJsx = k === SK.JsxElement || k === SK.JsxSelfClosingElement || k === SK.JsxFragment;
    walk(child, isJsx ? 1 : 0);
  }
  return max;
}

/** Count total JSX attributes across the subtree */
function countAttrs(node) {
  let count = 0;
  function walk(n) {
    const k = n.getKind();
    if (k === SK.JsxAttribute) count++;
    for (const c of n.getChildren()) walk(c);
  }
  walk(node);
  return count;
}

/** Count total JSX nodes in subtree.
 *  Must traverse through SyntaxList wrappers to find nested JSX elements.
 */
function countNodes(node) {
  let count = 1;
  function walk(n) {
    for (const c of n.getChildren()) {
      const k = c.getKind();
      if (k === SK.JsxElement || k === SK.JsxSelfClosingElement || k === SK.JsxFragment) {
        count++;
        walk(c);
      } else {
        // Traverse through SyntaxList and other wrapper nodes
        walk(c);
      }
    }
  }
  walk(node);
  return count;
}

/**
 * Produce a structural fingerprint string for a JSX element.
 * Varying leaf values → typed placeholders.
 * Element structure (tags, attribute names, tree shape) → kept.
 */
function fingerprint(node) {
  function fp(n) {
    const k = n.getKind();

    if (k === SK.JsxSelfClosingElement) {
      const tag = n.getTagNameNode().getText();
      const attrs = fpAttrs(n.getAttributes());
      return `<${tag} ${attrs}/>`;
    }

    if (k === SK.JsxElement) {
      const open  = n.getOpeningElement();
      const close = n.getClosingElement();
      const tag   = open.getTagNameNode().getText();
      const attrs = fpAttrs(open.getAttributes());
      const kids  = n.getJsxChildren().map(fpChild).join('');
      return `<${tag} ${attrs}>${kids}</${tag}>`;
    }

    if (k === SK.JsxFragment) {
      const kids = n.getJsxChildren().map(fpChild).join('');
      return `<>${kids}</>`;
    }

    return '«node»';
  }

  function fpChild(n) {
    const k = n.getKind();
    if (k === SK.JsxText) {
      const txt = n.getText().trim();
      return txt ? '«text»' : '';
    }
    if (k === SK.JsxExpression) {
      const expr = n.getExpression();
      if (!expr) return '{«empty»}';
      const ek = expr.getKind();
      if (ek === SK.StringLiteral) return '{«string»}';
      if (ek === SK.NumericLiteral) return '{«number»}';
      if (ek === SK.TrueKeyword || ek === SK.FalseKeyword) return '{«boolean»}';
      if (ek === SK.ArrowFunction || ek === SK.FunctionExpression) return '{«handler»}';
      // map/conditional/call → expression
      return '{«expression»}';
    }
    if (k === SK.JsxElement || k === SK.JsxSelfClosingElement || k === SK.JsxFragment) {
      return fp(n);
    }
    return '';
  }

  function fpAttrs(attrs) {
    return attrs.map(a => {
      if (a.getKind() === SK.JsxSpreadAttribute) return '{...«spread»}';
      const name = a.getNameNode().getText();
      const init = a.getInitializer();
      if (!init) return name; // boolean attr like `disabled`
      if (init.getKind() === SK.StringLiteral) return `${name}=«string»`;
      if (init.getKind() === SK.JsxExpression) {
        const expr = init.getExpression();
        if (!expr) return `${name}={«empty»}`;
        const ek = expr.getKind();
        if (ek === SK.ArrowFunction || ek === SK.FunctionExpression) return `${name}=«handler»`;
        if (ek === SK.TrueKeyword || ek === SK.FalseKeyword) return `${name}=«boolean»`;
        if (ek === SK.StringLiteral) return `${name}=«string»`;
        if (ek === SK.NumericLiteral) return `${name}=«number»`;
        return `${name}=«expression»`;
      }
      return name;
    }).join(' ');
  }

  return fp(node);
}

/**
 * Get all root-level candidate JSX elements in a source file.
 * A "root-level" candidate is a JSX element that is not a direct JSX child
 * of another JSX element (i.e. it appears as a statement/expression top-level).
 * We collect ALL JSX elements, then discard those whose parent is also JSX.
 */
function getRootJsxNodes(sourceFile) {
  const results = [];

  function walk(node) {
    const k = node.getKind();
    if (k === SK.JsxElement || k === SK.JsxSelfClosingElement) {
      // Check parent: if parent is JsxElement children list → skip (not root)
      const pk = node.getParent()?.getKind();
      const isJsxChild = pk === SK.JsxElement || pk === SK.JsxFragment;
      if (!isJsxChild) {
        results.push(node);
        return; // don't descend further for root candidates — we collect children separately
      }
      // It's a JSX child — but we also want to check deeper
    }
    for (const child of node.getChildren()) walk(child);
  }

  walk(sourceFile);
  return results;
}

/**
 * Collect every JSX element in a source file (including nested),
 * grouped by their fingerprint hash.
 */
function fingerprintFile(sourceFile) {
  const results = [];

  function walk(node) {
    const k = node.getKind();
    if (k === SK.JsxElement || k === SK.JsxSelfClosingElement) {
      const depth = jsxDepth(node);
      const attrCount = countAttrs(node);

      if (depth >= Math.max(1, MIN_DEPTH - 1) && attrCount >= 2) {
        const fp = fingerprint(node);
        const hash = crypto.createHash('sha256').update(fp).digest('hex').slice(0, 16);
        const start = node.getStartLineNumber();
        const end   = node.getEndLineNumber();
        results.push({ hash, fp, node, start, end, depth, attrCount });
      }
    }
    for (const child of node.getChildren()) walk(child);
  }

  walk(sourceFile);
  return results;
}

// ---------------------------------------------------------------------------
// Step 3 — Score and rank patterns
// ---------------------------------------------------------------------------
function scorePatterns(allOccurrences) {
  const byHash = new Map();
  for (const occ of allOccurrences) {
    if (!byHash.has(occ.hash)) byHash.set(occ.hash, []);
    byHash.get(occ.hash).push(occ);
  }

  const patterns = [];
  for (const [hash, occurrences] of byHash) {
    if (occurrences.length < MIN_OCCURRENCES) continue;

    const files = [...new Set(occurrences.map(o => o.file))];
    const crossFileBonus = files.length > 1 ? 2.0 : 1.0;
    const nodeCount = countNodes(occurrences[0].node);

    // Skip trivially generic single-wrapper patterns like <div>{expr}</div>
    if (nodeCount < 2) continue;

    const score = occurrences.length * nodeCount * crossFileBonus;

    patterns.push({
      hash,
      fingerprint: occurrences[0].fp,
      occurrences: occurrences.length,
      files,
      locations: occurrences.map(o => ({ file: o.file, startLine: o.start, endLine: o.end })),
      nodeCount,
      score,
      sample: occurrences[0].node,
      allNodes: occurrences.map(o => o.node),
    });
  }

  return patterns.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Step 4-5 — Cross-occurrence slot analysis and prop inference
// ---------------------------------------------------------------------------

function attrPropName(attrName, tag) {
  const map = {
    onChange: 'onChange', onInput: 'onInput', onClick: 'onClick', onBlur: 'onBlur',
    onKeyDown: 'onKeyDown', onFocus: 'onFocus', onSubmit: 'onSubmit',
    href: 'href', src: 'src', alt: 'alt', placeholder: 'placeholder',
    value: 'value', defaultValue: 'defaultValue', type: 'type', 'aria-label': 'ariaLabel',
    className: 'className', id: 'id', name: 'name', disabled: 'disabled',
    title: 'title', 'aria-labelledby': 'ariaLabelledby',
  };
  return map[attrName] || attrName;
}

function inferHandlerType(attrName, tag) {
  if (attrName === 'onChange') {
    if (tag === 'select') return 'ChangeEventHandler<HTMLSelectElement>';
    if (tag === 'input') return 'ChangeEventHandler<HTMLInputElement>';
    if (tag === 'textarea') return 'ChangeEventHandler<HTMLTextAreaElement>';
    return 'ChangeEventHandler<HTMLElement>';
  }
  if (attrName === 'onBlur' || attrName === 'onFocus') return 'FocusEventHandler<HTMLElement>';
  if (attrName === 'onKeyDown') return 'KeyboardEventHandler<HTMLElement>';
  if (attrName === 'onClick' || attrName === 'onSubmit') return '() => void';
  return '() => void';
}

/**
 * Collect all leaf values from a JSX node in document order.
 * Returns an array of { kind: 'attr'|'text'|'expr', attrName?, tag, value, raw }.
 * 'value' is the normalized string for comparison, 'raw' is the source text for rendering.
 */
function collectLeafValues(node) {
  const slots = [];

  function getAttrVal(init) {
    if (!init) return { v: '__boolean__', r: '' };
    if (init.getKind() === SK.StringLiteral) {
      const raw = init.getText();
      return { v: raw, r: raw };
    }
    if (init.getKind() === SK.JsxExpression) {
      const expr = init.getExpression();
      if (!expr) return { v: '__empty__', r: '{}' };
      return { v: expr.getText(), r: `{${expr.getText()}}` };
    }
    return { v: init.getText(), r: init.getText() };
  }

  function walk(n) {
    const k = n.getKind();
    if (k === SK.JsxSelfClosingElement) {
      const tag = n.getTagNameNode().getText();
      for (const attr of n.getAttributes()) {
        if (attr.getKind() !== SK.JsxAttribute) continue;
        const aName = attr.getNameNode().getText();
        const { v, r } = getAttrVal(attr.getInitializer());
        slots.push({ kind: 'attr', attrName: aName, tag, value: v, raw: r });
      }
      return;
    }
    if (k === SK.JsxElement) {
      const tag = n.getOpeningElement().getTagNameNode().getText();
      for (const attr of n.getOpeningElement().getAttributes()) {
        if (attr.getKind() !== SK.JsxAttribute) continue;
        const aName = attr.getNameNode().getText();
        const { v, r } = getAttrVal(attr.getInitializer());
        slots.push({ kind: 'attr', attrName: aName, tag, value: v, raw: r });
      }
      for (const child of n.getJsxChildren()) {
        const ck = child.getKind();
        if (ck === SK.JsxText) {
          const txt = child.getText().trim();
          if (txt) slots.push({ kind: 'text', tag, value: txt, raw: txt });
        } else if (ck === SK.JsxExpression) {
          const expr = child.getExpression();
          if (expr) slots.push({ kind: 'expr', tag, value: expr.getText(), raw: `{${expr.getText()}}` });
        } else if (ck === SK.JsxElement || ck === SK.JsxSelfClosingElement || ck === SK.JsxFragment) {
          walk(child);
        }
      }
      return;
    }
    if (k === SK.JsxFragment) {
      for (const child of n.getJsxChildren()) {
        const ck = child.getKind();
        if (ck === SK.JsxElement || ck === SK.JsxSelfClosingElement || ck === SK.JsxFragment) walk(child);
      }
    }
  }

  walk(node);
  return slots;
}

/**
 * Compare all occurrence nodes to determine which slots are fixed (same value
 * across all occurrences) vs varying (differ).
 * Returns: { props, fixedSlots } where
 *   props: array of { name, type, required }
 *   fixedSlots: Map<slotIndex, fixedRawValue>
 */
function analyzePattern(occurrenceNodes) {
  // Collect slots from each occurrence
  const allSlotSets = occurrenceNodes.map(n => collectLeafValues(n));
  const nSlots = allSlotSets[0].length;

  const props = [];
  const fixedSlots = new Map();
  const usedPropNames = new Set();
  let propIdx = 0;

  // Track className collisions to produce better names like "iconClassName"
  const classNameTags = [];

  function mkPropName(base, slot) {
    let name = base || `prop${propIdx++}`;
    if (usedPropNames.has(name)) {
      // For className conflicts, use the tag name as prefix
      if (base === 'className' && slot) {
        const tagHint = slot.tag ? slot.tag.toLowerCase().replace(/[^a-z]/g, '') : '';
        const candidate = tagHint ? `${tagHint}ClassName` : `${base}${++propIdx}`;
        name = candidate;
      } else {
        let c = 2;
        while (usedPropNames.has(`${base}${c}`)) c++;
        name = `${base}${c}`;
      }
    }
    usedPropNames.add(name);
    return name;
  }

  for (let i = 0; i < nSlots; i++) {
    const slot0 = allSlotSets[0][i];
    if (!slot0) continue;

    // Check if value is identical across all occurrences
    const isFixed = allSlotSets.every(slots => slots[i] && slots[i].value === slot0.value);

    if (isFixed) {
      fixedSlots.set(i, slot0.raw);
      continue;
    }

    // Varying — becomes a prop
    const { kind, attrName, tag } = slot0;
    let propName, propType;

    if (kind === 'attr') {
      propName = mkPropName(attrPropName(attrName, tag), slot0);
      const init = occurrenceNodes[0].getKind() === SK.JsxSelfClosingElement
        ? occurrenceNodes[0].getAttributes().find(a => a.getKind() === SK.JsxAttribute && a.getNameNode().getText() === attrName)?.getInitializer()
        : (() => {
            function findInit(n) {
              const nk = n.getKind();
              if (nk === SK.JsxSelfClosingElement || nk === SK.JsxElement) {
                const attrs = nk === SK.JsxSelfClosingElement
                  ? n.getAttributes()
                  : n.getOpeningElement().getAttributes();
                for (const a of attrs) {
                  if (a.getKind() === SK.JsxAttribute && a.getNameNode().getText() === attrName) return a.getInitializer();
                }
              }
              for (const c of n.getChildren()) { const r = findInit(c); if (r) return r; }
              return null;
            }
            return findInit(occurrenceNodes[0]);
          })();

      if (init && init.getKind() === SK.StringLiteral) {
        propType = 'string';
      } else if (init && init.getKind() === SK.JsxExpression) {
        const expr = init.getExpression();
        if (expr) {
          const ek = expr.getKind();
          if (ek === SK.ArrowFunction || ek === SK.FunctionExpression) propType = inferHandlerType(attrName, tag);
          else if (ek === SK.TrueKeyword || ek === SK.FalseKeyword) propType = 'boolean';
          else if (ek === SK.StringLiteral) propType = 'string';
          else if (ek === SK.NumericLiteral) propType = 'number';
          // Function reference (Identifier/PropertyAccess) → infer from attr name
          else if (/^on[A-Z]/.test(attrName)) propType = inferHandlerType(attrName, tag);
          else if (attrName === 'disabled') propType = 'boolean';
          else propType = 'string | number';
        } else propType = 'string';
      } else propType = 'string';
    } else if (kind === 'text') {
      propName = mkPropName(tag === 'label' || tag === 'h1' || tag === 'h2' || tag === 'h3' ? 'label' : 'children');
      propType = 'string';
    } else { // expr
      propName = mkPropName(tag === 'label' ? 'label' : 'children');
      propType = 'React.ReactNode';
    }

    props.push({ name: propName, type: propType, required: true, slotIndex: i });
    // Store the slot index → prop name mapping for rendering
    fixedSlots.set(i, `PROP:${propName}`); // sentinel to replace with prop ref
  }

  return { props, fixedSlots, nSlots, baseSlots: allSlotSets[0] };
}

/** Derive component name from JSX structure */
function inferComponentName(node) {
  let rootTag = '';
  let hasLabel = false, hasInput = false, hasSelect = false, hasButton = false;
  let hasLoader = false, hasX = false, hasAlert = false, hasTrash = false;
  let hasH1 = false, hasH2 = false, hasP = false, hasTbody = false, hasThead = false;
  let hasOption = false;

  function check(n) {
    const nk = n.getKind();
    if (nk === SK.JsxElement || nk === SK.JsxSelfClosingElement) {
      const t = nk === SK.JsxElement
        ? n.getOpeningElement().getTagNameNode().getText()
        : n.getTagNameNode().getText();
      if (!rootTag) rootTag = t;
      if (t === 'label') hasLabel = true;
      if (t === 'input') hasInput = true;
      if (t === 'select') hasSelect = true;
      if (t === 'button') hasButton = true;
      if (t === 'h1') hasH1 = true;
      if (t === 'h2') hasH2 = true;
      if (t === 'p') hasP = true;
      if (t === 'tbody') hasTbody = true;
      if (t === 'thead') hasThead = true;
      if (t === 'option') hasOption = true;
      if (t === 'Loader2' || t === 'Spinner' || t.includes('Loader')) hasLoader = true;
      if (t === 'X' || t === 'XIcon' || t === 'Close') hasX = true;
      if (t === 'AlertTriangle' || t === 'Alert' || t.includes('Warning')) hasAlert = true;
      if (t === 'Trash2' || t === 'Trash') hasTrash = true;
    }
    for (const c of n.getChildren()) check(c);
  }
  check(node);

  // Specific structural patterns → descriptive names
  if (hasLoader && rootTag === 'div') return 'LoadingState';
  if (hasLabel && (hasInput || hasSelect)) return 'FormField';
  if (hasX && hasButton && rootTag === 'button') return 'CloseButton';
  if (hasTrash && hasButton) return 'DeleteButton';
  if (hasAlert && rootTag === 'div') return 'AlertBanner';
  if (hasSelect && hasOption) return 'SelectField';
  if (hasH1 && hasP && rootTag === 'div') return 'PageHeader';
  if (hasH1 && !hasP && rootTag === 'div') return 'PageHeading';
  if (hasH2 && rootTag === 'div') return 'SectionCard';
  if (hasP && rootTag === 'div' && !hasH1 && !hasH2) return 'TextBlock';
  if (hasTbody) return 'TableBody';
  if (hasThead) return 'TableHead';
  if (rootTag === 'button') return 'ActionButton';
  if (rootTag === 'tr') return 'TableRow';
  if (rootTag === 'li') return 'ListItem';
  if (rootTag === 'a') return 'NavLink';
  if (rootTag === 'select') return 'SelectField';
  if (rootTag === 'div') return 'Card';
  return 'ExtractedBlock';
}

// ---------------------------------------------------------------------------
// Step 6 — Generate component file
// ---------------------------------------------------------------------------

/**
 * Render a JSX node as a component body.
 * Uses fixedSlots map: slot index → raw value or "PROP:<name>" sentinel.
 * Rebuilds source by walking the node and substituting values.
 */
function renderComponentBody(node, fixedSlots, baseSlots, indent) {
  let slotIdx = 0;
  const pad = indent || '    ';

  function renderAttrVal(attrName, init) {
    const slot = baseSlots[slotIdx];
    const resolution = fixedSlots.get(slotIdx);
    slotIdx++;

    if (resolution === undefined) return init ? init.getText() : '';
    if (resolution.startsWith('PROP:')) {
      const propName = resolution.slice(5);
      if (init && init.getKind() === SK.StringLiteral) return `{${propName}}`;
      return `{${propName}}`;
    }
    // Fixed — use original raw value
    return resolution;
  }

  function renderNode(n, depth) {
    const k = n.getKind();
    const indentStr = '  '.repeat(depth);

    if (k === SK.JsxSelfClosingElement) {
      const tag = n.getTagNameNode().getText();
      const attrs = n.getAttributes().map(a => {
        if (a.getKind() !== SK.JsxAttribute) return '';
        const aName = a.getNameNode().getText();
        const val = renderAttrVal(aName, a.getInitializer());
        if (!a.getInitializer()) return aName; // boolean attr
        const init = a.getInitializer();
        if (init.getKind() === SK.StringLiteral && !val.startsWith('{')) return `${aName}=${val}`;
        return `${aName}=${val}`;
      }).filter(Boolean).join(' ');
      return `${indentStr}<${tag}${attrs ? ' ' + attrs : ''} />`;
    }

    if (k === SK.JsxElement) {
      const open = n.getOpeningElement();
      const tag = open.getTagNameNode().getText();
      const attrs = open.getAttributes().map(a => {
        if (a.getKind() !== SK.JsxAttribute) return '';
        const aName = a.getNameNode().getText();
        const val = renderAttrVal(aName, a.getInitializer());
        if (!a.getInitializer()) return aName;
        const init = a.getInitializer();
        if (init.getKind() === SK.StringLiteral && !val.startsWith('{')) return `${aName}=${val}`;
        return `${aName}=${val}`;
      }).filter(Boolean).join(' ');

      const children = n.getJsxChildren();
      const nonEmptyChildren = children.filter(c => {
        if (c.getKind() === SK.JsxText) return c.getText().trim().length > 0;
        return true;
      });

      if (nonEmptyChildren.length === 0) {
        return `${indentStr}<${tag}${attrs ? ' ' + attrs : ''}></${tag}>`;
      }

      const childLines = nonEmptyChildren.map(c => {
        const ck = c.getKind();
        if (ck === SK.JsxText) {
          const txt = c.getText().trim();
          if (!txt) return null;
          const slot = baseSlots[slotIdx];
          const resolution = fixedSlots.get(slotIdx);
          slotIdx++;
          if (resolution && resolution.startsWith('PROP:')) {
            return `${indentStr}  {${resolution.slice(5)}}`;
          }
          return `${indentStr}  ${resolution || txt}`;
        }
        if (ck === SK.JsxExpression) {
          const expr = c.getExpression();
          if (!expr) return null;
          const slot = baseSlots[slotIdx];
          const resolution = fixedSlots.get(slotIdx);
          slotIdx++;
          if (resolution && resolution.startsWith('PROP:')) {
            return `${indentStr}  {${resolution.slice(5)}}`;
          }
          return `${indentStr}  {${resolution || expr.getText()}}`;
        }
        if (ck === SK.JsxElement || ck === SK.JsxSelfClosingElement || ck === SK.JsxFragment) {
          return renderNode(c, depth + 1);
        }
        return null;
      }).filter(Boolean);

      return [
        `${indentStr}<${tag}${attrs ? ' ' + attrs : ''}>`,
        ...childLines,
        `${indentStr}</${tag}>`,
      ].join('\n');
    }

    if (k === SK.JsxFragment) {
      const children = n.getJsxChildren()
        .filter(c => c.getKind() !== SK.JsxText || c.getText().trim())
        .map(c => renderNode(c, depth + 1))
        .filter(Boolean);
      return [`${indentStr}<>`, ...children, `${indentStr}</>`].join('\n');
    }

    return '';
  }

  return renderNode(node, 2);
}

/** Collect all PascalCase tag names used in a JSX node (these need imports) */
function collectComponentTags(node) {
  const tags = new Set();
  function walk(n) {
    const k = n.getKind();
    if (k === SK.JsxElement) {
      const tag = n.getOpeningElement().getTagNameNode().getText();
      if (/^[A-Z]/.test(tag)) tags.add(tag);
    } else if (k === SK.JsxSelfClosingElement) {
      const tag = n.getTagNameNode().getText();
      if (/^[A-Z]/.test(tag)) tags.add(tag);
    }
    for (const c of n.getChildren()) walk(c);
  }
  walk(node);
  return tags;
}

/** Find which file a PascalCase tag is imported from in a source file */
function findImportSource(sourceFile, tagName) {
  for (const decl of sourceFile.getImportDeclarations()) {
    const named = decl.getNamedImports();
    const hasTag = named.some(n => n.getName() === tagName);
    if (hasTag) return decl.getModuleSpecifierValue();
  }
  return null;
}

function generateComponent(name, analysisResult, sampleNode, sourceFile) {
  const { props, fixedSlots, baseSlots } = analysisResult;

  const hasHandlers = props.some(p => p.type.includes('EventHandler') || p.type === '() => void');
  const hasReactNode = props.some(p => p.type === 'React.ReactNode');
  const useClient = sourceFile.getFullText().includes("'use client'") && hasHandlers;

  // Build component body
  let body;
  try {
    body = renderComponentBody(sampleNode, fixedSlots, baseSlots, '    ');
  } catch (e) {
    // Fallback: use source text
    body = sampleNode.getText().split('\n').map(l => '    ' + l).join('\n');
  }

  // Collect React type imports needed
  const reactTypeImports = new Set();
  if (hasReactNode) reactTypeImports.add('ReactNode');
  for (const p of props) {
    if (p.type.includes('EventHandler') || p.type.includes('FocusEventHandler') || p.type.includes('KeyboardEventHandler')) {
      reactTypeImports.add(p.type.split('<')[0]);
    }
  }

  // Collect third-party component imports needed — only tags that appear in the
  // rendered body string (not inside {children} or other prop slots).
  const tagsInBody = new Set(
    [...body.matchAll(/<([A-Z][a-zA-Z0-9]*)/g)].map(m => m[1])
  );
  const thirdPartyImports = new Map(); // modulePath → Set<tagName>
  for (const tag of tagsInBody) {
    const src = findImportSource(sourceFile, tag);
    if (src) {
      if (!thirdPartyImports.has(src)) thirdPartyImports.set(src, new Set());
      thirdPartyImports.get(src).add(tag);
    }
  }

  // Normalize prop types (strip React. prefix)
  const normalizedProps = props.map(p => ({
    ...p,
    type: p.type.replace('React.ReactNode', 'ReactNode'),
  }));

  const propsTypeDef = normalizedProps.length === 0
    ? ''
    : `type ${name}Props = {\n${normalizedProps.map(p => `  ${p.name}: ${p.type}`).join('\n')}\n}\n\n`;

  const propsDestructure = normalizedProps.length === 0
    ? ''
    : `{ ${normalizedProps.map(p => p.name).join(', ')} }: ${name}Props`;

  const lines = [];
  if (useClient) lines.push("'use client'", '');
  if (reactTypeImports.size > 0) lines.push(`import type { ${[...reactTypeImports].join(', ')} } from 'react'`, '');
  for (const [mod, tags] of thirdPartyImports) {
    lines.push(`import { ${[...tags].join(', ')} } from '${mod}'`);
  }
  if (thirdPartyImports.size > 0) lines.push('');
  lines.push(propsTypeDef + `export function ${name}(${propsDestructure}) {`);
  lines.push('  return (');
  lines.push(body);
  lines.push('  )');
  lines.push('}');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Step 7 — Rewrite call sites
// ---------------------------------------------------------------------------
function rewriteCallSites(pattern, name, outputDir, sourceFiles) {
  const changes = [];

  for (const loc of pattern.locations) {
    const sf = sourceFiles.find(f => f.getFilePath() === loc.file);
    if (!sf) continue;

    // Find the matching node by line range
    const occurrences = [];
    function walk(n) {
      const k = n.getKind();
      if (k === SK.JsxElement || k === SK.JsxSelfClosingElement) {
        if (n.getStartLineNumber() === loc.startLine && n.getEndLineNumber() === loc.endLine) {
          const fp = fingerprint(n);
          const hash = crypto.createHash('sha256').update(fp).digest('hex').slice(0, 16);
          if (hash === pattern.hash) {
            occurrences.push(n);
            return;
          }
        }
      }
      for (const c of n.getChildren()) walk(c);
    }
    walk(sf);

    if (occurrences.length === 0) continue;

    for (const occurrence of occurrences) {
      changes.push({ file: loc.file, node: occurrence, componentName: name, sf });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------
async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------
async function run() {
  if (MODE === 'scan') {
    const files = scanFiles(TARGET);
    console.log(`\nFound ${files.length} source files:\n`);
    for (const f of files) console.log(`  ${path.relative(PROJECT_DIR, f)}`);
    return;
  }

  // --- Fingerprint or full run ---
  const files = scanFiles(TARGET);
  if (files.length === 0) {
    console.log('No TSX/JSX files found.');
    return;
  }

  console.log(`\nScanning ${files.length} files in ${TARGET}...\n`);

  const project = new Project({
    tsConfigFilePath: path.resolve(PROJECT_DIR, 'tsconfig.json'),
    addFilesFromTsConfig: false,
    skipAddingFilesFromTsConfig: true,
  });

  const sourceFiles = files.map(f => project.addSourceFileAtPath(f));

  // Fingerprint all files
  const allOccurrences = [];
  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();
    const fileOccs = fingerprintFile(sf);
    for (const occ of fileOccs) {
      allOccurrences.push({ ...occ, file: filePath });
    }
  }

  if (MODE === 'fingerprint') {
    const patterns = scorePatterns(allOccurrences);
    const planDir = path.dirname(path.resolve(PROJECT_DIR, OUTPUT_PLAN));
    fs.mkdirSync(planDir, { recursive: true });
    const plan = {
      patterns: patterns.map(p => ({
        hash: p.hash, occurrences: p.occurrences, files: p.files,
        locations: p.locations, fingerprint: p.fingerprint, score: p.score,
      }))
    };
    fs.writeFileSync(path.resolve(PROJECT_DIR, OUTPUT_PLAN), JSON.stringify(plan, null, 2));
    console.log(`Plan written to ${OUTPUT_PLAN}`);
    return;
  }

  // --- Mode: run ---
  const patterns = scorePatterns(allOccurrences);

  if (patterns.length === 0) {
    console.log(`\nNo extractable patterns found (min ${MIN_OCCURRENCES} occurrences, min depth ${MIN_DEPTH}).\n`);
    return;
  }

  // Show ranked list
  console.log(`\nFound ${patterns.length} extractable pattern${patterns.length === 1 ? '' : 's'}:\n`);
  patterns.forEach((p, i) => {
    const fp = p.fingerprint.replace(/\s+/g, ' ').slice(0, 80);
    const filesLabel = p.files.map(f => path.relative(PROJECT_DIR, f)).join(', ');
    console.log(`  #${i + 1}  score ${Math.round(p.score)}  — ${p.occurrences} occurrences  ${filesLabel}`);
    console.log(`      ${fp}…`);
    console.log();
  });

  // Interactive selection
  let selected = patterns;
  if (SELECT_ARG) {
    const nums = SELECT_ARG.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n) && n >= 0 && n < patterns.length);
    selected = nums.map(n => patterns[n]);
  } else if (INTERACTIVE) {
    const answer = await prompt('Which patterns to extract? (all / comma-separated numbers / none): ');
    if (!answer || answer.toLowerCase() === 'none') {
      console.log('Aborted.');
      return;
    }
    if (answer.toLowerCase() !== 'all') {
      const nums = answer.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n) && n >= 0 && n < patterns.length);
      selected = nums.map(n => patterns[n]);
    }
  }

  if (selected.length === 0) {
    console.log('No patterns selected.');
    return;
  }

  // Track used component names to avoid collisions
  const usedNames = new Set();
  const extractedComponents = [];

  for (const pattern of selected) {
    const sampleSf = sourceFiles.find(sf => sf.getFilePath() === pattern.files[0]);

    // Infer component name
    let baseName = inferComponentName(pattern.sample);
    let componentName = baseName;
    let suffix = 2;
    while (usedNames.has(componentName)) componentName = `${baseName}${suffix++}`;
    usedNames.add(componentName);

    // Analyze cross-occurrence values to determine fixed vs varying props
    const analysisResult = analyzePattern(pattern.allNodes);
    const { props } = analysisResult;

    console.log(`\n${componentName} — ${pattern.occurrences} occurrences`);
    console.log(`  Files: ${pattern.files.map(f => path.relative(PROJECT_DIR, f)).join(', ')}`);
    if (props.length === 0) {
      console.log(`  No props — all values are identical across occurrences`);
    } else {
      console.log(`\n  Prop          Type`);
      console.log(`  ${'─'.repeat(50)}`);
      for (const p of props) {
        console.log(`  ${p.name.padEnd(14)}${p.type}`);
      }
    }
    console.log();

    if (INTERACTIVE) {
      const rename = await prompt(`  Component name [${componentName}]: `);
      if (rename) componentName = rename.trim() || componentName;
    }

    // Generate component
    const absOutputDir = path.resolve(PROJECT_DIR, OUTPUT_DIR);
    const componentPath = path.join(absOutputDir, `${componentName}.tsx`);
    const componentCode = generateComponent(componentName, analysisResult, pattern.sample, sampleSf);

    if (DRY_RUN) {
      console.log(`\n  [dry-run] Would write: ${path.relative(PROJECT_DIR, componentPath)}`);
      console.log(`\n  Preview:\n`);
      console.log(componentCode.split('\n').map(l => '    ' + l).join('\n'));
    } else {
      fs.mkdirSync(absOutputDir, { recursive: true });
      fs.writeFileSync(componentPath, componentCode);
      console.log(`  Written: ${path.relative(PROJECT_DIR, componentPath)}`);
    }

    extractedComponents.push({
      name: componentName,
      path: componentPath,
      props,
      pattern,
      analysisResult,
      linesRemoved: pattern.locations.reduce((sum, loc) => sum + (loc.endLine - loc.startLine + 1), 0),
    });
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] No files were modified.\n');
    return;
  }

  // Step 7 — Rewrite call sites
  console.log('\nRewriting call sites...\n');

  const filesToModify = new Map();

  for (const comp of extractedComponents) {
    const changes = rewriteCallSites(comp.pattern, comp.name, OUTPUT_DIR, sourceFiles);

    for (const change of changes) {
      if (!filesToModify.has(change.file)) {
        filesToModify.set(change.file, { sf: change.sf, modifications: [] });
      }
      filesToModify.get(change.file).modifications.push({
        node: change.node,
        componentName: change.componentName,
        componentPath: comp.path,
        props: comp.props,
        analysisResult: comp.analysisResult,
      });
    }
  }

  for (const [filePath, { sf, modifications }] of filesToModify) {
    let source = sf.getFullText();
    const relative = path.relative(PROJECT_DIR, filePath);

    // Sort modifications by start position (descending) so we replace from end to start
    const sorted = [...modifications].sort((a, b) =>
      b.node.getStart() - a.node.getStart()
    );

    const replacements = [];

    for (const mod of sorted) {
      const { node, componentName, componentPath, props, analysisResult } = mod;

      // Build the replacement JSX call using slot-based extraction
      const replacement = buildComponentCall(node, componentName, props, analysisResult);
      replacements.push({
        start: node.getStart(),
        end: node.getEnd(),
        text: replacement,
        componentName,
        componentPath,
      });
    }

    // Apply replacements from end to start
    let newSource = source;
    for (const rep of replacements) {
      newSource = newSource.slice(0, rep.start) + rep.text + newSource.slice(rep.end);
    }

    // Add imports (deduplicated)
    const neededImports = [...new Set(replacements.map(r => r.componentName))];
    for (const compName of neededImports) {
      const rep = replacements.find(r => r.componentName === compName);
      const importPath = computeRelativeImport(filePath, rep.componentPath);
      const importLine = `import { ${compName} } from '${importPath}'`;

      if (!newSource.includes(importLine)) {
        // Insert after last import
        const lastImportMatch = [...newSource.matchAll(/^import .+$/gm)].pop();
        if (lastImportMatch) {
          const pos = lastImportMatch.index + lastImportMatch[0].length;
          newSource = newSource.slice(0, pos) + '\n' + importLine + newSource.slice(pos);
        } else {
          newSource = importLine + '\n' + newSource;
        }
      }
    }

    fs.writeFileSync(filePath, newSource);
    console.log(`  Rewritten: ${relative} (${replacements.length} occurrence${replacements.length === 1 ? '' : 's'})`);
  }

  // Step 8 — TypeScript validation
  console.log('\nRunning TypeScript check...');
  try {
    execSync('npx tsc --noEmit', { cwd: PROJECT_DIR, stdio: 'pipe' });
    console.log('TypeScript: ✓ no errors\n');
  } catch (err) {
    console.error('\nTypeScript errors detected:');
    console.error(err.stdout?.toString() || err.stderr?.toString() || err.message);
    console.error('\nPlease fix TypeScript errors before committing.\n');
  }

  // Step 8b — Consistency check: find components in src/components/ that are
  // used in some files but not in others that contain semantically equivalent
  // inline markup (e.g. a CSS-only spinner where <LoadingState /> is expected).
  checkConsistency(sourceFiles);

  // Step 9 — Report
  console.log('\nextract-components — done\n');
  console.log(`Patterns extracted: ${extractedComponents.length}\n`);
  for (const comp of extractedComponents) {
    const filesLabel = comp.pattern.files.map(f => path.relative(PROJECT_DIR, f)).join(', ');
    console.log(`  ${comp.name} (${path.relative(PROJECT_DIR, comp.path)})`);
    console.log(`    ${comp.pattern.occurrences} occurrences replaced  →  ${filesLabel}`);
    console.log(`    Props: ${comp.props.map(p => `${p.name}: ${p.type}`).join(', ')}`);
    console.log(`    Lines in source: ${comp.linesRemoved}`);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Step 8b — Consistency check
// ---------------------------------------------------------------------------

/**
 * For each component in outputDir, find files that import it and files that
 * don't — then check whether non-importing files contain inline markup that
 * looks semantically equivalent (same root tag + overlapping className tokens).
 * Reports suspects so the developer can decide whether to replace them.
 */
function checkConsistency(sourceFiles) {
  const absOutputDir = path.resolve(PROJECT_DIR, OUTPUT_DIR);
  if (!fs.existsSync(absOutputDir)) return;

  const componentFiles = fs.readdirSync(absOutputDir)
    .filter(f => f.endsWith('.tsx') && !f.includes('.test.'))
    .map(f => ({
      name: f.replace('.tsx', ''),
      path: path.join(absOutputDir, f),
      src: fs.readFileSync(path.join(absOutputDir, f), 'utf8'),
    }));

  if (componentFiles.length === 0) return;

  const suspects = [];

  for (const comp of componentFiles) {
    // Extract the root tag and significant className tokens from the component body
    const rootTagMatch = comp.src.match(/return \(\s*\n?\s*<(\w+)/);
    if (!rootTagMatch) continue;
    const rootTag = rootTagMatch[1];

    // Collect className values from the component
    const classNames = [...comp.src.matchAll(/className="([^"]+)"/g)].map(m => m[1]);
    if (classNames.length === 0) continue;

    // Significant tokens: words longer than 3 chars, not utility prefixes
    const sigTokens = classNames.flatMap(cn =>
      cn.split(/\s+/).filter(t => t.length > 3 && !t.match(/^(dark|hover|focus|active|group|peer|sm:|md:|lg:)/) )
    ).slice(0, 5); // top 5 most distinctive tokens

    if (sigTokens.length === 0) continue;

    // Files that already import this component
    const importers = new Set(
      sourceFiles
        .filter(sf => sf.getFullText().includes(`from`) && sf.getFullText().includes(`'${comp.name}'`) || sf.getFullText().includes(`"${comp.name}"`))
        .map(sf => sf.getFilePath())
    );

    // Check non-importing files for inline markup with the same root tag + tokens
    for (const sf of sourceFiles) {
      const filePath = sf.getFilePath();
      if (importers.has(filePath)) continue;
      if (filePath.includes(absOutputDir)) continue;

      const text = sf.getFullText();
      if (!text.includes(`<${rootTag}`) && !text.includes(`<${rootTag.toLowerCase()}`)) continue;

      // Check if any significant className token appears in the file
      const matchingTokens = sigTokens.filter(t => text.includes(t));
      if (matchingTokens.length >= Math.min(2, sigTokens.length)) {
        suspects.push({
          component: comp.name,
          file: path.relative(PROJECT_DIR, filePath),
          tokens: matchingTokens,
        });
      }
    }
  }

  if (suspects.length === 0) return;

  console.log('\n⚠  Consistency warnings — possible missed usages:\n');
  for (const s of suspects) {
    console.log(`  ${s.file}`);
    console.log(`    May have inline markup that should use <${s.component} /> (matched: ${s.tokens.join(', ')})`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Build component call JSX from an occurrence node
// ---------------------------------------------------------------------------

/**
 * Build the replacement JSX call for one occurrence.
 * Uses the same slot ordering as analyzePattern, so nested prop values
 * (e.g. xClassName from a child element) are found correctly.
 */
function buildComponentCall(node, componentName, props, analysisResult) {
  if (props.length === 0) {
    return `<${componentName} />`;
  }

  const { fixedSlots } = analysisResult;
  const occSlots = collectLeafValues(node);

  // Map prop names → raw value strings from this occurrence
  const propValues = {};
  for (let i = 0; i < occSlots.length; i++) {
    const resolution = fixedSlots.get(i);
    if (resolution && resolution.startsWith('PROP:')) {
      const propName = resolution.slice(5);
      propValues[propName] = occSlots[i].raw; // e.g. '"some text"' or '{expr}'
    }
  }

  const childrenProp = props.find(p => p.name === 'children');
  const nonChildProps = props.filter(p => p.name !== 'children');

  const attrParts = nonChildProps.map(p => {
    const raw = propValues[p.name];
    if (raw === undefined) return `${p.name}={/* TODO */}`;
    // raw is either a string literal (with quotes) or {expression} or plain text
    if (raw.startsWith('"') || raw.startsWith("'")) {
      // String attribute: keep quotes
      return `${p.name}=${raw}`;
    }
    if (raw.startsWith('{')) {
      // JSX expression attribute
      return `${p.name}=${raw}`;
    }
    // Plain text (text node content) → use as string attribute
    return `${p.name}="${raw.replace(/"/g, '\\"')}"`;
  });

  const propsStr = attrParts.length > 0 ? ' ' + attrParts.join(' ') : '';

  if (!childrenProp) {
    return `<${componentName}${propsStr} />`;
  }

  const childRaw = propValues['children'];
  if (!childRaw) {
    return `<${componentName}${propsStr} />`;
  }

  // Render children content
  let childContent;
  if (childrenProp.type === 'string') {
    // Text content — use as JSX text
    const text = childRaw.startsWith('"') || childRaw.startsWith("'")
      ? childRaw.slice(1, -1)
      : childRaw;
    childContent = text;
  } else if (childRaw.startsWith('{')) {
    // ReactNode expression
    childContent = childRaw;
  } else {
    childContent = childRaw;
  }

  return `<${componentName}${propsStr}>${childContent}</${componentName}>`;
}

/** Compute relative import path from source file to component file */
function computeRelativeImport(fromFile, toFile) {
  const rel = path.relative(path.dirname(fromFile), toFile);
  const withoutExt = rel.replace(/\.tsx?$/, '');
  return withoutExt.startsWith('.') ? withoutExt : './' + withoutExt;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
