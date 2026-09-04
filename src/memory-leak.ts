import * as vscode from 'vscode';
import * as path from 'path';
import {
  resolveWorkspaceAndProjects,
  detectActiveFileProject,
  getLastProject,
  setLastProject,
} from './utils';
import type { NodeWorkspaceProject } from './types';
import { findMemoryLeaksInFile, MemoryLeakLocation, MemoryLeakKind } from './ast-utils';
import { parseNodeFilePath } from './pure-utils';
import {
  sendCopilotAutoFix,
  sendCopilotAutoFixForFile,
  sendAIAutoFix,
  sendAIAutoFixForFile,
  getAIProvider,
} from './copilot-fix';
import { createAnalysisPanel, escapeHtml, ANALYSIS_PANEL_CSP } from './webview-utils';

const COMMAND_KEY = 'checkMemoryLeaks';

// ── Entry point ────────────────────────────────────────────────────────────────

export async function checkMemoryLeaks(): Promise<void> {
  const resolved = await resolveWorkspaceAndProjects();
  if (!resolved) {
    return;
  }
  const { projects } = resolved;

  const picked = await pickScope(projects);
  if (!picked) {
    return;
  }

  const { filesToCheck, scopeLabel } = picked;

  if (filesToCheck.length === 0) {
    vscode.window.showWarningMessage('No source files found for the selected scope.');
    return;
  }

  // ── Run AST analysis with progress ────────────────────────────────────────

  const results = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Checking for memory leaks…',
      cancellable: false,
    },
    async (progress) => {
      const leaks: MemoryLeakLocation[] = [];
      const total = filesToCheck.length;
      for (let i = 0; i < total; i++) {
        const file = filesToCheck[i];
        progress.report({
          increment: (1 / total) * 100,
          message: path.basename(file),
        });
        const fileLeaks = findMemoryLeaksInFile(file);
        leaks.push(...fileLeaks);
      }
      return leaks;
    },
  );

  // ── Show results ──────────────────────────────────────────────────────────

  if (results.length === 0) {
    vscode.window.showInformationMessage('No memory leaks detected. Great job!');
    return;
  }

  showMemoryLeaksWebview(results, filesToCheck, scopeLabel);
}

async function pickScope(
  projects: NodeWorkspaceProject[],
): Promise<{ filesToCheck: string[]; scopeLabel: string } | null> {
  const projectNames = projects.map((p) => p.name);

  // ── Build quick-pick choices ───────────────────────────────────────────────
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const isSourceFile =
    !!activeFile &&
    parseNodeFilePath(activeFile) !== null &&
    parseNodeFilePath(activeFile)?.isTest !== true;
  const CURRENT_FILE_LABEL = isSourceFile
    ? `$(file)  Current file (${path.basename(activeFile!)})`
    : null;

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
    ...(CURRENT_FILE_LABEL ? [CURRENT_FILE_LABEL] : []),
    ...(CURRENT_PROJECT_LABEL ? [CURRENT_PROJECT_LABEL] : []),
    ...(LAST_LABEL ? [LAST_LABEL] : []),
    ...projectNames,
  ];

  if (choices.length === 0) {
    vscode.window.showErrorMessage('No projects found and no source file is open.');
    return null;
  }

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select a file or project to check for memory leaks',
    title: 'Node: Check Memory Leaks',
  });

  if (!picked) {
    return null;
  }

  // ── Resolve file list from selection ──────────────────────────────────────

  if (CURRENT_FILE_LABEL && picked === CURRENT_FILE_LABEL) {
    return { filesToCheck: [activeFile!], scopeLabel: path.basename(activeFile!) };
  }

  let project: NodeWorkspaceProject;
  if (CURRENT_PROJECT_LABEL && picked === CURRENT_PROJECT_LABEL) {
    project = currentInList!;
    setLastProject(COMMAND_KEY, project.name);
  } else if (LAST_LABEL && picked === LAST_LABEL) {
    project = lastProject!;
  } else {
    const found = projects.find((p) => p.name === picked);
    if (!found) {
      return null;
    }
    project = found;
    setLastProject(COMMAND_KEY, project.name);
  }

  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(project.dir, '**/*.{ts,tsx,js,jsx,mjs,cjs}'),
    '**/{node_modules,dist,out,coverage,.git}/**',
  );
  const filesToCheck = uris.map((u) => u.fsPath).filter((f) => parseNodeFilePath(f)?.isTest !== true);

  return { filesToCheck, scopeLabel: project.name };
}

