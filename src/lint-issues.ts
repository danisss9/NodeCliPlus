import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveWorkspaceAndProjects,
  detectActiveFileProject,
  getLastProject,
  setLastProject,
  resolveEslintSpawn,
  runInTerminal,
} from './utils';
import type { NodeWorkspaceProject } from './types';
import { spawnCapture } from './dependencies';
import { extractJsonArray } from './pure-utils';
import {
  sendCopilotAutoFix,
  sendCopilotAutoFixForFile,
  sendAIAutoFix,
  sendAIAutoFixForFile,
  getAIProvider,
} from './copilot-fix';
import { createAnalysisPanel, escapeHtml, ANALYSIS_PANEL_CSP } from './webview-utils';
import type { AnalysisPanel } from './webview-utils';

const COMMAND_KEY = 'lint';

type LintSeverity = 'error' | 'warning';
type SortMode = 'file' | 'rule';
type LineGetter = (file: string, line: number) => string;

export interface LintIssue {
  /** Absolute file path */
  file: string;
  line: number;
  col: number;
  /** ESLint rule id, or 'syntax' for parse errors with no rule */
  ruleId: string;
  message: string;
  severity: LintSeverity;
  /** True when ESLint reported an auto-fix for this problem */
  fixable: boolean;
}

// Shape of the ESLint JSON formatter output (`eslint --format json`).
interface EslintMessage {
  ruleId: string | null;
  severity: number; // 1 = warning, 2 = error
  message: string;
  line?: number;
  column?: number;
  fix?: { range: [number, number]; text: string };
}
interface EslintResult {
  filePath: string;
  messages: EslintMessage[];
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function checkLint(): Promise<void> {
  const resolved = await resolveWorkspaceAndProjects();
  if (!resolved) {
    return;
  }
  const { projects } = resolved;

  const project = await pickLintProject(projects);
  if (!project) {
    return;
  }

  const issues = await runAndCheckLint(project);
  if (issues) {
    createLintPanel(issues, project);
  }
}

async function pickLintProject(
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
    placeHolder: 'Select a project to lint',
    title: 'Node: Lint Project',
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

// ── Lint execution ───────────────────────────────────────────────────────────

/**
 * Runs ESLint directly in the project directory and parses the results.
 * Returns the issues, or `null` when there were no parseable results
 * (a "lint not set up" dialog is shown instead).
 */
async function runAndCheckLint(project: NodeWorkspaceProject): Promise<LintIssue[] | null> {
  let capturedOutput = '';

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Linting ${project.name}…`,
      cancellable: false,
    },
    async () => {
      const cmd = resolveEslintSpawn(project.dir, ['.', '--format', 'json']);
      const result = await spawnCapture(cmd.command, cmd.args, project.dir, cmd.shell);
      // Lint exits non-zero when problems exist — that's expected; parse anyway.
      capturedOutput = result.stdout;
    },
  );

  const issues = parseLintOutput(capturedOutput);
  if (issues === null) {
    const INSTALL_LABEL = 'Install ESLint';
    const SHOW_LABEL = 'Show Output';
    const choice = await vscode.window.showErrorMessage(
      `No lint results for "${project.name}". ESLint doesn't seem to be set up — install it as a dev dependency to add linting.`,
      INSTALL_LABEL,
      SHOW_LABEL,
    );
    if (choice === INSTALL_LABEL) {
      void runInTerminal('npm install eslint', 'npm install --save-dev eslint', project.dir, {
        successMessage: 'ESLint installed. Run "Node: Lint Project" again to see results.',
      });
    } else if (choice === SHOW_LABEL) {
      const channel = vscode.window.createOutputChannel('Node CLI Plus: Lint');
      channel.appendLine(capturedOutput || '(no output)');
      channel.show();
    }
    return null;
  }

