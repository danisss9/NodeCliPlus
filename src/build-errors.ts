import * as vscode from 'vscode';
import * as path from 'path';
import {
  resolveWorkspaceAndProjects,
  detectActiveFileProject,
  getLastProject,
  setLastProject,
} from './utils';
import type { NodeWorkspaceProject } from './types';
import { spawnCapture } from './dependencies';
import { parseBuildErrors, pickScriptCandidates } from './pure-utils';
import type { ParsedBuildError } from './pure-utils';
import {
  sendCopilotAutoFix,
  sendCopilotAutoFixForFile,
  sendAIAutoFix,
  sendAIAutoFixForFile,
  getAIProvider,
} from './copilot-fix';
import { createAnalysisPanel, escapeHtml, ANALYSIS_PANEL_CSP } from './webview-utils';

const COMMAND_KEY = 'checkBuildErrors';

const BUILD_SCRIPT_ALIASES = ['build', 'compile', 'dist', 'build:prod', 'build:production'];

export interface BuildError {
  /** Absolute file path */
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function checkBuildErrors(): Promise<void> {
  const resolved = await resolveWorkspaceAndProjects();
  if (!resolved) {
    return;
  }
  const { projects } = resolved;

  const project = await pickBuildErrorsProject(projects);
  if (!project) {
    return;
  }

  const script = await pickBuildScript(project);
  if (!script) {
    return;
  }

  const errors = await runAndCheckBuildErrors(project, script);
  createBuildErrorsPanel(errors, project, script);
}

async function pickBuildErrorsProject(
  projects: NodeWorkspaceProject[],
): Promise<NodeWorkspaceProject | null> {
  const projectNames = projects.map((p) => p.name);

  const currentProject = detectActiveFileProject(projects);
  const currentInList = currentProject && projectNames.includes(currentProject.name) ? currentProject : null;
  const CURRENT_PROJECT_LABEL = currentInList
    ? `$(folder)  Current project (${currentInList.name})`
    : null;

  const last = getLastProject(COMMAND_KEY);
  const lastProject =
    last && last !== currentInList?.name ? (projects.find((p) => p.name === last) ?? null) : null;
  const LAST_LABEL = lastProject ? `$(history)  Last used (${lastProject.name})` : null;

  const choices = [
    ...(CURRENT_PROJECT_LABEL ? [CURRENT_PROJECT_LABEL] : []),
    ...(LAST_LABEL ? [LAST_LABEL] : []),
    ...projectNames,
  ];

  if (choices.length === 0) {
    vscode.window.showErrorMessage('No projects found.');
    return null;
  }

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select a project to check for build errors',
    title: 'Node: Check Build Errors',
  });

  if (!picked) {
    return null;
  }

  if (CURRENT_PROJECT_LABEL && picked === CURRENT_PROJECT_LABEL) {
    setLastProject(COMMAND_KEY, currentInList!.name);
    return currentInList!;
  }
  if (LAST_LABEL && picked === LAST_LABEL) {
    return lastProject!;
  }
  setLastProject(COMMAND_KEY, picked);
  return projects.find((p) => p.name === picked) ?? null;
}

