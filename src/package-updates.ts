import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorkspaceAndProjects } from './utils';
import { spawnCapture, spawnNpm, spawnShellCommand } from './dependencies';
import { beginSecurityInstall, endSecurityInstall } from './security-command';
import { npmOutput } from './state';
import { extractJsonObject } from './pure-utils';
import { createAnalysisPanel, escapeHtml, ANALYSIS_PANEL_CSP } from './webview-utils';
import type { AnalysisPanel } from './webview-utils';

interface UpdatablePackage {
  name: string;
  current: string;
  latest: string;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function showPackageUpdates(): Promise<void> {
  const resolved = await resolveWorkspaceAndProjects();
  if (!resolved) {
    return;
  }
  const results = await runChecks(resolved.workspaceRoot);
  createPackageUpdatesPanel(resolved.workspaceRoot, results);
}

// ── Checks ───────────────────────────────────────────────────────────────────

interface UpdateResults {
  packages: UpdatablePackage[];
  ncuFailed: boolean;
}

/**
 * Runs `npx npm-check-updates --jsonUpgraded` and maps the result against the
 * current versions in package.json. Returns a null list when ncu could not run.
 */
async function runChecks(workspaceRoot: string): Promise<UpdateResults> {
  let packages: UpdatablePackage[] | null = null;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Checking for package updates…',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'npm-check-updates…' });
      packages = await checkNcu(workspaceRoot);
    },
  );

  return { packages: packages ?? [], ncuFailed: packages === null };
}

async function checkNcu(workspaceRoot: string): Promise<UpdatablePackage[] | null> {
  const result = await spawnCapture(
    'npx',
    ['--yes', 'npm-check-updates', '--jsonUpgraded'],
    workspaceRoot,
    true,
  );

  const json = extractJsonObject(result.stdout);
  if (json === null) {
    return null;
  }

  let upgraded: Record<string, string>;
  try {
    upgraded = JSON.parse(json) as Record<string, string>;
  } catch {
    return null;
  }

  const current = readCurrentVersions(workspaceRoot);
  return Object.entries(upgraded).map(([name, latest]) => ({
    name,
    current: current[name] ?? '—',
    latest,
  }));
}

function readCurrentVersions(workspaceRoot: string): Record<string, string> {
  const versions: Record<string, string> = {};
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8'),
    ) as Record<string, Record<string, string> | undefined>;
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const deps = pkg[field];
      if (deps) {
        Object.assign(versions, deps);
      }
    }
  } catch {
    // Missing/unparseable package.json — current versions just show as "—".
  }
  return versions;
}

// ── Update actions ───────────────────────────────────────────────────────────

async function updatePackages(names: string[], workspaceRoot: string): Promise<void> {
  // Guard against anything that isn't a plain package name before it reaches a shell.
  const safe = names.filter((n) => /^[@\w./-]+$/.test(n));
  if (safe.length === 0) {
    return;
  }

  npmOutput.clear();
  npmOutput.show(true);

  const ncuCode = await spawnShellCommand(
    `npx --yes npm-check-updates -u --filter ${safe.join(',')}`,
    workspaceRoot,
  );
  if (ncuCode !== 0) {
    vscode.window.showErrorMessage(
      "npm-check-updates failed. See 'Node CLI Plus: npm' output for details.",
    );
    return;
  }

  const securityRoot = await beginSecurityInstall(workspaceRoot);
  let installCode = 1;
  try { installCode = await spawnNpm(['install'], workspaceRoot); }
  finally { endSecurityInstall(securityRoot, installCode === 0 ? 'success' : 'failed'); }
  if (installCode === 0) {
    vscode.window.showInformationMessage(
      `Updated ${safe.length} package${safe.length !== 1 ? 's' : ''} successfully.`,
    );
  } else {
    vscode.window.showErrorMessage(
      "npm install failed after updating package.json. See 'Node CLI Plus: npm' output for details.",
    );
  }
}

// ── Webview ──────────────────────────────────────────────────────────────────

/** Per-panel state. Each run opens its own tab, tracked independently. */
interface PackagePanel {
  panel: AnalysisPanel;
  workspaceRoot: string;
}

interface WebviewMessage {
  command: string;
  packages?: string[];
}

/**
 * Creates a fresh panel for the given results. Each run opens its own tab; the
 * panel's Reload button (and the update actions) refresh that same tab in place.
 */
function createPackageUpdatesPanel(workspaceRoot: string, results: UpdateResults): void {
  const state: PackagePanel = {
    panel: createAnalysisPanel('nodePackageUpdates', packageUpdatesTitle(results)),
    workspaceRoot,
  };
  renderInto(state, results);
  state.panel.onMessage((m: WebviewMessage) => handleMessage(state, m));
}

function packageUpdatesTitle(results: UpdateResults): string {
  return `Package Updates (${results.packages.length})`;
}

function renderInto(state: PackagePanel, results: UpdateResults): void {
  state.panel.setTitle(packageUpdatesTitle(results));
  state.panel.setHtml(buildWebviewHtml(results.packages, results.ncuFailed));
}

/** Re-runs the update checks and refreshes the panel in place. */
async function reloadPanel(state: PackagePanel): Promise<void> {
  const results = await runChecks(state.workspaceRoot);
  renderInto(state, results);
}

async function handleMessage(state: PackagePanel, message: WebviewMessage): Promise<void> {
  switch (message.command) {
    case 'reload':
      await reloadPanel(state);
      return;
    case 'update': {
      const packages = message.packages ?? [];
      if (packages.length === 0) {
        return;
      }
      await updatePackages(packages, state.workspaceRoot);
      await reloadPanel(state);
      return;
    }
  }
}