  return issues;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parseLintOutput(rawOutput: string): LintIssue[] | null {
  // Strip ANSI color codes the CLI may inject around the JSON.
  const output = rawOutput.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const jsonText = extractJsonArray(output);
  if (jsonText === null) {
    return null;
  }

  let results: EslintResult[];
  try {
    results = JSON.parse(jsonText) as EslintResult[];
  } catch {
    return null;
  }
  if (!Array.isArray(results)) {
    return null;
  }

  const issues: LintIssue[] = [];
  for (const res of results) {
    if (!res || !Array.isArray(res.messages)) {
      continue;
    }
    for (const msg of res.messages) {
      issues.push({
        file: res.filePath,
        line: msg.line ?? 1,
        col: msg.column ?? 1,
        ruleId: msg.ruleId ?? 'syntax',
        message: msg.message,
        severity: msg.severity === 1 ? 'warning' : 'error',
        fixable: !!msg.fix,
      });
    }
  }
  return issues;
}

// ── Webview ──────────────────────────────────────────────────────────────────

/** Per-panel state. Each run opens its own tab, tracked independently. */
interface LintPanel {
  panel: AnalysisPanel;
  project: NodeWorkspaceProject;
  issues: LintIssue[];
  sortMode: SortMode;
}

interface WebviewMessage {
  command: string;
  file?: string;
  files?: string[];
  line?: number;
  mode?: SortMode;
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
}

function lintTitle(projectName: string, count: number): string {
  return `Lint: ${projectName} (${count})`;
}

/**
 * Creates a fresh panel for the given results. Each run opens its own tab; the
 * panel's Reload button re-lints and refreshes that same tab in place.
 */
function createLintPanel(issues: LintIssue[], project: NodeWorkspaceProject): void {
  const state: LintPanel = {
    panel: createAnalysisPanel('nodeLintIssues', lintTitle(project.name, issues.length)),
    project,
    issues,
    sortMode: 'file',
  };
  renderInto(state);
  state.panel.onMessage((m: WebviewMessage) => handleMessage(state, m));
}

/** Rebuilds a panel's title + HTML from its current state. */
function renderInto(state: LintPanel): void {
  const config = vscode.workspace.getConfiguration('nodeCliPlus');
  const autoFixEnabled = config.get<boolean>('ai.autoFixEnabled', true);
  state.panel.setTitle(lintTitle(state.project.name, state.issues.length));
  state.panel.setHtml(
    buildWebviewHtml(
      state.issues,
      state.project.dir,
      state.project.name,
      autoFixEnabled,
      state.sortMode,
    ),
  );
}

/** Re-runs lint for the panel's scope and refreshes it in place. */
async function reloadPanel(state: LintPanel): Promise<void> {
  const issues = await runAndCheckLint(state.project);
  if (issues) {
    state.issues = issues;
    renderInto(state);
  }
}

async function handleMessage(state: LintPanel, message: WebviewMessage): Promise<void> {
  switch (message.command) {
    case 'openFile': {
      if (!message.file) {
        return;
      }
      const line = (message.line ?? 1) - 1;
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(message.file), {
          selection: new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 0)),
          preview: false,
        });
      } catch {
        vscode.window.showErrorMessage(`Could not open file: ${message.file}`);
      }
      return;
    }
    case 'sort':
      if (message.mode === 'file' || message.mode === 'rule') {
        state.sortMode = message.mode;
        renderInto(state);
      }
      return;
    case 'reload':
      await reloadPanel(state);
      return;
    case 'copilotFix':
    case 'aiFix': {
      const fixProvider = message.command === 'aiFix' ? getAIProvider() : 'copilot';
      const sendFix = fixProvider === 'claude' ? sendAIAutoFix : sendCopilotAutoFix;
      await sendFix({
        file: message.file ?? '',
        line: message.line ?? 1,
        kind: message.kind ?? '',
        kindLabel: message.kindLabel ?? message.kind ?? '',
        snippet: message.snippet ?? '',
        description: message.description ?? '',
        fixHint: message.fixHint ?? '',
      });
      return;
    }
    case 'copilotFixFile':
    case 'aiFixFile': {
      const fixFileProvider = message.command === 'aiFixFile' ? getAIProvider() : 'copilot';
      const sendFixFile =
        fixFileProvider === 'claude' ? sendAIAutoFixForFile : sendCopilotAutoFixForFile;
      await sendFixFile({
        file: message.file ?? '',
        issues: message.issues ?? [],
        issueType: 'Lint Issue',
      });
      return;
    }
    case 'eslintFix':
      if (message.files && message.files.length > 0) {
        await runEslintFix(state, message.files);
      }
      return;
    case 'eslintFixAll':
      await runEslintFixAll(state);
      return;
  }
}

// ── Native fixes (eslint --fix) ──────────────────────────────────────────────

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Runs `eslint --fix` on the given files, then re-lints to refresh the panel. */
async function runEslintFix(state: LintPanel, files: string[]): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Applying ESLint auto-fixes (${files.length} file${files.length !== 1 ? 's' : ''})…`,
      cancellable: false,
    },
    async () => {
      const cmd = resolveEslintSpawn(state.project.dir, ['--fix']);
      const fileArgs = cmd.shell ? files.map(quoteArg) : files;
      await spawnCapture(cmd.command, [...cmd.args, ...fileArgs], state.project.dir, cmd.shell);
    },
  );
  await reloadPanel(state);
}

/** Fixes every auto-fixable problem in the project via `eslint . --fix`. */
async function runEslintFixAll(state: LintPanel): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Auto-fixing ${state.project.name}…`,
      cancellable: false,
    },
    async () => {
      const cmd = resolveEslintSpawn(state.project.dir, ['.', '--fix']);
      await spawnCapture(cmd.command, cmd.args, state.project.dir, cmd.shell);
    },
  );
  await reloadPanel(state);
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const COPILOT_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z" fill="currentColor"/><path d="M13 1L13.75 3.25L16 4L13.75 4.75L13 7L12.25 4.75L10 4L12.25 3.25L13 1Z" fill="currentColor" opacity="0.7"/><path d="M3 10L3.5 11.5L5 12L3.5 12.5L3 14L2.5 12.5L1 12L2.5 11.5L3 10Z" fill="currentColor" opacity="0.7"/></svg>';

