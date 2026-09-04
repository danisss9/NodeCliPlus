/**
 * Surgical editing of ESLint flat/legacy config files written in JavaScript or
 * TypeScript (`eslint.config.js/.mjs/.cjs/.ts`, `.eslintrc.js/.cjs`). These can't
 * be edited as JSON, so a rule's severity is changed by locating the `rules`
 * object literal with the TypeScript AST and splicing just the severity slot —
 * everything else in the file (comments, formatting) is preserved.
 */
import * as fs from 'fs';
import * as ts from 'typescript';
import { logDiagnostic } from './state';

type Severity = 'off' | 'warn' | 'error';

interface EditResult {
  ok: boolean;
  /** When false, a short reason suitable for a user-facing message. */
  reason?: string;
}

export type { Severity };

/**
 * File extensions this module can read/edit. Covers flat config
 * (`eslint.config.js/.mjs/.cjs/.ts`) and legacy `.eslintrc.js/.cjs`.
 */
const JS_CONFIG_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

/** True for ESLint config files this module can surgically edit (JS/TS, not JSON). */
export function isJsEslintConfig(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  if (!JS_CONFIG_EXTENSIONS.has(ext)) {
    return false;
  }
  const base = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  return base.startsWith('eslint.config') || base.startsWith('.eslintrc.');
}

/**
 * Reads the rule severities declared in a JS/TS ESLint config by walking the
 * AST. Returns a map of `ruleName -> severity`. Only statically-analyzable
 * entries are returned — computed/spread rules are skipped (those are still
 * picked up at runtime by `eslint --print-config` in the editor).
 */
export function readFlatConfigRules(filePath: string): Map<string, Severity> {
  const map = new Map<string, Severity>();
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return map;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  );

  for (const block of findRulesBlocks(sourceFile)) {
    for (const prop of block.rulesObj.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        continue;
      }
      const name = propertyKeyText(prop.name);
      if (!name) {
        continue;
      }
      const severity = severityOfInitializer(prop.initializer);
      if (severity) {
        map.set(name, severity);
      }
    }
  }
  return map;
}

/** Resolves a rule value initializer (`'error'`, `2`, `['warn', {...}]`) to a Severity. */
function severityOfInitializer(init: ts.Expression): Severity | null {
  const value =
    ts.isArrayLiteralExpression(init) && init.elements.length > 0 ? init.elements[0] : init;

  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return severityFromString(value.text);
  }
  if (ts.isNumericLiteral(value)) {
    return severityFromNumber(value.text);
  }
  return null;
}

function severityFromString(text: string): Severity | null {
  if (text === 'error' || text === '2') {
    return 'error';
  }
  if (text === 'warn' || text === '1') {
    return 'warn';
  }
  if (text === 'off' || text === '0') {
    return 'off';
  }
  return null;
}

function severityFromNumber(text: string): Severity | null {
  if (text === '2') {
    return 'error';
  }
  if (text === '1') {
    return 'warn';
  }
  if (text === '0') {
    return 'off';
  }
  return null;
}

export function setFlatConfigRuleSeverity(
  filePath: string,
  ruleName: string,
  severity: Severity,
): EditResult {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { ok: false, reason: 'Could not read the config file.' };
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  );

  const rulesBlocks = findRulesBlocks(sourceFile);
  if (rulesBlocks.length === 0) {
    return {
      ok: false,
      reason: 'No `rules` block found to edit. Add a `rules: {}` to the config and reload.',
    };
  }

  const quote = detectQuote(text);

  // Prefer editing an existing entry for this rule (search last block first,
  // matching how the JSON editor targets the last config block).
  for (const block of [...rulesBlocks].reverse()) {
    const prop = findRuleProperty(block.rulesObj, ruleName);
    if (prop) {
      const updated = replaceSeverity(text, prop, severity, quote);
      return write(filePath, updated);
    }
  }

  // Otherwise insert a new entry into the last block that applies to TypeScript
  // files (or is unscoped) so the new rule doesn't land in a block whose `files`
  // glob wouldn't cover the files it's meant for.
  const target = pickTargetBlock(rulesBlocks);
  const updated = insertRule(text, sourceFile, target, ruleName, severity, quote);
  return write(filePath, updated);
}

// ── AST helpers ────────────────────────────────────────────────────────────────

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (/\.[cm]?ts$/.test(filePath)) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