async function pickBuildScript(project: NodeWorkspaceProject): Promise<string | null> {
  const scripts = project.scripts;
  if (!scripts || Object.keys(scripts).length === 0) {
    vscode.window.showWarningMessage(
      `No npm scripts found in ${path.join(project.relativeDir || '.', 'package.json')}.`,
    );
    return null;
  }

  if (BUILD_SCRIPT_ALIASES.some((alias) => alias in scripts)) {
    return pickScriptCandidates(scripts, BUILD_SCRIPT_ALIASES)[0]!;
  }

  const items: vscode.QuickPickItem[] = Object.entries(scripts).map(([name, cmd]) => ({
    label: name,
    description: cmd,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the script that builds the project',
    title: 'Node: Check Build Errors — Select Script',
    matchOnDescription: true,
  });
  return picked ? picked.label : null;
}

// ── Build Execution ────────────────────────────────────────────────────────────

async function runAndCheckBuildErrors(
  project: NodeWorkspaceProject,
  script: string,
): Promise<BuildError[]> {
  let capturedOutput = '';

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Building ${project.name} to check for errors…`,
      cancellable: false,
    },
    async () => {
      const result = await spawnCapture('npm', ['run', script], project.dir, true);
      capturedOutput = result.stdout; // errors can go to either stream; both are captured
    },
  );

  const parsed = parseBuildErrors(capturedOutput);

  // Tools print paths relative to the project dir — resolve them to absolute.
  return parsed.map((err) => ({
    ...err,
    file: resolveReportedPath(project.dir, err.file),
  }));
}

/** Makes a path printed by a build tool absolute (relative to the project dir). */
function resolveReportedPath(projectDir: string, file: string): string {
  if (path.isAbsolute(file)) {
    return file;
  }
  return path.resolve(projectDir, file);
}

// ── Webview ────────────────────────────────────────────────────────────────────

function buildErrorsTitle(projectName: string, count: number): string {
  return `Build Errors: ${projectName} (${count})`;
}

/**
 * Creates a fresh panel for the given results. Each run opens its own tab; the
 * panel's Reload button re-runs the build and refreshes that same tab in place.
 */
function createBuildErrorsPanel(
  errors: BuildError[],
  project: NodeWorkspaceProject,
  script: string,
): void {
  const autoFixEnabled = (): boolean =>
    vscode.workspace.getConfiguration('nodeCliPlus').get<boolean>('ai.autoFixEnabled', true);

  const aiProvider = (): string => getAIProvider();

  const analysisPanel = createAnalysisPanel(
    'nodeBuildErrors',
    buildErrorsTitle(project.name, errors.length),
  );
  analysisPanel.setHtml(buildWebviewHtml(errors, project.name, autoFixEnabled()));

  analysisPanel.onMessage(
    async (message: {
      command: string;
      file: string;
      line: number;
      kind?: string;
      kindLabel?: string;
      snippet?: string;
      description?: string;
      fixHint?: string;
      issues?: Array<{
        line: number;
        kind: string;
        kindLabel: string;
        snippet: string;
        description: string;
        fixHint: string;
      }>;
    }) => {
      if (message.command === 'openFile') {
        const uri = vscode.Uri.file(message.file);
        try {
          await vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(
              new vscode.Position(message.line - 1, 0),
              new vscode.Position(message.line - 1, 0),
            ),
            preview: false,
          });
        } catch {
          vscode.window.showErrorMessage(`Could not open file: ${message.file}`);
        }
      } else if (message.command === 'reload') {
        const fresh = await runAndCheckBuildErrors(project, script);
        analysisPanel.setTitle(buildErrorsTitle(project.name, fresh.length));
        analysisPanel.setHtml(buildWebviewHtml(fresh, project.name, autoFixEnabled()));
      } else if (message.command === 'copilotFix' || message.command === 'aiFix') {
        const fixProvider = message.command === 'aiFix' ? aiProvider() : 'copilot';
        const sendFix = fixProvider === 'claude' ? sendAIAutoFix : sendCopilotAutoFix;
        await sendFix({
          file: message.file,
          line: message.line,
          kind: message.kind ?? '',
          kindLabel: message.kindLabel ?? message.kind ?? '',
          snippet: message.snippet ?? '',
          description: message.description ?? '',
          fixHint: message.fixHint ?? '',
        });
      } else if (message.command === 'copilotFixFile' || message.command === 'aiFixFile') {
        const fixFileProvider = message.command === 'aiFixFile' ? aiProvider() : 'copilot';
        const sendFixFile =
          fixFileProvider === 'claude' ? sendAIAutoFixForFile : sendCopilotAutoFixForFile;
        await sendFixFile({
          file: message.file,
          issues: message.issues ?? [],
          issueType: 'Build Error',
        });
      }
    },
  );
}

// ── HTML ────────────────────────────────────────────────────────────────────────

const AI_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z" fill="currentColor"/><path d="M13 1L13.75 3.25L16 4L13.75 4.75L13 7L12.25 4.75L10 4L12.25 3.25L13 1Z" fill="currentColor" opacity="0.7"/><path d="M3 10L3.5 11.5L5 12L3.5 12.5L3 14L2.5 12.5L1 12L2.5 11.5L3 10Z" fill="currentColor" opacity="0.7"/></svg>';

function buildWebviewHtml(
  errors: BuildError[],
  projectName: string,
  autoFixEnabled: boolean,
): string {
  if (errors.length === 0) {
    const funnyMessages = [
      '0 build errors! Time for a coffee break. ☕',
      "0 build errors! You're a wizard, Harry! 🧙‍♂️",
      "0 build errors! The code compiles on the first try... Wait, that's illegal! 🚔",
      '0 build errors! Ship it! 🚢',
      '0 build errors! Your code is flawless. 💎',
      '0 build errors! No bugs here, just happy little accidents. 🎨',
      '0 build errors! This is fine. 🔥',
      '0 build errors! Just Features. ✨',
      '0 build errors! Even Linus Torvalds would approve! 🐧',
      "0 build errors! You've achieved code enlightenment. ✨",
      '0 build errors! Your code is so clean, Marie Kondo is jealous. 📦',
      "0 build errors! Congratulations, you're a digital wizard! 🪄",
      '0 build errors! No errors, no drama, just vibes. 😎',
      '0 build errors! You are the hero we deserve. 🦸‍♂️',
      '0 build errors! You are the code ninja. 🥷',
    ];
    const randomMsg = funnyMessages[Math.floor(Math.random() * funnyMessages.length)];

    return /* html */ `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="${ANALYSIS_PANEL_CSP}">
      <title>Build Errors</title>
      <style>
        body {
          font-family: var(--vscode-font-family);
          color: var(--vscode-foreground);
          background: var(--vscode-editor-background);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          text-align: center;
          margin: 0;
        }
        h1 { font-size: 2em; color: var(--vscode-testing-iconPassed); }
        .reload-btn {
          margin-top: 20px;
          padding: 8px 16px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .reload-btn:hover {
          background: var(--vscode-button-hoverBackground);
        }
      </style>
    </head>
    <body>
      <h1>${randomMsg}</h1>
      <button class="reload-btn" id="reloadBtn">Build Again</button>
      <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('reloadBtn').addEventListener('click', () => {
          vscode.postMessage({ command: 'reload' });
        });
      </script>
    </body>
    </html>`;
  }

  // Group by file
  const byFile = new Map<string, BuildError[]>();
  for (const err of errors) {
    const group = byFile.get(err.file) ?? [];
    group.push(err);
    byFile.set(err.file, group);
  }

  const fileGroups = Array.from(byFile.entries())
    .map(([file, fileErrors]) => {
      const rel = file.replaceAll('\\', '/');
      const dir = rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/') + 1) : '';
      const filename = path.basename(file);
      const countLabel = fileErrors.length === 1 ? '1 error' : `${fileErrors.length} errors`;

      const issueRows = fileErrors
        .map((err) => {
          const codePill = err.code
            ? `<span class="code-pill ts-pill">${escapeHtml(err.code)}</span>`
            : '';

          const safeMessage = escapeHtml(err.message);
          const firstLine = escapeHtml(err.message.split(/\r?\n/)[0]);

          const errorKind = err.code || 'Build Error';
          const description = `Build error${err.code ? ` ${err.code}` : ''}: ${err.message.split(/\r?\n/)[0]}`;
          const fixHint = `Fix the ${err.code ? `${err.code} ` : ''}error at line ${err.line}, column ${err.col}.`;

          const aiBtn = autoFixEnabled
            ? /* html */ `<button class="ai-fix-btn copilot-fix-btn" title="Auto Fix with AI"
                data-command="aiFix"
                data-file="${escapeHtml(err.file)}"
                data-line="${err.line}"
                data-kind="${escapeHtml(err.code || 'error')}"
                data-kind-label="${escapeHtml(errorKind)}"
                data-snippet="${escapeHtml(err.message.split(/\r?\n/)[0])}"
                data-description="${escapeHtml(description)}"
                data-fix-hint="${escapeHtml(fixHint)}"
              >${AI_ICON_SVG}</button>`
            : '';

          return /* html */ `
      <div class="issue-item">
        <div class="issue-header" title="Click to expand/collapse&#10;&#10;${safeMessage}">
          <a class="line-num" href="#" data-file="${escapeHtml(err.file)}" data-line="${err.line}">Line ${err.line}</a>
          ${codePill}
          <div class="issue-summary">${firstLine}</div>
          ${aiBtn}
          <button class="toggle-btn" title="Expand/Collapse">
            <svg class="chevron" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M5.5 3L10.5 8L5.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <div class="message">${safeMessage}</div>
      </div>`;
        })
        .join('');

      const fileFixAllBtn = autoFixEnabled
        ? /* html */ `<button class="ai-fix-file-btn copilot-fix-file-btn" title="Auto Fix all ${fileErrors.length} error${fileErrors.length !== 1 ? 's' : ''} in this file with AI"
          data-command="aiFixFile"
          data-file="${escapeHtml(file)}"
          data-issues="${escapeHtml(
            JSON.stringify(
              fileErrors.map((e) => ({
                line: e.line,
                kind: e.code || 'error',
                kindLabel: e.code || 'Build Error',
                snippet: e.message.split(/\r?\n/)[0],
                description: `Build error${e.code ? ` ${e.code}` : ''}: ${e.message.split(/\r?\n/)[0]}`,
                fixHint: `Fix the ${e.code ? `${e.code} ` : ''}error at line ${e.line}, column ${e.col}.`,
              })),
            ),
          )}"
        >${AI_ICON_SVG}<span>Fix all</span></button>`
        : '';

      return /* html */ `
    <div class="file-group">
      <div class="file-header">
        <svg class="file-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6L9 1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M9 1v5h5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
        <span class="file-path"><span class="file-dir">${escapeHtml(dir)}</span><span class="file-name">${escapeHtml(filename)}</span></span>
        <span class="file-badge">${countLabel}</span>
        ${fileFixAllBtn}
        <button class="toggle-all-btn" title="Expand/Collapse All in file">
          <svg class="chevron" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5.5 3L10.5 8L5.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="issue-list">${issueRows}</div>
    </div>`;
    })
    .join('\n');

  return /* html */ `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${ANALYSIS_PANEL_CSP}">
    <title>Build Errors</title>
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
      .header {
        margin-bottom: 20px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .header-title {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 6px;
      }
      .error-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: rgba(240, 100, 80, 0.15);
        color: var(--vscode-problemsErrorIcon-foreground, #f06450);
        flex-shrink: 0;
        font-size: 14px;
        font-weight: 700;
        line-height: 1;
      }
      h1 {
        font-size: 1.15em;
        font-weight: 600;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        height: 18px;
        padding: 0 6px;
        border-radius: 9px;
        font-size: 0.75em;
        font-weight: 700;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }
      .stats {
        font-size: 0.82em;
        color: var(--vscode-descriptionForeground);
      }
      .reload-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        margin-left: auto;
        padding: 3px 10px;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 4px;
        background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        font-size: 0.8em;
        font-family: var(--vscode-font-family);
        cursor: pointer;
        white-space: nowrap;
      }
      .reload-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25));
      }
      .file-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .file-group {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        overflow: hidden;
      }
      .file-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background, rgba(128,128,128,0.08)));
        border-bottom: 1px solid var(--vscode-panel-border);
        user-select: none;
      }
      .file-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        color: var(--vscode-descriptionForeground);
      }
      .file-path {
        flex: 1;
        font-size: 0.88em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .file-dir { color: var(--vscode-descriptionForeground); }
      .file-name { font-weight: 600; }
      .file-badge {
        flex-shrink: 0;
        font-size: 0.75em;
        font-weight: 600;
        padding: 1px 8px;
        border-radius: 8px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }
      .issue-list {
        display: flex;
        flex-direction: column;
      }
      .issue-item {
        display: flex;
        flex-direction: column;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .issue-item:last-child {
        border-bottom: none;
      }
      .issue-header {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 12px;
        cursor: pointer;
        transition: background 0.1s;
      }
      .issue-header:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .issue-summary {
        flex: 1;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 0.88em;
        color: var(--vscode-editor-foreground);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding-top: 1px;
      }
      .line-num {
        flex-shrink: 0;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 0.8em;
        color: var(--vscode-textLink-foreground);
        text-decoration: none;
        min-width: 52px;
        text-align: right;
        margin-top: 2px;
      }
      .line-num:hover { text-decoration: underline; }
      .code-pill {
        flex-shrink: 0;
        font-size: 0.72em;
        font-weight: 700;
        text-transform: uppercase;
        padding: 2px 7px;
        border-radius: 8px;
        white-space: nowrap;
        background: rgba(240, 100, 80, 0.15);
        color: var(--vscode-problemsErrorIcon-foreground, #f06450);
        border: 1px solid rgba(240, 100, 80, 0.3);
        text-decoration: none;
        margin-top: 1px;
      }
      .ts-pill {
        background: rgba(100, 160, 240, 0.15);
        color: var(--vscode-terminal-ansiBrightBlue, #6aa0f0);
        border: 1px solid rgba(100, 160, 240, 0.3);
      }
      .message {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 0.88em;
        color: var(--vscode-editor-foreground);
        word-wrap: break-word;
        white-space: pre-wrap;
        display: none;
        padding: 4px 12px 12px 12px;
        margin-left: 72px;
      }
      .issue-item.expanded .message {
        display: block;
      }
      .issue-item.expanded .issue-summary {
        display: none;
      }
      .toggle-btn, .toggle-all-btn {
        background: transparent;
        border: none;
        color: var(--vscode-icon-foreground);
        cursor: pointer;
        padding: 2px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 3px;
        outline-offset: -1px;
      }
      .toggle-btn:hover, .toggle-all-btn:hover {
        background: var(--vscode-toolbar-hoverBackground);
      }
      .toggle-btn, .toggle-all-btn {
        margin-left: auto;
      }
      .chevron {
        width: 16px;
        height: 16px;
        transition: transform 0.15s ease-in-out;
      }
      .issue-item.expanded .chevron, .toggle-all-btn.expanded .chevron {
        transform: rotate(90deg);
      }
      /* ── AI fix button ── */
      .copilot-fix-btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 3px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--vscode-terminal-ansiBrightMagenta, #b464f0);
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
      }
      .issue-header:hover .copilot-fix-btn {
        opacity: 0.7;
      }
      .copilot-fix-btn:hover {
        opacity: 1 !important;
        background: rgba(180, 100, 240, 0.15);
        color: #c084fc;
      }
      .copilot-fix-btn:active {
        background: rgba(180, 100, 240, 0.28);
      }
      /* ── Per-file Fix all button ── */
      .copilot-fix-file-btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border: 1px solid rgba(180, 100, 240, 0.35);
        border-radius: 4px;
        background: rgba(180, 100, 240, 0.08);
        color: var(--vscode-terminal-ansiBrightMagenta, #b464f0);
        cursor: pointer;
        font-size: 0.75em;
        font-family: var(--vscode-font-family);
        white-space: nowrap;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
      }
      .copilot-fix-file-btn:hover {
        background: rgba(180, 100, 240, 0.18);
        border-color: rgba(180, 100, 240, 0.6);
        color: #c084fc;
      }
      .copilot-fix-file-btn:active {
        background: rgba(180, 100, 240, 0.28);
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="header-title">
        <span class="error-icon">✕</span>
        <h1>Node Build Errors</h1>
        <span class="badge">${errors.length}</span>
        <button class="reload-btn" id="reloadBtn">
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13">
            <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2L11 6h3.5V2.5L13 4a7 7 0 1 0 .5 4H13.5z" fill="currentColor"/>
          </svg>
          Reload
        </button>
      </div>
      <p class="stats">Project: ${escapeHtml(projectName)}</p>
    </div>
    <div class="file-list">
      ${fileGroups}
    </div>
    <script>
      const vscode = acquireVsCodeApi();

      // Preserve scroll position when jumping to a file and back: VS Code can
      // reset a webview's scroll when a text editor takes over its column.
      (function () {
        function saveScroll() {
          var s = vscode.getState() || {};
          s.scrollY = window.scrollY;
          vscode.setState(s);
        }
        function restoreScroll() {
          var s = vscode.getState();
          if (s && typeof s.scrollY === 'number') {
            window.scrollTo(0, s.scrollY);
          }
        }
        var timer;
        window.addEventListener('scroll', function () {
          clearTimeout(timer);
          timer = setTimeout(saveScroll, 100);
        }, { passive: true });
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') {
            requestAnimationFrame(restoreScroll);
          }
        });
        restoreScroll();
      })();

      document.querySelectorAll('a[data-file]').forEach(function(link) {
        link.addEventListener('click', function(e) {
          e.preventDefault();
          vscode.postMessage({
            command: 'openFile',
            file: link.getAttribute('data-file'),
            line: parseInt(link.getAttribute('data-line'), 10)
          });
        });
      });
      document.getElementById('reloadBtn').addEventListener('click', function() {
        vscode.postMessage({ command: 'reload' });
      });
      document.querySelectorAll('.copilot-fix-btn, .ai-fix-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          const command = btn.getAttribute('data-command') || 'copilotFix';
          vscode.postMessage({
            command: command,
            file: btn.getAttribute('data-file'),
            line: parseInt(btn.getAttribute('data-line'), 10),
            kind: btn.getAttribute('data-kind'),
            kindLabel: btn.getAttribute('data-kind-label'),
            snippet: btn.getAttribute('data-snippet'),
            description: btn.getAttribute('data-description'),
            fixHint: btn.getAttribute('data-fix-hint')
          });
        });
      });
      document.querySelectorAll('.copilot-fix-file-btn, .ai-fix-file-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          const command = btn.getAttribute('data-command') || 'copilotFixFile';
          vscode.postMessage({
            command: command,
            file: btn.getAttribute('data-file'),
            issues: JSON.parse(btn.getAttribute('data-issues') || '[]')
          });
        });
      });
      document.querySelectorAll('.issue-header').forEach(function(header) {
        header.addEventListener('click', function(e) {
          if (e.target.closest('a') || e.target.closest('button')) {
            // Let the button click handler do its thing, or follow the link
            if (e.target.closest('a')) return;
          }
          const item = header.closest('.issue-item');
          item.classList.toggle('expanded');
        });
      });
      document.querySelectorAll('.toggle-all-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          const fileGroup = btn.closest('.file-group');
          const items = fileGroup.querySelectorAll('.issue-item');
          const isExpanded = btn.classList.contains('expanded');

          if (isExpanded) {
            btn.classList.remove('expanded');
            items.forEach(function(i) { i.classList.remove('expanded'); });
          } else {
            btn.classList.add('expanded');
            items.forEach(function(i) { i.classList.add('expanded'); });
          }
        });
      });
    </script>
  </body>
  </html>`;
}