const WRENCH_SVG =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M11.7 1.4a3.2 3.2 0 0 0-3.9 4.1l-5.4 5.4a1.6 1.6 0 0 0 2.3 2.3l5.4-5.4a3.2 3.2 0 0 0 4.1-3.9l-2 2-1.6-.4-.4-1.6 2-2z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';

const FILE_SVG =
  '<svg class="file-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6L9 1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1v5h5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

const RULE_SVG =
  '<svg class="file-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="2.5" cy="4" r="1" fill="currentColor"/><circle cx="2.5" cy="8" r="1" fill="currentColor"/><circle cx="2.5" cy="12" r="1" fill="currentColor"/></svg>';

const RELOAD_SVG =
  '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2L11 6h3.5V2.5L13 4a7 7 0 1 0 .5 4H13.5z" fill="currentColor"/></svg>';

const TOGGLE_GROUP_BTN =
  '<button class="toggle-group-btn" title="Collapse/expand this group"><svg class="chevron" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 3L10.5 8L5.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';

const COLLAPSE_ALL_SVG =
  '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

function copilotIssueData(issue: LintIssue, snippet: string) {
  return {
    line: issue.line,
    kind: issue.ruleId,
    kindLabel: issue.ruleId,
    snippet,
    description: issue.message,
    fixHint: `Fix the ESLint rule "${issue.ruleId}" violation: ${issue.message}`,
  };
}

/** Native "Fix" (fixable) or Copilot "Auto Fix" (manual) button for one issue. */
function issueButtons(issue: LintIssue, snippet: string, autoFixEnabled: boolean): string {
  if (issue.fixable) {
    return /* html */ `<button class="fix-btn" title="Auto-fix with ESLint"
        data-files="${escapeHtml(JSON.stringify([issue.file]))}"
      >${WRENCH_SVG}<span>Fix</span></button>`;
  }
  if (autoFixEnabled) {
    const d = copilotIssueData(issue, snippet);
    return /* html */ `<button class="copilot-fix-btn" title="Auto Fix with AI"
        data-command="aiFix"
        data-file="${escapeHtml(issue.file)}"
        data-line="${issue.line}"
        data-kind="${escapeHtml(d.kind)}"
        data-kind-label="${escapeHtml(d.kindLabel)}"
        data-snippet="${escapeHtml(d.snippet)}"
        data-description="${escapeHtml(d.description)}"
        data-fix-hint="${escapeHtml(d.fixHint)}"
      >${COPILOT_SVG}</button>`;
  }
  return '';
}

function issueRow(
  issue: LintIssue,
  snippet: string,
  autoFixEnabled: boolean,
  mode: SortMode,
  projectDir: string,
): string {
  const sevPill = `<span class="sev-pill sev-${issue.severity}">${issue.severity}</span>`;
  const rulePill =
    mode === 'file' ? `<span class="rule-pill">${escapeHtml(issue.ruleId)}</span>` : '';
  const linkText =
    mode === 'rule'
      ? `${path.relative(projectDir, issue.file).replaceAll(path.sep, '/')}:${issue.line}`
      : `Line ${issue.line}`;

  return /* html */ `
      <div class="issue-item" data-severity="${issue.severity}" data-fixable="${issue.fixable}">
        <a class="line-num" href="#" data-file="${escapeHtml(issue.file)}" data-line="${issue.line}">${escapeHtml(linkText)}</a>
        ${sevPill}
        ${rulePill}
        <div class="issue-summary">${escapeHtml(issue.message)}</div>
        ${issueButtons(issue, snippet, autoFixEnabled)}
      </div>`;
}

function fixFilesButton(files: string[], label: string, title: string): string {
  return /* html */ `<button class="fix-file-btn" title="${escapeHtml(title)}"
      data-files="${escapeHtml(JSON.stringify(files))}"
    >${WRENCH_SVG}<span>${escapeHtml(label)}</span></button>`;
}

function copilotFileButton(file: string, issues: LintIssue[], getLine: LineGetter): string {
  const data = issues.map((i) => copilotIssueData(i, getLine(i.file, i.line)));
  return /* html */ `<button class="copilot-fix-file-btn" title="Auto Fix the manual problems in this file with AI"
      data-command="aiFixFile"
      data-file="${escapeHtml(file)}"
      data-issues="${escapeHtml(JSON.stringify(data))}"
    >${COPILOT_SVG}<span>AI fix</span></button>`;
}

