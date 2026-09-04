/**
 * ESLint config editor webview. Discovers the available rule catalog from the
 * installed ESLint plugins (best-effort, via dynamic import of the workspace
 * modules) and the currently-applied severities (via `eslint --print-config`),
 * then lets the user toggle each rule off/warn/error. Edits are written back to
 * the config with comments preserved — JSON configs via the JSONC editor, and
 * JS/TS configs (`eslint.config.js/.mjs/.cjs/.ts`, `.eslintrc.js/.cjs`) via a
 * surgical AST splice that preserves formatting and rule options.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { spawnCapture } from './dependencies';
import { resolveEslintSpawn, quoteShellPath } from './utils';
import { readJsonc, setKey } from './jsonc-io';
import { logDiagnostic } from './state';
import { escapeHtml, baseStyles } from './webview-utils';
import { isJsEslintConfig, readFlatConfigRules, setFlatConfigRuleSeverity } from './eslint-js-edit';
import { isPathInside, extractJsonObject } from './pure-utils';

type Severity = 'off' | 'warn' | 'error';

interface RuleInfo {
  name: string;
  severity: Severity;
  /** Whether the rule is explicitly present in the resolved config. */
  configured: boolean;
}

interface RuleGroup {
  id: string;
  label: string;
  rules: RuleInfo[];
}

interface WebviewMessage {
  command: string;
  rule?: string;
  severity?: Severity;
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function showEslintEditor(filePath: string, workspaceRoot: string): Promise<void> {
  const groups = await discoverRules(workspaceRoot, filePath);
  showWebview(filePath, workspaceRoot, groups);
}

// ── Rule discovery ─────────────────────────────────────────────────────────────

async function discoverRules(workspaceRoot: string, filePath: string): Promise<RuleGroup[]> {
  let severities = new Map<string, Severity>();
  const catalog = new Map<string, RuleInfo>();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Reading ESLint rules…',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'resolving configured rules…' });
      severities = await readConfiguredSeverities(workspaceRoot, filePath);

      progress.report({ message: 'reading plugin rule catalogs…' });
      const plugins = detectPluginPackages(workspaceRoot);
      for (const plugin of plugins) {
        const ruleNames = await loadPluginRuleNames(workspaceRoot, plugin);
        for (const name of ruleNames) {
          if (!catalog.has(name)) {
            catalog.set(name, {
              name,
              severity: severities.get(name) ?? 'off',
              configured: severities.has(name),
            });
          }
        }
      }
    },
  );

  // Include any configured rule whose plugin could not be loaded.
  for (const [name, severity] of severities) {
    if (!catalog.has(name)) {
      catalog.set(name, { name, severity, configured: true });
    }
  }

  return groupRules([...catalog.values()]);
}

/** Runs `eslint --print-config` against a representative file to read severities. */
async function readConfiguredSeverities(
  workspaceRoot: string,
  filePath: string,
): Promise<Map<string, Severity>> {
  const map = new Map<string, Severity>();
  const repFile = await findRepresentativeFile(workspaceRoot);
  if (repFile) {
    const cmd = resolveEslintSpawn(workspaceRoot, ['--print-config', quoteShellPath(repFile)]);
    const result = await spawnCapture(cmd.command, cmd.args, workspaceRoot, cmd.shell);
    const json = extractJsonObject(result.stdout);
    if (json !== null) {
      try {
        const config = JSON.parse(json) as { rules?: Record<string, unknown> };
        for (const [name, value] of Object.entries(config.rules ?? {})) {
          map.set(name, normalizeSeverity(value));
        }
        if (map.size > 0) {
          return map;
        }
      } catch {
        // fall through to AST read below
      }
    }
  }

  // Fallback: statically read severities from a JS/TS config file. This covers
  // offline/no-ESLint-runnable scenarios and entries that --print-config missed.
  if (isJsEslintConfig(filePath)) {
    for (const [name, severity] of readFlatConfigRules(filePath)) {
      if (!map.has(name)) {
        map.set(name, severity);
      }
    }
  }
  return map;
}

function normalizeSeverity(value: unknown): Severity {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === 2 || raw === '2' || raw === 'error') {
    return 'error';
  }
  if (raw === 1 || raw === '1' || raw === 'warn') {
    return 'warn';
  }
  return 'off';
}

