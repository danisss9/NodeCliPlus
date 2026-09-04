import * as ts from 'typescript';
import * as fs from 'fs';

/**
 * Node.js-oriented memory-leak detection. Recognised patterns:
 *  - nested `.subscribe()` callbacks (RxJS)
 *  - subscriptions stored on `this` but never `.unsubscribe()`d
 *  - `setInterval`/`setTimeout` return values never cleared
 *  - `addEventListener` / EventEmitter `.on()` without a matching removal
 *  - DOM query results stored on `this` and never nulled
 *  - Subjects used in `takeUntil()` but never completed
 *
 * A key is considered cleaned up when the matching cleanup call appears
 * *anywhere in the same file* — long-running Node services typically tear
 * down in `close()` / `dispose()` / `stop()` methods of the same module.
 */
export type MemoryLeakKind =
  | 'nested-subscribe'
  | 'unremoved-subscription'
  | 'uncleared-interval'
  | 'uncleared-timeout'
  | 'unremoved-event-listener'
  | 'retained-dom-reference'
  | 'incomplete-takeuntil-subject';

export interface MemoryLeakLocation {
  file: string;
  line: number;
  character: number;
  snippet: string;
  kind: MemoryLeakKind;
}

/** Returns the snippet text for the line containing `pos` in `source`. */
function snippetAt(source: string, pos: number): string {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = source.indexOf('\n', pos);
  return source.substring(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
}

/**
 * Serialises an expression to a stable string key used to match a storage
 * target against its cleanup call.
 *   this.intervalId  →  "this.intervalId"
 *   localVar         →  "localVar"
 */
function expressionToKey(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return `this.${expr.name.text}`;
  }
  return null;
}

/**
 * Builds a map of function/method name → body nodes from all declarations
 * in the source file. Used for inter-procedural nested-subscribe detection.
 */
function buildFunctionBodyMap(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const map = new Map<string, ts.Node>();

  function collect(node: ts.Node): void {
    // Method declarations inside a class
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.body) {
      map.set(node.name.text, node.body);
    }
    // Top-level / nested function declarations
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      map.set(node.name.text, node.body);
    }
    // Arrow / function expression assigned to a variable or property
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body
    ) {
      map.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, collect);
  }

  collect(sourceFile);
  return map;
}

const MAX_TRAVERSE_DEPTH = 10;

/**
 * Returns true if `node` contains a `.subscribe(...)` call anywhere in its
 * subtree, following `this.method()` / `method()` call sites into their
 * declared bodies up to MAX_TRAVERSE_DEPTH levels deep.
 */
function containsNestedSubscribe(
  node: ts.Node,
  bodyMap: Map<string, ts.Node>,
  depth: number,
  visited: Set<string>,
): boolean {
  let found = false;

  function walk(n: ts.Node): void {
    if (found) {
      return;
    }

    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'subscribe'
    ) {
      found = true;
      return;
    }

    // Follow this.method() or method() calls into their bodies
    if (!found && depth < MAX_TRAVERSE_DEPTH && ts.isCallExpression(n)) {
      const calleeName = resolveCalleeName(n);
      if (calleeName && !visited.has(calleeName)) {
        const body = bodyMap.get(calleeName);
        if (body) {
          visited.add(calleeName);
          if (containsNestedSubscribe(body, bodyMap, depth + 1, visited)) {
            found = true;
            return;
          }
        }
      }
    }

    ts.forEachChild(n, walk);
  }

  walk(node);
  return found;
}

/** Extracts the method/function name from a call expression, if resolvable. */
function resolveCalleeName(call: ts.CallExpression): string | null {
  const expr = call.expression;
  // this.method()
  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return expr.name.text;
  }
  // Plain method() call
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  return null;
}

/** Visits every node in the file, invoking `collector` on each. */
function walkAll(sourceFile: ts.SourceFile, collector: (n: ts.Node) => void): void {
  function visit(node: ts.Node): void {
    collector(node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

// ── Cleanup-key collectors (file-wide) ─────────────────────────────────────────

/** Keys passed to `clearInterval(...)` anywhere in the file. */
function collectClearedKeys(sourceFile: ts.SourceFile, fnName: string): Set<string> {
  const keys = new Set<string>();
  walkAll(sourceFile, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === fnName &&
      n.arguments.length > 0
    ) {
      const key = expressionToKey(n.arguments[0] as ts.Expression);
      if (key) {
        keys.add(key);
      }
    }
  });
  return keys;
}

/** `this.x` / `x` keys on which `.unsubscribe()` is called anywhere in the file. */
function collectUnsubscribedKeys(sourceFile: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  walkAll(sourceFile, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      if (n.expression.name.text === 'unsubscribe') {
        const key = expressionToKey(n.expression.expression);
        if (key) {
          keys.add(key);
        }
      }
    }
  });
  return keys;
}