// ── Webview ────────────────────────────────────────────────────────────────────

function memoryLeaksTitle(scopeLabel: string, count: number): string {
  return `Memory Leaks: ${scopeLabel} (${count})`;
}

/**
 * Creates a fresh panel for the given results. Each run opens its own tab; the
 * panel's Reload button re-scans the same files and refreshes that tab in place.
 */
function showMemoryLeaksWebview(
  leaks: MemoryLeakLocation[],
  filesToCheck: string[],
  scopeLabel: string,
): void {
  const autoFixEnabled = (): boolean =>
    vscode.workspace.getConfiguration('nodeCliPlus').get<boolean>('ai.autoFixEnabled', true);

  const aiProvider = (): string => getAIProvider();

  const analysisPanel = createAnalysisPanel(
    'nodeMemoryLeaks',
    memoryLeaksTitle(scopeLabel, leaks.length),
  );
  analysisPanel.setHtml(buildWebviewHtml(leaks, autoFixEnabled()));

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
      // aiFixFile payload
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
        void vscode.window.showTextDocument(uri, {
          selection: new vscode.Range(
            new vscode.Position(message.line - 1, 0),
            new vscode.Position(message.line - 1, 0),
          ),
          preview: false,
        });
      } else if (message.command === 'reload') {
        const freshLeaks = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Checking for memory leaks…',
            cancellable: false,
          },
          async (progress) => {
            const found: MemoryLeakLocation[] = [];
            const total = filesToCheck.length;
            for (let i = 0; i < total; i++) {
              progress.report({
                increment: (1 / total) * 100,
                message: path.basename(filesToCheck[i]),
              });
              found.push(...findMemoryLeaksInFile(filesToCheck[i]));
            }
            return found;
          },
        );
        analysisPanel.setTitle(memoryLeaksTitle(scopeLabel, freshLeaks.length));
        analysisPanel.setHtml(buildWebviewHtml(freshLeaks, autoFixEnabled()));
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
          issueType: 'Memory Leak',
        });
      }
    },
  );
}

// ── Kind metadata ──────────────────────────────────────────────────────────────

const KIND_LABEL: Record<MemoryLeakKind, string> = {
  'nested-subscribe': 'Nested Subscribe',
  'unremoved-subscription': 'Unremoved Subscription',
  'uncleared-interval': 'Uncleared Interval',
  'uncleared-timeout': 'Uncleared Timeout',
  'unremoved-event-listener': 'Unremoved Event Listener',
  'retained-dom-reference': 'Retained DOM Reference',
  'incomplete-takeuntil-subject': 'Incomplete takeUntil Subject',
};

const KIND_DESCRIPTION: Record<MemoryLeakKind, string> = {
  'nested-subscribe': '.subscribe() called inside another .subscribe() callback',
  'unremoved-subscription':
    'Subscription stored on this.x but .unsubscribe() is never called',
  'uncleared-interval':
    'setInterval() whose return value is never passed to clearInterval()',
  'uncleared-timeout':
    'setTimeout() whose return value is stored but never passed to clearTimeout()',
  'unremoved-event-listener':
    'addEventListener()/emitter.on() with no matching removeEventListener()/off()',
  'retained-dom-reference':
    'document.querySelector()/getElementById() result stored on this but never nulled',
  'incomplete-takeuntil-subject':
    'Subject used in takeUntil() but .next()/.complete() is never called',
};