/** Picks a `.ts` file ESLint can resolve a config for. */
async function findRepresentativeFile(workspaceRoot: string): Promise<string | null> {
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (
    active &&
    active.endsWith('.ts') &&
    isPathInside(workspaceRoot, active) &&
    fs.existsSync(active)
  ) {
    return active;
  }
  for (const candidate of ['src/main.ts', 'src/index.ts', 'main.ts', 'index.ts']) {
    const full = path.join(workspaceRoot, candidate);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceRoot, '**/*.ts'),
    '**/node_modules/**',
    1,
  );
  return found[0]?.fsPath ?? null;
}

// ── Plugin loading ─────────────────────────────────────────────────────────────

interface PluginPackage {
  pkg: string;
  /** Rule-name prefix, e.g. `@typescript-eslint` or `import`. Empty for core. */
  prefix: string;
}

/** Reads workspace dependencies and maps ESLint plugins to their rule prefixes. */
function detectPluginPackages(workspaceRoot: string): PluginPackage[] {
  const deps = readAllDependencies(workspaceRoot);
  const plugins: PluginPackage[] = [{ pkg: 'eslint', prefix: '' }];

  for (const name of Object.keys(deps)) {
    const prefix = pluginPrefix(name);
    if (prefix !== null) {
      plugins.push({ pkg: name, prefix });
    }
  }

  // The `typescript-eslint` umbrella re-exports the plugin under `.plugin`.
  if (deps['typescript-eslint'] && !deps['@typescript-eslint/eslint-plugin']) {
    plugins.push({ pkg: 'typescript-eslint', prefix: '@typescript-eslint' });
  }
  return plugins;
}

/**
 * Derives the ESLint rule prefix from a package name, or `null` if the package
 * is not an ESLint plugin. Follows ESLint's naming convention:
 *  - `eslint-plugin-foo`            → `foo`
 *  - `@scope/eslint-plugin`         → `@scope`
 *  - `@scope/eslint-plugin-bar`     → `@scope/bar`
 */
function pluginPrefix(pkg: string): string | null {
  if (pkg.startsWith('@')) {
    const [scope, rest] = pkg.split('/');
    if (rest === 'eslint-plugin') {
      return scope;
    }
    if (rest?.startsWith('eslint-plugin-')) {
      return `${scope}/${rest.slice('eslint-plugin-'.length)}`;
    }
    return null;
  }
  if (pkg.startsWith('eslint-plugin-')) {
    return pkg.slice('eslint-plugin-'.length);
  }
  return null;
}

/** Best-effort load of a plugin's rule names, prefixed for matching. */
async function loadPluginRuleNames(
  workspaceRoot: string,
  plugin: PluginPackage,
): Promise<string[]> {
  try {
    const requireFromWorkspace = createRequire(path.join(workspaceRoot, 'noop.js'));

    if (plugin.pkg === 'eslint') {
      const resolved = requireFromWorkspace.resolve('eslint/use-at-your-own-risk');
      const mod = (await import(pathToFileURL(resolved).href)) as {
        builtinRules?: Map<string, unknown>;
        default?: { builtinRules?: Map<string, unknown> };
      };
      const builtin = mod.builtinRules ?? mod.default?.builtinRules;
      return builtin ? [...builtin.keys()] : [];
    }

    const resolved = requireFromWorkspace.resolve(plugin.pkg);
    const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
    const rules = extractRulesObject(mod);
    if (!rules) {
      return [];
    }
    return Object.keys(rules).map((r) => (plugin.prefix ? `${plugin.prefix}/${r}` : r));
  } catch (err) {
    logDiagnostic(`Could not load ESLint plugin ${plugin.pkg}: ${err}`);
    return [];
  }
}

/** Finds the `rules` map across the common plugin export shapes. */
function extractRulesObject(mod: Record<string, unknown>): Record<string, unknown> | null {
  const candidates: unknown[] = [
    mod.rules,
    (mod.default as Record<string, unknown> | undefined)?.rules,
    (mod.plugin as Record<string, unknown> | undefined)?.rules,
    (
      (mod.default as Record<string, unknown> | undefined)?.plugin as
        | Record<string, unknown>
        | undefined
    )?.rules,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

function readAllDependencies(workspaceRoot: string): Record<string, string> {
  const all: Record<string, string> = {};
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8'),
    ) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      Object.assign(all, pkg[field] ?? {});
    }
  } catch {
    // No/unreadable package.json — no plugins detected from deps.
  }
  return all;
}