function renderByFile(
  issues: LintIssue[],
  projectDir: string,
  autoFixEnabled: boolean,
  getLine: LineGetter,
): string {
  const byFile = new Map<string, LintIssue[]>();
  for (const issue of issues) {
    const group = byFile.get(issue.file) ?? [];
    group.push(issue);
    byFile.set(issue.file, group);
  }

  return Array.from(byFile.entries())
    .map(([file, fileIssues]) => {
      const rel = path.relative(projectDir, file).replaceAll(path.sep, '/');
      const dir = rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/') + 1) : '';
      const filename = path.basename(rel);
      const countLabel = `${fileIssues.length} problem${fileIssues.length !== 1 ? 's' : ''}`;

      const rows = fileIssues
        .map((issue) =>
          issueRow(issue, getLine(issue.file, issue.line), autoFixEnabled, 'file', projectDir),
        )
        .join('');

      const hasFixable = fileIssues.some((i) => i.fixable);
      const fileFixBtn = hasFixable
        ? fixFilesButton([file], 'Fix file', 'Auto-fix all fixable problems in this file')
        : '';
      const manualIssues = fileIssues.filter((i) => !i.fixable);
      const copilotBtn =
        autoFixEnabled && manualIssues.length > 0
          ? copilotFileButton(file, manualIssues, getLine)
          : '';

      return /* html */ `
    <div class="file-group" data-group-key="${escapeHtml(file)}">
      <div class="file-header">
        ${FILE_SVG}
        <span class="file-path"><span class="file-dir">${escapeHtml(dir)}</span><span class="file-name">${escapeHtml(filename)}</span></span>
        <span class="file-badge">${countLabel}</span>
        ${fileFixBtn}
        ${copilotBtn}
        ${TOGGLE_GROUP_BTN}
      </div>
      <div class="issue-list">${rows}</div>
    </div>`;
    })
    .join('\n');
}

function renderByRule(
  issues: LintIssue[],
  projectDir: string,
  autoFixEnabled: boolean,
  getLine: LineGetter,
): string {
  const byRule = new Map<string, LintIssue[]>();
  for (const issue of issues) {
    const group = byRule.get(issue.ruleId) ?? [];
    group.push(issue);
    byRule.set(issue.ruleId, group);
  }

  return Array.from(byRule.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([ruleId, ruleIssues]) => {
      const fixableCount = ruleIssues.filter((i) => i.fixable).length;
      const badge =
        fixableCount === ruleIssues.length
          ? '<span class="tag-badge fixable">fixable</span>'
          : fixableCount > 0
            ? '<span class="tag-badge partial">partly fixable</span>'
            : '<span class="tag-badge manual">manual</span>';
      const countLabel = `${ruleIssues.length} problem${ruleIssues.length !== 1 ? 's' : ''}`;

      const rows = ruleIssues
        .map((issue) =>
          issueRow(issue, getLine(issue.file, issue.line), autoFixEnabled, 'rule', projectDir),
        )
        .join('');

      const filesWithFixable = Array.from(
        new Set(ruleIssues.filter((i) => i.fixable).map((i) => i.file)),
      );
      const ruleFixBtn =
        filesWithFixable.length > 0
          ? fixFilesButton(filesWithFixable, 'Fix', `Auto-fix the fixable "${ruleId}" problems`)
          : '';

      return /* html */ `
    <div class="file-group" data-group-key="${escapeHtml(ruleId)}">
      <div class="file-header">
        ${RULE_SVG}
        <span class="file-path"><span class="file-name">${escapeHtml(ruleId)}</span></span>
        ${badge}
        <span class="file-badge">${countLabel}</span>
        ${ruleFixBtn}
        ${TOGGLE_GROUP_BTN}
      </div>
      <div class="issue-list">${rows}</div>
    </div>`;
    })
    .join('\n');
}