const KIND_FIX_HINT: Record<MemoryLeakKind, string> = {
  'nested-subscribe':
    'Flatten with switchMap, mergeMap, or concatMap instead of nesting subscriptions',
  'unremoved-subscription':
    'Store the Subscription and call .unsubscribe() on it in your close()/dispose()/stop() method, or use takeUntil with a completed Subject',
  'uncleared-interval':
    'Store the ID and call clearInterval(...) in your close()/dispose()/stop() method',
  'uncleared-timeout':
    'Call clearTimeout(...) when the pending result is no longer needed',
  'unremoved-event-listener':
    'Call removeEventListener()/off() with the same handler reference in your cleanup path; keep a named handler instead of an inline arrow',
  'retained-dom-reference':
    'Set the property to null when the element is no longer needed so it can be garbage-collected',
  'incomplete-takeuntil-subject':
    'Call destroy$.next(); destroy$.complete(); in your cleanup path so takeUntil subscriptions end',
};

const KIND_LEGEND_TITLE: Record<MemoryLeakKind, string> = {
  'nested-subscribe': 'Nested',
  'unremoved-subscription': 'Subscription',
  'uncleared-interval': 'Interval',
  'uncleared-timeout': 'Timeout',
  'unremoved-event-listener': 'Event Listener',
  'retained-dom-reference': 'DOM Reference',
  'incomplete-takeuntil-subject': 'takeUntil Subject',
};

// ── HTML ───────────────────────────────────────────────────────────────────────