// ── Grouping ───────────────────────────────────────────────────────────────────

const GROUP_ORDER = ['eslint', '@typescript-eslint'];

function groupRules(rules: RuleInfo[]): RuleGroup[] {
  const byGroup = new Map<string, RuleInfo[]>();
  for (const rule of rules) {
    const id = groupIdFor(rule.name);
    const list = byGroup.get(id) ?? [];
    list.push(rule);
    byGroup.set(id, list);
  }

  const groups: RuleGroup[] = [...byGroup.entries()].map(([id, list]) => ({
    id,
    label: id === 'eslint' ? 'eslint (core)' : id,
    rules: list.sort((a, b) => a.name.localeCompare(b.name)),
  }));

  groups.sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a.id);
    const bi = GROUP_ORDER.indexOf(b.id);
    if (ai !== -1 || bi !== -1) {
      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
    }
    return a.id.localeCompare(b.id);
  });
  return groups;
}

function groupIdFor(ruleName: string): string {
  const lastSlash = ruleName.lastIndexOf('/');
  return lastSlash === -1 ? 'eslint' : ruleName.slice(0, lastSlash);
}

// ── Saving ─────────────────────────────────────────────────────────────────────

/**
 * Writes a rule's severity into the config. Preserves any existing options by
 * only replacing the severity slot when the current value is an array.
 * Dispatches to the AST editor for JS/TS configs and the JSONC editor for JSON.
 */
function writeRuleSeverity(filePath: string, ruleName: string, severity: Severity): boolean {
  if (isJsEslintConfig(filePath)) {
    const result = setFlatConfigRuleSeverity(filePath, ruleName, severity);
    if (!result.ok && result.reason) {
      vscode.window.showErrorMessage(result.reason);
    }
    return result.ok;
  }

  const parsed = readJsonc<unknown>(filePath);
  const rulesPath = resolveRulesPath(parsed);
  const current = getAtPath(parsed, [...rulesPath, ruleName]);

  if (Array.isArray(current)) {
    return setKey(filePath, [...rulesPath, ruleName, 0], severity);
  }
  return setKey(filePath, [...rulesPath, ruleName], severity);
}

/**
 * Returns the JSON path to the `rules` object. Flat config (`eslint.config.json`)
 * is an array of blocks, each optionally scoped by a `files` glob — writing a
 * new rule into a block whose `files` doesn't cover TypeScript would silently
 * no-op, so this prefers the last block that is either unscoped (applies to all
 * files) or whose `files` patterns look like they cover `.ts`, falling back to
 * the last block. Legacy `.eslintrc.json` uses a top-level `rules` object.
 */
function resolveRulesPath(parsed: unknown): (string | number)[] {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return [0, 'rules'];
    }
    for (let i = parsed.length - 1; i >= 0; i--) {
      const block = parsed[i];
      const files = block && typeof block === 'object' ? (block as { files?: unknown }).files : undefined;
      if (!Array.isArray(files) || files.some((f) => typeof f === 'string' && f.includes('ts'))) {
        return [i, 'rules'];
      }
    }
    return [parsed.length - 1, 'rules'];
  }
  return ['rules'];
}

function getAtPath(obj: unknown, jsonPath: (string | number)[]): unknown {
  let current: unknown = obj;
  for (const segment of jsonPath) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

// ── Webview ──────────────────────────────────────────────────────────────────

let activePanel: vscode.WebviewPanel | undefined;
let lastFilePath = '';
let lastWorkspaceRoot = '';

function showWebview(filePath: string, workspaceRoot: string, groups: RuleGroup[]): void {
  lastFilePath = filePath;
  lastWorkspaceRoot = workspaceRoot;

  const html = buildHtml(filePath, groups);
  const title = `ESLint Rules (${path.basename(filePath)})`;

  if (activePanel) {
    activePanel.title = title;
    activePanel.webview.html = html;
    activePanel.reveal(undefined, true);
  } else {
    activePanel = vscode.window.createWebviewPanel(
      'nodeEslintConfig',
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    activePanel.webview.html = html;
    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });
    activePanel.webview.onDidReceiveMessage((m: WebviewMessage) => {
      void handleMessage(m);
    });
  }
}