/** `this.x` keys that are assigned `null` anywhere in the file. */
function collectNulledKeys(sourceFile: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  walkAll(sourceFile, (n) => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      n.right.kind === ts.SyntaxKind.NullKeyword
    ) {
      const key = expressionToKey(n.left as ts.Expression);
      if (key) {
        keys.add(key);
      }
    }
  });
  return keys;
}

/** `this.x` / `x` keys on which `.next()` or `.complete()` is called anywhere in the file. */
function collectCompletedSubjectKeys(sourceFile: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  walkAll(sourceFile, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const methodName = n.expression.name.text;
      if (methodName === 'next' || methodName === 'complete') {
        const key = expressionToKey(n.expression.expression as ts.Expression);
        if (key) {
          keys.add(key);
        }
      }
    }
  });
  return keys;
}

// ── Event listener keys ────────────────────────────────────────────────────────

const LISTENER_ADD_METHODS = new Set(['addEventListener', 'on', 'addListener']);
const LISTENER_REMOVE_METHODS = new Set(['removeEventListener', 'off', 'removeListener']);

/**
 * Serialises an add/remove listener argument pair (event name + handler) into
 * a stable key for matching.
 *   this.onScroll          → "this.onScroll"
 *   someVar                → "someVar"
 *   inline arrow/function  → null  (always flagged, can never be matched)
 */
function listenerKey(eventArg: ts.Expression, handlerArg: ts.Expression): string | null {
  // Event name must be a string literal
  if (!ts.isStringLiteral(eventArg)) {
    return null;
  }
  const handlerKey = expressionToKey(handlerArg);
  if (handlerKey === null) {
    // Inline function — unfixable without restructuring, always flag
    return `${eventArg.text}:<<inline>>`;
  }
  return `${eventArg.text}:${handlerKey}`;
}

/** Listener keys removed via removeEventListener/off/removeListener anywhere in the file. */
function collectRemovedListenerKeys(sourceFile: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  walkAll(sourceFile, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      LISTENER_REMOVE_METHODS.has(n.expression.name.text) &&
      n.arguments.length >= 2
    ) {
      const key = listenerKey(n.arguments[0] as ts.Expression, n.arguments[1] as ts.Expression);
      if (key) {
        keys.add(key);
      }
    }
  });
  return keys;
}

// ── DOM reference detection ────────────────────────────────────────────────────

const DOM_QUERY_METHODS = new Set([
  'getElementById',
  'querySelector',
  'querySelectorAll',
  'getElementsByClassName',
  'getElementsByTagName',
  'getElementsByName',
]);

// ── Subject detection ──────────────────────────────────────────────────────────

const SUBJECT_CONSTRUCTORS = new Set([
  'Subject',
  'BehaviorSubject',
  'ReplaySubject',
  'AsyncSubject',
]);

/** Returns the set of keys that appear as the argument to `takeUntil(key)` anywhere in the file. */
function findSubjectsUsedInTakeUntil(sourceFile: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  walkAll(sourceFile, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'takeUntil' &&
      n.arguments.length === 1
    ) {
      const key = expressionToKey(n.arguments[0] as ts.Expression);
      if (key) {
        keys.add(key);
      }
    }
  });
  return keys;
}

// ── Main entry point ───────────────────────────────────────────────────────────