function buildWebviewHtml(leaks: MemoryLeakLocation[], autoFixEnabled: boolean): string {
  // Group leaks by file (absolute path for grouping, display relative-style via basename)
  const byFile = new Map<string, MemoryLeakLocation[]>();
  for (const leak of leaks) {
    const group = byFile.get(leak.file) ?? [];
    group.push(leak);
    byFile.set(leak.file, group);
  }

  const copilotIconSvg = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z" fill="currentColor"/>
    <path d="M13 1L13.75 3.25L16 4L13.75 4.75L13 7L12.25 4.75L10 4L12.25 3.25L13 1Z" fill="currentColor" opacity="0.7"/>
    <path d="M3 10L3.5 11.5L5 12L3.5 12.5L3 14L2.5 12.5L1 12L2.5 11.5L3 10Z" fill="currentColor" opacity="0.7"/>
  </svg>`;

  const fileGroups = Array.from(byFile.entries())
    .map(([filePath, fileLeaks]) => {
      const rel = filePath.replaceAll('\\', '/');
      const dir = rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/') + 1) : '';
      const filename = path.basename(rel);
      const absolutePath = escapeHtml(filePath);
      const countLabel = fileLeaks.length === 1 ? '1 leak' : `${fileLeaks.length} leaks`;

      const leakRows = fileLeaks
        .map((leak) => {
          const highlightedSnippet = escapeHtml(leak.snippet)
            .replace(/(\.\s*subscribe\s*\()/g, '<mark>$1</mark>')
            .replace(/(setInterval\s*\()/g, '<mark>$1</mark>')
            .replace(/(setTimeout\s*\()/g, '<mark>$1</mark>')
            .replace(/((?:add|remove)EventListener\s*\()/g, '<mark>$1</mark>')
            .replace(
              /(getElementById|querySelector(?:All)?|getElementsByClassName|getElementsByTagName|getElementsByName)(\s*\()/g,
              '<mark>$1$2</mark>',
            )
            .replace(
              /(new\s+(?:Subject|BehaviorSubject|ReplaySubject|AsyncSubject)\s*[<(])/g,
              '<mark>$1</mark>',
            );
          const aiBtn = autoFixEnabled
            ? /* html */ `<button class="ai-fix-btn copilot-fix-btn" title="Auto Fix with AI"
                data-command="aiFix"
                data-file="${absolutePath}"
                data-line="${leak.line}"
                data-kind="${escapeHtml(leak.kind)}"
                data-kind-label="${escapeHtml(KIND_LABEL[leak.kind])}"
                data-snippet="${escapeHtml(leak.snippet)}"
                data-description="${escapeHtml(KIND_DESCRIPTION[leak.kind])}"
                data-fix-hint="${escapeHtml(KIND_FIX_HINT[leak.kind])}"
              >${copilotIconSvg}</button>`
            : '';
          return /* html */ `
          <div class="leak-item" data-kind="${leak.kind}">
            <a class="line-num" href="#" data-file="${absolutePath}" data-line="${leak.line}">Line ${leak.line}</a>
            <span class="kind-pill kind-${leak.kind}">${KIND_LABEL[leak.kind]}</span>
            <code class="snippet">${highlightedSnippet}</code>
            ${aiBtn}
          </div>`;
        })
        .join('');

      const fileFixAllBtn = autoFixEnabled
        ? /* html */ `<button class="ai-fix-file-btn copilot-fix-file-btn" title="Auto Fix all ${fileLeaks.length} leak${fileLeaks.length !== 1 ? 's' : ''} in this file with AI"
            data-command="aiFixFile"
            data-file="${absolutePath}"
            data-issues="${escapeHtml(
              JSON.stringify(
                fileLeaks.map((l) => ({
                  line: l.line,
                  kind: l.kind,
                  kindLabel: KIND_LABEL[l.kind],
                  snippet: l.snippet,
                  description: KIND_DESCRIPTION[l.kind],
                  fixHint: KIND_FIX_HINT[l.kind],
                })),
              ),
            )}"
          >${copilotIconSvg}<span>Fix all</span></button>`
        : '';

      return /* html */ `
      <div class="file-group" data-group-key="${absolutePath}">
        <div class="file-header">
          <svg class="file-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6L9 1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
            <path d="M9 1v5h5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
          <span class="file-path"><span class="file-dir">${escapeHtml(dir)}</span><span class="file-name">${escapeHtml(filename)}</span></span>
          <span class="file-badge">${countLabel}</span>
          ${fileFixAllBtn}
          <button class="toggle-group-btn" title="Collapse/expand this file">
            <svg class="chevron" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M5.5 3L10.5 8L5.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <div class="leak-list">${leakRows}</div>
      </div>`;
    })
    .join('\n');

  const filesCount = byFile.size;
  const kindCount = (kind: MemoryLeakKind) => leaks.filter((l) => l.kind === kind).length;

  const statsParts: string[] = [`${filesCount} file${filesCount !== 1 ? 's' : ''} affected`];
  for (const kind of Object.keys(KIND_LABEL) as MemoryLeakKind[]) {
    const n = kindCount(kind);
    if (n > 0) {
      statsParts.push(`${n} ${KIND_LEGEND_TITLE[kind].toLowerCase()}${n !== 1 ? 's' : ''}`);
    }
  }
  const statsLabel = statsParts.join(' &middot; ');

  const legendRows = (Object.keys(KIND_LABEL) as MemoryLeakKind[])
    .map((kind) => {
      return /* html */ `
      <span class="legend-item">
        <span class="kind-pill kind-${kind}" data-kind="${kind}">${KIND_LEGEND_TITLE[kind]}</span>
        <span class="legend-desc-group">
          <span class="legend-desc">${escapeHtml(KIND_DESCRIPTION[kind])}</span>
          <span class="legend-fix"><strong>Fix:</strong> ${escapeHtml(KIND_FIX_HINT[kind])}</span>
        </span>
      </span>`;
    })
    .join('<hr class="legend-sep">');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${ANALYSIS_PANEL_CSP}">
  <title>Memory Leaks</title>
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

    /* ── Header ── */
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

    .warn-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--vscode-inputValidation-warningBackground, #6b5000);
      color: var(--vscode-inputValidation-warningForeground, #ffcc00);
      flex-shrink: 0;
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
    }

    h1 {
      font-size: 1.15em;
      font-weight: 600;
      color: var(--vscode-foreground);
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

    .legend {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
    }

    .legend-desc-group {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
    }

    .legend-fix {
      font-size: 0.78em;
      color: var(--vscode-foreground, #ccc);
      opacity: 0.6;
    }

    .legend-sep {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.18));
      margin: 5px 0;
    }

    /* ── Kind pills ── */
    .kind-pill {
      flex-shrink: 0;
      font-size: 0.72em;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      padding: 1px 7px;
      border-radius: 8px;
      white-space: nowrap;
    }

    .kind-nested-subscribe {
      background: rgba(240, 100, 80, 0.15);
      color: var(--vscode-problemsErrorIcon-foreground, #f06450);
      border: 1px solid rgba(240, 100, 80, 0.3);
    }

    .kind-unremoved-subscription {
      background: rgba(204, 167, 0, 0.18);
      color: var(--vscode-problemsWarningIcon-foreground, #cca700);
      border: 1px solid rgba(204, 167, 0, 0.35);
    }

    .kind-uncleared-interval {
      background: rgba(100, 160, 240, 0.15);
      color: var(--vscode-terminal-ansiBrightBlue, #6aa0f0);
      border: 1px solid rgba(100, 160, 240, 0.3);
    }

    .kind-unremoved-event-listener {
      background: rgba(180, 100, 240, 0.15);
      color: var(--vscode-terminal-ansiBrightMagenta, #b464f0);
      border: 1px solid rgba(180, 100, 240, 0.3);
    }

    .kind-retained-dom-reference {
      background: rgba(60, 180, 140, 0.15);
      color: var(--vscode-terminal-ansiBrightGreen, #3cb48c);
      border: 1px solid rgba(60, 180, 140, 0.3);
    }

    .kind-uncleared-timeout {
      background: rgba(100, 160, 240, 0.12);
      color: var(--vscode-terminal-ansiBrightCyan, #5bb8d4);
      border: 1px solid rgba(100, 160, 240, 0.28);
    }

    .kind-incomplete-takeuntil-subject {
      background: rgba(220, 80, 160, 0.15);
      color: var(--vscode-terminal-ansiBrightMagenta, #dc50a0);
      border: 1px solid rgba(220, 80, 160, 0.3);
    }

    /* ── File groups ── */
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
      cursor: pointer;
    }

    .file-header:hover {
      background: var(--vscode-list-hoverBackground, var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.12)));
    }

    .toggle-group-btn {
      flex-shrink: 0;
      background: transparent;
      border: none;
      color: var(--vscode-icon-foreground);
      cursor: pointer;
      padding: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 3px;
    }

    .toggle-group-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
    }

    .chevron {
      width: 16px;
      height: 16px;
      transition: transform 0.15s ease-in-out;
      transform: rotate(90deg);
    }

    .file-group.collapsed .chevron {
      transform: rotate(0deg);
    }

    .file-group.collapsed .leak-list {
      display: none;
    }

    .file-group.collapsed .file-header {
      border-bottom: none;
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

    .file-dir {
      color: var(--vscode-descriptionForeground);
    }

    .file-name {
      color: var(--vscode-foreground);
      font-weight: 600;
    }

    .file-badge {
      flex-shrink: 0;
      font-size: 0.75em;
      font-weight: 600;
      padding: 1px 8px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    /* ── Leak items ── */
    .leak-list {
      display: flex;
      flex-direction: column;
    }

    .leak-item {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 7px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      transition: background 0.1s;
    }

    .leak-item:last-child {
      border-bottom: none;
    }

    .leak-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .line-num {
      flex-shrink: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      min-width: 52px;
      text-align: right;
      opacity: 0.85;
    }

    .line-num:hover {
      text-decoration: underline;
      opacity: 1;
    }

    .snippet {
      flex: 1;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.88em;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
      padding: 3px 8px;
      border-radius: 4px;
      white-space: pre;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }

    mark {
      background: transparent;
      color: var(--vscode-problemsWarningIcon-foreground, #cca700);
      font-weight: 600;
    }

    /* ── Reload button ── */
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

    .collapse-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
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

    .collapse-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25));
    }

    .reload-btn.spinning svg {
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    /* ── AI fix button ── */
    .copilot-fix-btn {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 3px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-terminal-ansiBrightMagenta, #b464f0);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s, background 0.15s, color 0.15s;
      margin-left: 4px;
    }

    .leak-item:hover .copilot-fix-btn {
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
      margin-left: auto;
    }
    .copilot-fix-file-btn:hover {
      background: rgba(180, 100, 240, 0.18);
      border-color: rgba(180, 100, 240, 0.6);
      color: #c084fc;
    }
    .copilot-fix-file-btn:active {
      background: rgba(180, 100, 240, 0.28);
    }

    /* ── Filter toggle pills ── */
    .legend-item .kind-pill {
      cursor: pointer;
      user-select: none;
      transition: opacity 0.15s, text-decoration 0.15s;
    }

    .legend-item .kind-pill:hover {
      opacity: 0.8;
    }

    .legend-item .kind-pill.pill-off {
      opacity: 0.35;
      text-decoration: line-through;
    }

    .file-group.all-hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-title">
      <span class="warn-icon">!</span>
      <h1>Node Memory Leaks</h1>
      <span class="badge">${leaks.length}</span>
      <button class="reload-btn" id="reloadBtn" title="Re-run analysis">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13">
          <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2L11 6h3.5V2.5L13 4a7 7 0 1 0 .5 4H13.5z" fill="currentColor"/>
        </svg>
        Reload
      </button>
      <button class="collapse-btn" id="toggleTablesBtn" title="Collapse or expand all files">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13">
          <path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        <span id="toggleTablesLabel">Collapse all</span>
      </button>
    </div>
    <p class="stats">${statsLabel}</p>
    <div class="legend">
      ${legendRows}
    </div>
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

    // ── Reload button ──────────────────────────────────────────────────
    var reloadBtn = document.getElementById('reloadBtn');
    reloadBtn.addEventListener('click', function() {
      reloadBtn.classList.add('spinning');
      reloadBtn.disabled = true;
      vscode.postMessage({ command: 'reload' });
    });

    // ── AI fix buttons (per-issue) ───────────────────────────────────────
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

    // ── AI fix all buttons (per-file) ────────────────────────────────────
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

    // ── Persisted UI state (kind filters + collapsed groups) survives Reload ───
    var uiState = vscode.getState() || {};
    var collapsedGroups = uiState.collapsedGroups || [];
    var offKinds = uiState.offKinds || [];
    function persistUiState() {
      var s = vscode.getState() || {};
      s.collapsedGroups = collapsedGroups;
      s.offKinds = offKinds;
      vscode.setState(s);
    }

    // ── Collapse / expand file groups ─────────────────────────────────────────
    document.querySelectorAll('.file-group').forEach(function (group) {
      var key = group.getAttribute('data-group-key');
      if (key && collapsedGroups.indexOf(key) !== -1) {
        group.classList.add('collapsed');
      }
    });
    document.querySelectorAll('.file-group .file-header').forEach(function(header) {
      header.addEventListener('click', function(e) {
        if (e.target.closest('a, .copilot-fix-file-btn')) { return; }
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
      var anyExpanded = Array.prototype.some.call(groups, function(g) {
        return !g.classList.contains('collapsed');
      });
      toggleTablesLabel.textContent = anyExpanded ? 'Collapse all' : 'Expand all';
    })();
    toggleTablesBtn.addEventListener('click', function() {
      var groups = document.querySelectorAll('.file-group');
      var anyExpanded = Array.prototype.some.call(groups, function(g) {
        return !g.classList.contains('collapsed');
      });
      groups.forEach(function(g) {
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

    // ── Kind filter toggles ──────────────────────────────────────────────────
    function applyKindFilter(kind, isOff) {
      document.querySelectorAll('.leak-item[data-kind="' + kind + '"]').forEach(function(item) {
        item.style.display = isOff ? 'none' : '';
      });
      document.querySelectorAll('.file-group').forEach(function(group) {
        var items = group.querySelectorAll('.leak-item');
        var allHidden = Array.prototype.every.call(items, function(item) {
          return item.style.display === 'none';
        });
        group.classList.toggle('all-hidden', allHidden);
      });
    }
    document.querySelectorAll('.legend-item .kind-pill[data-kind]').forEach(function(pill) {
      var kind = pill.getAttribute('data-kind');
      if (offKinds.indexOf(kind) !== -1) {
        pill.classList.add('pill-off');
        applyKindFilter(kind, true);
      }
      pill.addEventListener('click', function() {
        var isOff = pill.classList.toggle('pill-off');
        applyKindFilter(kind, isOff);
        var idx = offKinds.indexOf(kind);
        if (isOff) {
          if (idx === -1) { offKinds.push(kind); }
        } else if (idx !== -1) {
          offKinds.splice(idx, 1);
        }
        persistUiState();
      });
    });
  </script>
</body>
</html>`;
}