const RELOAD_SVG =
  '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2L11 6h3.5V2.5L13 4a7 7 0 1 0 .5 4H13.5z" fill="currentColor"/></svg>';

function packageRows(packages: UpdatablePackage[]): string {
  return packages
    .map(
      (p) => /* html */ `
        <tr>
          <td class="check-cell"><input type="checkbox" class="pkg-check" data-name="${escapeHtml(p.name)}" checked></td>
          <td class="name-cell">${escapeHtml(p.name)}</td>
          <td class="ver-cell current">${escapeHtml(p.current)}</td>
          <td class="arrow-cell">→</td>
          <td class="ver-cell latest">${escapeHtml(p.latest)}</td>
        </tr>`,
    )
    .join('');
}

function buildWebviewHtml(packages: UpdatablePackage[], ncuFailed: boolean): string {
  const total = packages.length;

  const body =
    total === 0
      ? /* html */ `<div class="all-clear">
          <h1>${ncuFailed ? 'Could not check for updates' : 'All packages are up to date 🎉'}</h1>
          <p class="note">${
            ncuFailed
              ? 'npm-check-updates could not run (npx unavailable or offline).'
              : 'Every dependency matches its latest version.'
          }</p>
          <button class="reload-btn" id="reloadBtn">${RELOAD_SVG}Check again</button>
        </div>`
      : /* html */ `
        <div class="section">
          <div class="section-header">
            <h2>Packages</h2>
            <span class="count-badge">${packages.length}</span>
            <span class="section-subtitle">updated via npm-check-updates + npm install</span>
            <button class="update-btn" id="updateBtn">Update with npm</button>
          </div>
          <table class="pkg-table">
            <thead>
              <tr>
                <th class="check-cell"><input type="checkbox" class="select-all" checked></th>
                <th class="name-cell">Package</th>
                <th class="ver-cell">Current</th>
                <th class="arrow-cell"></th>
                <th class="ver-cell">Latest</th>
              </tr>
            </thead>
            <tbody>${packageRows(packages)}</tbody>
          </table>
        </div>`;

  return /* html */ `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${ANALYSIS_PANEL_CSP}">
    <title>Package Updates</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 20px 24px 40px;
        line-height: 1.5;
      }
      .header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border); }
      h1 { font-size: 1.15em; font-weight: 600; }
      .badge {
        display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 18px;
        padding: 0 6px; border-radius: 9px; font-size: 0.75em; font-weight: 700;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      }
      .spacer { flex: 1; }
      .reload-btn, .update-btn {
        display: inline-flex; align-items: center; gap: 5px; padding: 4px 12px;
        border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
        font-size: 0.8em; font-family: var(--vscode-font-family); cursor: pointer; white-space: nowrap;
      }
      .reload-btn {
        background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      }
      .reload-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25)); }
      .update-btn {
        margin-left: auto;
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      }
      .update-btn:hover { background: var(--vscode-button-hoverBackground); }
      .update-btn:disabled { opacity: 0.5; cursor: default; }
      .section { margin-bottom: 28px; }
      .section-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
      h2 { font-size: 1em; font-weight: 600; }
      .count-badge {
        font-size: 0.72em; font-weight: 700; padding: 1px 8px; border-radius: 8px;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      }
      .section-subtitle { font-size: 0.78em; color: var(--vscode-descriptionForeground); }
      .pkg-table { width: 100%; border-collapse: collapse; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
      .pkg-table thead th {
        text-align: left; font-size: 0.75em; font-weight: 600; text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
        padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08));
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .pkg-table tbody tr { border-bottom: 1px solid var(--vscode-panel-border); }
      .pkg-table tbody tr:last-child { border-bottom: none; }
      .pkg-table tbody tr:hover { background: var(--vscode-list-hoverBackground); }
      .pkg-table td { padding: 7px 12px; font-size: 0.88em; vertical-align: middle; }
      .check-cell { width: 28px; text-align: center; }
      .name-cell { font-family: var(--vscode-editor-font-family, monospace); }
      .ver-cell { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; white-space: nowrap; }
      .ver-cell.current { color: var(--vscode-descriptionForeground); }
      .ver-cell.latest { color: var(--vscode-testing-iconPassed, #4ec27a); }
      .arrow-cell { color: var(--vscode-descriptionForeground); text-align: center; width: 24px; }
      .all-clear { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 60px 0; text-align: center; }
      .all-clear h1 { color: var(--vscode-testing-iconPassed); }
      .note { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>Package Updates</h1>
      <span class="badge">${total}</span>
      <span class="spacer"></span>
      <button class="reload-btn" id="reloadBtn">${RELOAD_SVG}Reload</button>
    </div>
    ${body}
    <script>
      const vscode = acquireVsCodeApi();

      document.getElementById('reloadBtn').addEventListener('click', function () {
        vscode.postMessage({ command: 'reload' });
      });

      var selectAll = document.querySelector('.select-all');
      if (selectAll) {
        selectAll.addEventListener('change', function () {
          document.querySelectorAll('.pkg-check').forEach(function (cb) {
            cb.checked = selectAll.checked;
          });
        });
      }

      var updateBtn = document.getElementById('updateBtn');
      if (updateBtn) {
        updateBtn.addEventListener('click', function () {
          const names = [];
          document.querySelectorAll('.pkg-check').forEach(function (cb) {
            if (cb.checked) { names.push(cb.getAttribute('data-name')); }
          });
          if (names.length === 0) { return; }
          updateBtn.disabled = true;
          updateBtn.textContent = 'Updating…';
          vscode.postMessage({ command: 'update', packages: names });
        });
      }
    </script>
  </body>
  </html>`;
}