export function findMemoryLeaksInFile(filePath: string): MemoryLeakLocation[] {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const results: MemoryLeakLocation[] = [];

  const push = (node: ts.Node, kind: MemoryLeakKind) => {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    results.push({
      file: filePath,
      line: pos.line + 1,
      character: pos.character + 1,
      snippet: snippetAt(source, node.getStart()),
      kind,
    });
  };

  // ── Nested subscribes ─────────────────────────────────────────────────────
  const bodyMap = buildFunctionBodyMap(sourceFile);
  walkAll(sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'subscribe'
    ) {
      // Check each callback argument for an inner .subscribe()
      for (const arg of node.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          if (containsNestedSubscribe(arg, bodyMap, 0, new Set())) {
            push(node, 'nested-subscribe');
            break;
          }
        }
      }
    }
  });

  // ── Subscriptions stored but never unsubscribed ───────────────────────────
  const unsubscribedKeys = collectUnsubscribedKeys(sourceFile);
  walkAll(sourceFile, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isCallExpression(node.right) &&
      ts.isPropertyAccessExpression(node.right.expression) &&
      node.right.expression.name.text === 'subscribe'
    ) {
      const key = expressionToKey(node.left as ts.Expression);
      if (key && !unsubscribedKeys.has(key)) {
        push(node.right, 'unremoved-subscription');
      }
    }
  });

  // ── Uncleared intervals & timeouts ────────────────────────────────────────
  const clearedIntervalKeys = collectClearedKeys(sourceFile, 'clearInterval');
  const clearedTimeoutKeys = collectClearedKeys(sourceFile, 'clearTimeout');

  walkAll(sourceFile, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fnName = node.expression.text;
      if (fnName !== 'setInterval' && fnName !== 'setTimeout') {
        return;
      }

      let storedAs: string | null = null;
      const parent = node.parent;

      // this.x = setInterval(...) or x = setInterval(...)
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === node
      ) {
        storedAs = expressionToKey(parent.left as ts.Expression);
      }
      // const/let/var x = setInterval(...)
      else if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
        if (ts.isIdentifier(parent.name)) {
          storedAs = parent.name.text;
        }
      }

      if (storedAs === null) {
        return; // bare call — not trackable
      }

      const cleared =
        fnName === 'setInterval'
          ? clearedIntervalKeys.has(storedAs)
          : clearedTimeoutKeys.has(storedAs);
      if (!cleared) {
        push(node, fnName === 'setInterval' ? 'uncleared-interval' : 'uncleared-timeout');
      }
    }
  });

  // ── Unremoved event listeners ─────────────────────────────────────────────
  const removedListenerKeys = collectRemovedListenerKeys(sourceFile);
  walkAll(sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LISTENER_ADD_METHODS.has(node.expression.name.text) &&
      node.arguments.length >= 2
    ) {
      const key = listenerKey(
        node.arguments[0] as ts.Expression,
        node.arguments[1] as ts.Expression,
      );
      if (key && !removedListenerKeys.has(key)) {
        push(node, 'unremoved-event-listener');
      }
    }
  });

  // ── Retained DOM references ───────────────────────────────────────────────
  const nulledKeys = collectNulledKeys(sourceFile);
  walkAll(sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'document' &&
      DOM_QUERY_METHODS.has(node.expression.name.text)
    ) {
      // The call might be wrapped in a non-null assertion: document.getElementById(...)!
      let parent = node.parent;
      if (ts.isNonNullExpression(parent)) {
        parent = parent.parent;
      }
      // Must be assigned to this.x
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const key = expressionToKey(parent.left as ts.Expression);
        if (key && key.startsWith('this.') && !nulledKeys.has(key)) {
          push(node, 'retained-dom-reference');
        }
      }
    }
  });

  // ── takeUntil Subjects never completed ────────────────────────────────────
  const takeUntilKeys = findSubjectsUsedInTakeUntil(sourceFile);
  if (takeUntilKeys.size > 0) {
    const completedSubjectKeys = collectCompletedSubjectKeys(sourceFile);
    walkAll(sourceFile, (node) => {
      // Class property initializer: private destroy$ = new Subject<void>()
      if (
        ts.isPropertyDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isNewExpression(node.initializer)
      ) {
        const key = `this.${node.name.text}`;
        if (
          ts.isIdentifier(node.initializer.expression) &&
          SUBJECT_CONSTRUCTORS.has(node.initializer.expression.text) &&
          takeUntilKeys.has(key) &&
          !completedSubjectKeys.has(key)
        ) {
          push(node.initializer, 'incomplete-takeuntil-subject');
        }
      }

      // Assignment in constructor / method: this.destroy$ = new Subject()
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isNewExpression(node.right)
      ) {
        const key = expressionToKey(node.left as ts.Expression);
        if (
          key &&
          ts.isIdentifier(node.right.expression) &&
          SUBJECT_CONSTRUCTORS.has(node.right.expression.text) &&
          takeUntilKeys.has(key) &&
          !completedSubjectKeys.has(key)
        ) {
          push(node.right, 'incomplete-takeuntil-subject');
        }
      }
    });
  }

  // Sort by line for a clean presentation
  results.sort((a, b) => a.line - b.line);

  return results;
}