async function handleMessage(message: WebviewMessage): Promise<void> {
  switch (message.command) {
    case 'reload': {
      const groups = await discoverRules(lastWorkspaceRoot, lastFilePath);
      showWebview(lastFilePath, lastWorkspaceRoot, groups);
      return;
    }
    case 'setRule': {
      if (!message.rule || !message.severity) {
        return;
      }
      const ok = writeRuleSeverity(lastFilePath, message.rule, message.severity);
      if (ok) {
        vscode.window.setStatusBarMessage(`${message.rule} → ${message.severity}`, 2000);
      } else {
        vscode.window.showErrorMessage(`Failed to update ${message.rule}`);
      }
      return;
    }
  }
}

function severityOptions(selected: Severity): string {
  return (['off', 'warn', 'error'] as Severity[])
    .map((s) => `<option value="${s}"${s === selected ? ' selected' : ''}>${s}</option>`)
    .join('');
}

function ruleRow(rule: RuleInfo): string {
  return /* html */ `
    <tr class="rule-row" data-name="${escapeHtml(rule.name)}">
      <td class="opt-name">${escapeHtml(rule.name)}${
        rule.configured ? '<span class="set-dot" title="set in config"></span>' : ''
      }</td>
      <td class="sev-cell">
        <select class="sev-select sev-${rule.severity}" data-name="${escapeHtml(rule.name)}">
          ${severityOptions(rule.severity)}
        </select>
      </td>
    </tr>`;
}

function groupSection(group: RuleGroup): string {
  const configuredCount = group.rules.filter((r) => r.configured).length;
  return /* html */ `
    <details class="section" open>
      <summary class="section-header">
        <h2>${escapeHtml(group.label)}</h2>
        <span class="badge">${group.rules.length}</span>
        <span class="subtitle">${configuredCount} configured</span>
      </summary>
      <table class="opt-table">
        <tbody>${group.rules.map(ruleRow).join('')}</tbody>
      </table>
    </details>`;
}

function buildHtml(filePath: string, groups: RuleGroup[]): string {
  const total = groups.reduce((sum, g) => sum + g.rules.length, 0);
  const body =
    total === 0
      ? /* html */ `<p class="empty-note">No ESLint rules could be discovered. Ensure ESLint and its plugins are installed (run npm install), then reload.</p>`
      : groups.map(groupSection).join('');

  return /* html */ `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ESLint Rules</title>
    <style>
      ${baseStyles()}
      summary { cursor: pointer; list-style: none; }
      summary::-webkit-details-marker { display: none; }
      .section-header { display: flex; align-items: center; gap: 10px; }
      .sev-cell { width: 110px; }
      .sev-select { width: 100%; }
      .sev-off { color: var(--vscode-descriptionForeground); }
      .sev-warn { color: var(--vscode-problemsWarningIcon-foreground, #cca700); }
      .sev-error { color: var(--vscode-problemsErrorIcon-foreground, #f14c4c); }
      .set-dot { display: inline-block; width: 6px; height: 6px; margin-left: 7px; border-radius: 50%; background: var(--vscode-charts-blue, #3794ff); vertical-align: middle; }
      #filter { width: 260px; }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>ESLint Rules</h1>
      <span class="badge">${total}</span>
      <input type="text" id="filter" placeholder="Filter rules…">
      <span class="spacer"></span>
      <button id="reloadBtn">Reload</button>
    </div>
    <div class="file-path">${escapeHtml(filePath)}</div>
    <div style="height:14px"></div>
    ${body}
    <script>
      const vscode = acquireVsCodeApi();

      document.getElementById('reloadBtn').addEventListener('click', function () {
        vscode.postMessage({ command: 'reload' });
      });

      document.querySelectorAll('.sev-select').forEach(function (sel) {
        sel.addEventListener('change', function () {
          sel.className = 'sev-select sev-' + sel.value;
          vscode.postMessage({ command: 'setRule', rule: sel.getAttribute('data-name'), severity: sel.value });
        });
      });

      const filter = document.getElementById('filter');
      filter.addEventListener('input', function () {
        const q = filter.value.toLowerCase();
        document.querySelectorAll('.rule-row').forEach(function (row) {
          const name = (row.getAttribute('data-name') || '').toLowerCase();
          row.classList.toggle('hidden', q.length > 0 && name.indexOf(q) === -1);
        });
      });
    </script>
  </body>
  </html>`;
}
