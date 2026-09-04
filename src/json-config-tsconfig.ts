/**
 * tsconfig.json editor webview. Renders curated `compilerOptions` as typed
 * controls plus any extra keys present in the file, and a free-text row to add
 * arbitrary options. Edits preserve comments.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { readJsonc, setKey, removeKey } from './jsonc-io';
import { getTsconfigCatalog, OptionDef, OptionType } from './json-config-catalogs';
import { escapeHtml, baseStyles, convertValue, inferType } from './webview-utils';

interface TsConfig {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
}

interface WebviewMessage {
  command: string;
  key?: string;
  type?: OptionType;
  value?: string;
}

// ── Entry point ────────────────────────────────────────────────────────────────

export function showTsconfigEditor(filePath: string, _workspaceRoot: string): void {
  showWebview(filePath);
}

// ── Webview ──────────────────────────────────────────────────────────────────

let activePanel: vscode.WebviewPanel | undefined;
let lastFilePath = '';

function showWebview(filePath: string): void {
  lastFilePath = filePath;
  const html = buildHtml(filePath);
  const title = `tsconfig (${path.basename(filePath)})`;

  if (activePanel) {
    activePanel.title = title;
    activePanel.webview.html = html;
    activePanel.reveal(undefined, true);
  } else {
    activePanel = vscode.window.createWebviewPanel('nodeTsconfig', title, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
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
    case 'reload':
      showWebview(lastFilePath);
      return;
    case 'removeOption': {
      if (!message.key) {
        return;
      }
      removeKey(lastFilePath, ['compilerOptions', message.key]);
      showWebview(lastFilePath);
      return;
    }
    case 'setOption':
    case 'addOption': {
      if (!message.key || !message.type) {
        return;
      }
      const value = convertValue(message.type, message.value ?? '');
      if (value === undefined) {
        vscode.window.showErrorMessage(`Invalid value for ${message.key}`);
        return;
      }
      const ok = setKey(lastFilePath, ['compilerOptions', message.key], value);
      if (ok) {
        vscode.window.setStatusBarMessage(`Saved ${message.key}`, 2000);
      } else {
        vscode.window.showErrorMessage(`Failed to save ${message.key}`);
      }
      if (message.command === 'addOption') {
        showWebview(lastFilePath);
      }
      return;
    }
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function valueControl(def: OptionDef, value: unknown, present: boolean): string {
  const data = `data-key="${escapeHtml(def.key)}" data-type="${def.type}"`;
  switch (def.type) {
    case 'boolean': {
      const v = present ? String(value) : 'true';
      return `<select class="opt-value" ${data}>
          <option value="true"${v === 'true' ? ' selected' : ''}>true</option>
          <option value="false"${v === 'false' ? ' selected' : ''}>false</option>
        </select>`;
    }
    case 'enum': {
      const opts = (def.enum ?? [])
        .map((e) => `<option value="${escapeHtml(e)}"${e === value ? ' selected' : ''}>${escapeHtml(e)}</option>`)
        .join('');
      return `<select class="opt-value" ${data}>${opts}</select>`;
    }
    case 'number':
      return `<input type="number" class="opt-value" ${data} value="${present ? escapeHtml(String(value)) : ''}" placeholder="${escapeHtml(def.placeholder ?? '')}">`;
    case 'array': {
      const text = Array.isArray(value) ? (value as unknown[]).join(', ') : '';
      return `<input type="text" class="opt-value" ${data} value="${escapeHtml(text)}" placeholder="comma-separated or JSON array">`;
    }
    default:
      return `<input type="text" class="opt-value" ${data} value="${present ? escapeHtml(String(value)) : ''}" placeholder="${escapeHtml(def.placeholder ?? '')}">`;
  }
}

function optionRow(def: OptionDef, value: unknown, present: boolean): string {
  if (def.type === 'readonly') {
    return /* html */ `
      <tr>
        <td class="toggle-cell"></td>
        <td class="opt-name">${escapeHtml(def.key)}<div class="opt-doc">${escapeHtml(def.doc ?? 'object value — edit in file')}</div></td>
        <td class="value-cell opt-doc">${escapeHtml(JSON.stringify(value))}</td>
      </tr>`;
  }
  return /* html */ `
    <tr>
      <td class="toggle-cell"><input type="checkbox" class="opt-toggle" data-key="${escapeHtml(def.key)}"${present ? ' checked' : ''}></td>
      <td class="opt-name">${escapeHtml(def.key)}${def.doc ? `<div class="opt-doc">${escapeHtml(def.doc)}</div>` : ''}</td>
      <td class="value-cell">${valueControl(def, value, present)}</td>
    </tr>`;
}