interface RulesBlock {
  rulesObj: ts.ObjectLiteralExpression;
  /** `files` glob patterns for this config block, or `null` when unscoped (applies to all files). */
  filesPatterns: string[] | null;
}

/** Collects every config-object literal containing a `rules: { … }` property, along with its `files` scope, in source order. */
function findRulesBlocks(sourceFile: ts.SourceFile): RulesBlock[] {
  const found: RulesBlock[] = [];
  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      let rulesObj: ts.ObjectLiteralExpression | null = null;
      let filesPatterns: string[] | null = null;
      let hasFilesProp = false;
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) {
          continue;
        }
        const key = propertyKeyText(prop.name);
        if (key === 'rules' && ts.isObjectLiteralExpression(prop.initializer)) {
          rulesObj = prop.initializer;
        } else if (key === 'files' && ts.isArrayLiteralExpression(prop.initializer)) {
          hasFilesProp = true;
          filesPatterns = prop.initializer.elements
            .filter((e): e is ts.StringLiteral => ts.isStringLiteral(e))
            .map((e) => e.text);
        }
      }
      if (rulesObj) {
        found.push({ rulesObj, filesPatterns: hasFilesProp ? filesPatterns : null });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/** True when a block's `files` scope plausibly covers TypeScript files (or the block is unscoped). */
function blockAppliesToTs(block: RulesBlock): boolean {
  if (block.filesPatterns === null) {
    return true;
  }
  return block.filesPatterns.some((p) => p.includes('ts'));
}

/** Picks the last block that applies to TypeScript, falling back to the last block overall. */
function pickTargetBlock(blocks: RulesBlock[]): ts.ObjectLiteralExpression {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blockAppliesToTs(blocks[i])) {
      return blocks[i].rulesObj;
    }
  }
  return blocks[blocks.length - 1].rulesObj;
}

/** Returns the static key of a property name, or null when computed. */
function propertyKeyText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function findRuleProperty(
  obj: ts.ObjectLiteralExpression,
  ruleName: string,
): ts.PropertyAssignment | null {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && propertyKeyText(prop.name) === ruleName) {
      return prop;
    }
  }
  return null;
}

/**
 * Replaces the severity of an existing rule. If the value is an array
 * (`['error', { … }]`), only element 0 is replaced so options are preserved;
 * otherwise the whole value is replaced.
 */
function replaceSeverity(
  text: string,
  prop: ts.PropertyAssignment,
  severity: Severity,
  quote: string,
): string {
  const init = prop.initializer;
  const literal = `${quote}${severity}${quote}`;

  if (ts.isArrayLiteralExpression(init) && init.elements.length > 0) {
    const first = init.elements[0];
    return splice(text, first.getStart(), first.getEnd(), literal);
  }
  return splice(text, init.getStart(), init.getEnd(), literal);
}

/** Inserts a new `'<rule>': '<severity>',` entry right after the `{`. */
function insertRule(
  text: string,
  sourceFile: ts.SourceFile,
  obj: ts.ObjectLiteralExpression,
  ruleName: string,
  severity: Severity,
  quote: string,
): string {
  const indent =
    obj.properties.length > 0
      ? lineIndentOf(text, obj.properties[0].getStart(sourceFile))
      : lineIndentOf(text, obj.getStart(sourceFile)) + '  ';

  const entry = `\n${indent}${quote}${ruleName}${quote}: ${quote}${severity}${quote},`;
  const insertAt = obj.getStart(sourceFile) + 1; // just after the opening brace
  return text.slice(0, insertAt) + entry + text.slice(insertAt);
}

// ── Text helpers ─────────────────────────────────────────────────────────────

function splice(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

function lineIndentOf(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  let i = lineStart;
  let ws = '';
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    ws += text[i];
    i++;
  }
  return ws;
}

/**
 * Picks the quote style used most often in the file (defaults to single).
 * Line comments are stripped first so stray apostrophes in prose (e.g. `// don't`)
 * don't skew the count away from the file's actual code style.
 */
function detectQuote(text: string): string {
  const withoutLineComments = text.replace(/\/\/[^\n]*/g, '');
  const singles = (withoutLineComments.match(/'/g) ?? []).length;
  const doubles = (withoutLineComments.match(/"/g) ?? []).length;
  return doubles > singles ? '"' : "'";
}

function write(filePath: string, content: string): EditResult {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true };
  } catch (err) {
    logDiagnostic(`Failed to write ESLint config ${filePath}: ${err}`);
    return { ok: false, reason: 'Could not write the config file.' };
  }
}