function buildWebviewHtml(
  issues: LintIssue[],
  projectDir: string,
  projectName: string,
  autoFixEnabled: boolean,
  mode: SortMode,
): string {
  if (issues.length === 0) {
    return emptyStateHtml(projectName);
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const fixableCount = issues.filter((i) => i.fixable).length;
  const manualCount = issues.length - fixableCount;
  const fileCount = new Set(issues.map((i) => i.file)).size;
  const hasFixable = fixableCount > 0;

  // Read each source file once to provide the offending line as Copilot context.
  const fileLines = new Map<string, string[]>();
  const getLine: LineGetter = (file, line) => {
    let lines = fileLines.get(file);
    if (!lines) {
      try {
        lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
      } catch {
        lines = [];
      }
      fileLines.set(file, lines);
    }
    return (lines[line - 1] ?? '').trim();
  };

  const groupsHtml =
    mode === 'file'
      ? renderByFile(issues, projectDir, autoFixEnabled, getLine)
      : renderByRule(issues, projectDir, autoFixEnabled, getLine);

  const fixAllBtn = hasFixable
    ? /* html */ `<button class="action-btn fix-all" id="fixAllBtn" title="Run eslint --fix for the whole project">${WRENCH_SVG}<span>Fix all auto-fixable</span></button>`
    : '';

  const filterPill = (value: string, cls: string, label: string): string =>
    `<button class="filter-pill ${cls}" data-value="${value}" title="Toggle ${label}">${label}</button>`;
  const sevFilters = [
    errorCount > 0
      ? filterPill('error', 'flt-error', `${errorCount} error${errorCount !== 1 ? 's' : ''}`)
      : '',
    warningCount > 0
      ? filterPill(
          'warning',
          'flt-warning',
          `${warningCount} warning${warningCount !== 1 ? 's' : ''}`,
        )
      : '',
  ].join('');
  const fixFilters = [
    fixableCount > 0 ? filterPill('fixable', 'flt-fixable', `${fixableCount} fixable`) : '',
    manualCount > 0 ? filterPill('manual', 'flt-manual', `${manualCount} manual`) : '',
  ].join('');
  // Only show a filter dimension when it actually splits the list in two.
  const showSev = errorCount > 0 && warningCount > 0;
  const showFix = fixableCount > 0 && manualCount > 0;
  const filterBar =
    showSev || showFix
      ? /* html */ `<div class="filter-bar">
        <span class="filter-label">Show:</span>
        ${showSev ? sevFilters : ''}
        ${showSev && showFix ? '<span class="filter-sep"></span>' : ''}
        ${showFix ? fixFilters : ''}
      </div>`
      : '';

  return /* html */ `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${ANALYSIS_PANEL_CSP}">
    <title>Lint</title>
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
      .header { margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border); }
      .header-title { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 6px; }
      .warn-icon {
        display: flex; align-items: center; justify-content: center;
        width: 24px; height: 24px; border-radius: 50%;
        background: rgba(220, 170, 60, 0.18);
        color: var(--vscode-problemsWarningIcon-foreground, #d9a93c);
        flex-shrink: 0; font-size: 14px; font-weight: 700; line-height: 1;
      }
      h1 { font-size: 1.15em; font-weight: 600; }
      .badge {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 22px; height: 18px; padding: 0 6px; border-radius: 9px;
        font-size: 0.75em; font-weight: 700;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      }
      .stats { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
      .spacer { flex: 1; }
      .filter-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .filter-label { font-size: 0.78em; color: var(--vscode-descriptionForeground); }
      .filter-sep { width: 1px; height: 16px; background: var(--vscode-panel-border); margin: 0 2px; }
      .filter-pill {
        font-size: 0.72em; font-weight: 700; text-transform: uppercase;
        padding: 2px 9px; border-radius: 8px; cursor: pointer; user-select: none;
        font-family: var(--vscode-font-family); white-space: nowrap;
        transition: opacity 0.15s, text-decoration 0.15s;
      }
      .filter-pill.flt-error { background: rgba(240, 100, 80, 0.15); color: var(--vscode-problemsErrorIcon-foreground, #f06450); border: 1px solid rgba(240, 100, 80, 0.3); }
      .filter-pill.flt-warning { background: rgba(220, 170, 60, 0.15); color: var(--vscode-problemsWarningIcon-foreground, #d9a93c); border: 1px solid rgba(220, 170, 60, 0.3); }
      .filter-pill.flt-fixable { background: rgba(80, 200, 120, 0.15); color: var(--vscode-testing-iconPassed, #4ec27a); border: 1px solid rgba(80, 200, 120, 0.3); }
      .filter-pill.flt-manual { background: rgba(128, 128, 128, 0.15); color: var(--vscode-descriptionForeground); border: 1px solid rgba(128, 128, 128, 0.3); }
      .filter-pill:hover { opacity: 0.8; }
      .filter-pill.pill-off { opacity: 0.4; text-decoration: line-through; }
      .file-group.all-hidden { display: none; }
      .sort-toggle { display: inline-flex; border: 1px solid var(--vscode-panel-border); border-radius: 5px; overflow: hidden; }
      .sort-btn {
        padding: 3px 10px; border: none; background: transparent;
        color: var(--vscode-foreground); font-size: 0.8em; font-family: var(--vscode-font-family);
        cursor: pointer;
      }
      .sort-btn + .sort-btn { border-left: 1px solid var(--vscode-panel-border); }
      .sort-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
      .sort-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
      .action-btn, .reload-btn {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 3px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
        background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        font-size: 0.8em; font-family: var(--vscode-font-family); cursor: pointer; white-space: nowrap;
      }
      .action-btn:hover, .reload-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25)); }
      .file-list { display: flex; flex-direction: column; gap: 12px; }
      .file-group { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
      .file-header {
        display: flex; align-items: center; gap: 8px; padding: 8px 12px;
        background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background, rgba(128,128,128,0.08)));
        border-bottom: 1px solid var(--vscode-panel-border); user-select: none; cursor: pointer;
      }
      .file-header:hover { background: var(--vscode-list-hoverBackground, var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.12))); }
      .toggle-group-btn {
        flex-shrink: 0; background: transparent; border: none; color: var(--vscode-icon-foreground);
        cursor: pointer; padding: 2px; display: flex; align-items: center; justify-content: center; border-radius: 3px;
      }
      .toggle-group-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
      .chevron { width: 16px; height: 16px; transition: transform 0.15s ease-in-out; transform: rotate(90deg); }
      .file-group.collapsed .chevron { transform: rotate(0deg); }
      .file-group.collapsed .issue-list { display: none; }
      .file-group.collapsed .file-header { border-bottom: none; }
      .collapse-btn {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 3px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
        background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        font-size: 0.8em; font-family: var(--vscode-font-family); cursor: pointer; white-space: nowrap;
      }
      .collapse-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25)); }
      .file-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--vscode-descriptionForeground); }
      .file-path { flex: 1; font-size: 0.88em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .file-dir { color: var(--vscode-descriptionForeground); }
      .file-name { font-weight: 600; }
      .file-badge {
        flex-shrink: 0; font-size: 0.75em; font-weight: 600; padding: 1px 8px; border-radius: 8px;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      }
      .tag-badge {
        flex-shrink: 0; font-size: 0.7em; font-weight: 700; text-transform: uppercase;
        padding: 1px 7px; border-radius: 8px;
      }
      .tag-badge.fixable { background: rgba(80, 200, 120, 0.15); color: var(--vscode-testing-iconPassed, #4ec27a); border: 1px solid rgba(80, 200, 120, 0.3); }
      .tag-badge.partial { background: rgba(220, 170, 60, 0.15); color: var(--vscode-problemsWarningIcon-foreground, #d9a93c); border: 1px solid rgba(220, 170, 60, 0.3); }
      .tag-badge.manual { background: rgba(128, 128, 128, 0.15); color: var(--vscode-descriptionForeground); border: 1px solid rgba(128, 128, 128, 0.3); }
      .issue-list { display: flex; flex-direction: column; }
      .issue-item {
        display: flex; align-items: flex-start; gap: 10px; padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .issue-item:last-child { border-bottom: none; }
      .issue-item:hover { background: var(--vscode-list-hoverBackground); }
      .line-num {
        flex-shrink: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.8em;
        color: var(--vscode-textLink-foreground); text-decoration: none; margin-top: 2px; white-space: nowrap;
      }
      .line-num:hover { text-decoration: underline; }
      .sev-pill {
        flex-shrink: 0; font-size: 0.68em; font-weight: 700; text-transform: uppercase;
        padding: 2px 6px; border-radius: 7px; margin-top: 1px;
      }
      .sev-error { background: rgba(240, 100, 80, 0.15); color: var(--vscode-problemsErrorIcon-foreground, #f06450); border: 1px solid rgba(240, 100, 80, 0.3); }
      .sev-warning { background: rgba(220, 170, 60, 0.15); color: var(--vscode-problemsWarningIcon-foreground, #d9a93c); border: 1px solid rgba(220, 170, 60, 0.3); }
      .rule-pill {
        flex-shrink: 0; font-size: 0.72em; font-family: var(--vscode-editor-font-family, monospace);
        padding: 1px 7px; border-radius: 8px; margin-top: 1px;
        background: rgba(100, 160, 240, 0.12); color: var(--vscode-terminal-ansiBrightBlue, #6aa0f0);
        border: 1px solid rgba(100, 160, 240, 0.25); white-space: nowrap;
      }
      .issue-summary {
        flex: 1; font-size: 0.88em; color: var(--vscode-editor-foreground); padding-top: 1px; word-break: break-word;
      }
      .fix-btn, .copilot-fix-btn, .fix-file-btn, .copilot-fix-file-btn {
        flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px;
        font-family: var(--vscode-font-family); cursor: pointer;
        transition: background 0.15s, color 0.15s, border-color 0.15s, opacity 0.15s;
      }
      .fix-btn {
        padding: 2px 8px; font-size: 0.75em; border-radius: 4px;
        border: 1px solid rgba(80, 200, 120, 0.4); background: rgba(80, 200, 120, 0.1);
        color: var(--vscode-testing-iconPassed, #4ec27a);
      }
      .fix-btn:hover { background: rgba(80, 200, 120, 0.2); border-color: rgba(80, 200, 120, 0.7); }
      .copilot-fix-btn {
        width: 22px; height: 22px; padding: 3px; border: none; border-radius: 4px; background: transparent;
        color: var(--vscode-terminal-ansiBrightMagenta, #b464f0); opacity: 0.65;
      }
      .issue-item:hover .copilot-fix-btn { opacity: 0.9; }
      .copilot-fix-btn:hover { opacity: 1 !important; background: rgba(180, 100, 240, 0.15); color: #c084fc; }
      .fix-file-btn {
        padding: 2px 8px; font-size: 0.75em; border-radius: 4px;
        border: 1px solid rgba(80, 200, 120, 0.4); background: rgba(80, 200, 120, 0.08);
        color: var(--vscode-testing-iconPassed, #4ec27a);
      }
      .fix-file-btn:hover { background: rgba(80, 200, 120, 0.18); border-color: rgba(80, 200, 120, 0.7); }
      .copilot-fix-file-btn {
        padding: 2px 8px; font-size: 0.75em; border-radius: 4px;
        border: 1px solid rgba(180, 100, 240, 0.35); background: rgba(180, 100, 240, 0.08);
        color: var(--vscode-terminal-ansiBrightMagenta, #b464f0);
      }
      .copilot-fix-file-btn:hover { background: rgba(180, 100, 240, 0.18); border-color: rgba(180, 100, 240, 0.6); color: #c084fc; }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="header-title">
        <span class="warn-icon">!</span>
        <h1>Node Lint</h1>
        <span class="badge">${issues.length}</span>
        <span class="spacer"></span>
        <div class="sort-toggle">
          <button class="sort-btn ${mode === 'file' ? 'active' : ''}" data-mode="file">Group by file</button>
          <button class="sort-btn ${mode === 'rule' ? 'active' : ''}" data-mode="rule">Group by rule</button>
        </div>
        ${fixAllBtn}
        <button class="collapse-btn" id="toggleTablesBtn" title="Collapse or expand all groups">${COLLAPSE_ALL_SVG}<span id="toggleTablesLabel">Collapse all</span></button>
        <button class="reload-btn" id="reloadBtn">${RELOAD_SVG}Reload</button>
      </div>
      <p class="stats">Project: ${escapeHtml(projectName)} &middot; ${errorCount} error${errorCount !== 1 ? 's' : ''} &middot; ${warningCount} warning${warningCount !== 1 ? 's' : ''} &middot; ${fileCount} file${fileCount !== 1 ? 's' : ''}</p>
      ${filterBar}
    </div>
    <div class="file-list">
      ${groupsHtml}
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

      document.querySelectorAll('a[data-file]').forEach(function (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          vscode.postMessage({
            command: 'openFile',
            file: link.getAttribute('data-file'),
            line: parseInt(link.getAttribute('data-line'), 10)
          });
        });
      });
      document.querySelectorAll('.sort-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          vscode.postMessage({ command: 'sort', mode: btn.getAttribute('data-mode') });
        });
      });
      document.getElementById('reloadBtn').addEventListener('click', function () {
        vscode.postMessage({ command: 'reload' });
      });
      // ── Persisted UI state (filters + collapsed groups) survives Reload ────────
      var uiState = vscode.getState() || {};
      var collapsedGroups = uiState.collapsedGroups || [];
      var filterState = uiState.filterState || { error: true, warning: true, fixable: true, manual: true };
      function persistUiState() {
        var s = vscode.getState() || {};
        s.collapsedGroups = collapsedGroups;
        s.filterState = filterState;
        vscode.setState(s);
      }
      document.querySelectorAll('.file-group').forEach(function (group) {
        var key = group.getAttribute('data-group-key');
        if (key && collapsedGroups.indexOf(key) !== -1) {
          group.classList.add('collapsed');
        }
      });
      document.querySelectorAll('.file-group .file-header').forEach(function (header) {
        header.addEventListener('click', function (e) {
          if (e.target.closest('a, .fix-file-btn, .copilot-fix-file-btn, .fix-btn, .copilot-fix-btn')) { return; }
          var group = header.parentElement;
          group.classList.toggle('collapsed');
          var key = group.getAttribute('data-group-key');
          if (key) {
            var idx = collapsedGroups.indexOf(key);
            if (group.classList.contains('collapsed')) {
              if (idx === -1) { collapsedGroups.push(key); }
            } else if (idx !== -1) {
              collapsedGroups.splice(idx, 1);
            }
            persistUiState();
          }
        });
      });
      var toggleTablesBtn = document.getElementById('toggleTablesBtn');
      var toggleTablesLabel = document.getElementById('toggleTablesLabel');
      (function initToggleLabel() {
        var groups = document.querySelectorAll('.file-group');
        var anyExpanded = Array.prototype.some.call(groups, function (g) {
          return !g.classList.contains('collapsed');
        });
        toggleTablesLabel.textContent = anyExpanded ? 'Collapse all' : 'Expand all';
      })();
      toggleTablesBtn.addEventListener('click', function () {
        var groups = document.querySelectorAll('.file-group');
        var anyExpanded = Array.prototype.some.call(groups, function (g) {
          return !g.classList.contains('collapsed');
        });
        groups.forEach(function (g) {
          g.classList.toggle('collapsed', anyExpanded);
          var key = g.getAttribute('data-group-key');
          if (key) {
            var idx = collapsedGroups.indexOf(key);
            if (anyExpanded) {
              if (idx === -1) { collapsedGroups.push(key); }
            } else if (idx !== -1) {
              collapsedGroups.splice(idx, 1);
            }
          }
        });
        toggleTablesLabel.textContent = anyExpanded ? 'Expand all' : 'Collapse all';
        persistUiState();
      });
      // ── Severity / fixability filters ──────────────────────────────────────
      function applyFilters() {
        document.querySelectorAll('.issue-item').forEach(function (item) {
          var sev = item.getAttribute('data-severity');
          var fixKey = item.getAttribute('data-fixable') === 'true' ? 'fixable' : 'manual';
          var visible = filterState[sev] !== false && filterState[fixKey] !== false;
          item.style.display = visible ? '' : 'none';
        });
        document.querySelectorAll('.file-group').forEach(function (group) {
          var items = group.querySelectorAll('.issue-item');
          var allHidden = Array.prototype.every.call(items, function (i) { return i.style.display === 'none'; });
          group.classList.toggle('all-hidden', allHidden);
        });
      }
      document.querySelectorAll('.filter-pill').forEach(function (pill) {
        var initKey = pill.getAttribute('data-value');
        if (filterState[initKey] === false) {
          pill.classList.add('pill-off');
        }
        pill.addEventListener('click', function () {
          var key = pill.getAttribute('data-value');
          filterState[key] = !filterState[key];
          pill.classList.toggle('pill-off', !filterState[key]);
          applyFilters();
          persistUiState();
        });
      });
      applyFilters();
      var fixAll = document.getElementById('fixAllBtn');
      if (fixAll) {
        fixAll.addEventListener('click', function () {
          vscode.postMessage({ command: 'eslintFixAll' });
        });
      }
      document.querySelectorAll('.fix-btn, .fix-file-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          vscode.postMessage({
            command: 'eslintFix',
            files: JSON.parse(btn.getAttribute('data-files') || '[]')
          });
        });
      });
      document.querySelectorAll('.copilot-fix-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          vscode.postMessage({
            command: btn.getAttribute('data-command') || 'copilotFix',
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
      document.querySelectorAll('.copilot-fix-file-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          vscode.postMessage({
            command: btn.getAttribute('data-command') || 'copilotFixFile',
            file: btn.getAttribute('data-file'),
            issues: JSON.parse(btn.getAttribute('data-issues') || '[]')
          });
        });
      });
    </script>
  </body>
  </html>`;
}

function emptyStateHtml(projectName: string): string {
  const messages = [
    '0 lint problems! Clean as a whistle. ✨',
    '0 lint problems! Your linter is bored. 😴',
    "0 lint problems! Pristine code, chef's kiss. 👨‍🍳",
    '0 lint problems! Not a single nit to pick. 🐛',
    '0 lint problems! The style guide approves. 📐',
  ];
  const msg = messages[Math.floor(Math.random() * messages.length)];

  return /* html */ `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${ANALYSIS_PANEL_CSP}">
    <title>Lint</title>
    <style>
      body {
        font-family: var(--vscode-font-family); color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        height: 100vh; text-align: center; margin: 0;
      }
      h1 { font-size: 1.6em; color: var(--vscode-testing-iconPassed); }
      p { color: var(--vscode-descriptionForeground); margin-top: 6px; }
      .reload-btn {
        margin-top: 20px; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      }
      .reload-btn:hover { background: var(--vscode-button-hoverBackground); }
    </style>
  </head>
  <body>
    <h1>${msg}</h1>
    <p>Project: ${escapeHtml(projectName)}</p>
    <button class="reload-btn" id="reloadBtn">Lint Again</button>
    <script>
      const vscode = acquireVsCodeApi();
      document.getElementById('reloadBtn').addEventListener('click', function () {
        vscode.postMessage({ command: 'reload' });
      });
    </script>
  </body>
  </html>`;
}