function sectionTable(title: string, catalog: OptionDef[], values: Record<string, unknown>): string {
  const catalogKeys = new Set(catalog.map((d) => d.key));
  const rows = catalog
    .map((def) => optionRow(def, values[def.key], def.key in values))
    .join('');

  // Extra keys present in the file but not in the curated catalog.
  const extras = Object.keys(values)
    .filter((k) => !catalogKeys.has(k))
    .map((k) => {
      const def: OptionDef = { key: k, type: inferType(values[k]), doc: 'custom option' };
      return optionRow(def, values[k], true);
    })
    .join('');

  return /* html */ `
    <div class="section">
      <div class="section-header"><h2>${escapeHtml(title)}</h2><span class="badge">${
        Object.keys(values).length
      }</span></div>
      <table class="opt-table"><tbody>${rows}${extras}</tbody></table>
    </div>`;
}

function buildHtml(filePath: string): string {
  const config = readJsonc<TsConfig>(filePath) ?? {};
  const catalog = getTsconfigCatalog();
  const compilerOptions = config.compilerOptions ?? {};

  const extendsNote = config.extends
    ? `<div class="subtitle">extends <code>${escapeHtml(String(config.extends))}</code> — inherited values are not shown here.</div>`
    : '';

  return /* html */ `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>tsconfig</title>
    <style>
      ${baseStyles()}
      code { font-family: var(--vscode-editor-font-family, monospace); }
      .add-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
      .add-row input[type="text"] { min-width: 140px; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>TypeScript Config</h1>
      <span class="spacer"></span>
      <button id="reloadBtn">Reload</button>
    </div>
    <div class="file-path">${escapeHtml(filePath)}</div>
    ${extendsNote}
    <div style="height:14px"></div>
    ${sectionTable('compilerOptions', catalog.compilerOptions, compilerOptions)}
    <div class="section">
      <div class="section-header"><h2>Add option</h2></div>
      <div class="add-row">
        <input type="text" id="addKey" placeholder="option name">
        <select id="addType">
          <option value="string">string</option>
          <option value="boolean">boolean</option>
          <option value="number">number</option>
          <option value="array">array</option>
        </select>
        <input type="text" id="addValue" placeholder="value">
        <button id="addBtn">Add</button>
      </div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();

      document.getElementById('reloadBtn').addEventListener('click', function () {
        vscode.postMessage({ command: 'reload' });
      });

      function rowValue(el) {
        const row = el.closest('tr');
        const value = row.querySelector('.opt-value');
        return value ? value.value : 'true';
      }

      document.querySelectorAll('.opt-toggle').forEach(function (cb) {
        cb.addEventListener('change', function () {
          const key = cb.getAttribute('data-key');
          if (cb.checked) {
            const valueEl = cb.closest('tr').querySelector('.opt-value');
            vscode.postMessage({
              command: 'setOption', key: key,
              type: valueEl ? valueEl.getAttribute('data-type') : 'boolean',
              value: valueEl ? valueEl.value : 'true'
            });
          } else {
            vscode.postMessage({ command: 'removeOption', key: key });
          }
        });
      });

      document.querySelectorAll('.opt-value').forEach(function (el) {
        el.addEventListener('change', function () {
          const row = el.closest('tr');
          const toggle = row.querySelector('.opt-toggle');
          if (toggle) { toggle.checked = true; }
          vscode.postMessage({
            command: 'setOption',
            key: el.getAttribute('data-key'),
            type: el.getAttribute('data-type'),
            value: el.value
          });
        });
      });

      document.getElementById('addBtn').addEventListener('click', function () {
        const key = document.getElementById('addKey').value.trim();
        if (!key) { return; }
        vscode.postMessage({
          command: 'addOption',
          key: key,
          type: document.getElementById('addType').value,
          value: document.getElementById('addValue').value
        });
      });
    </script>
  </body>
  </html>`;
}
