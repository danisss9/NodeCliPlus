import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { NodeWorkspaceProject } from './types';
import { extensionTerminals, getTrackedTerminalState } from './state';
import {
  resolveWorkspaceAndProjects,
  runInTerminal,
  pickProjectWithCurrentFile,
  pickWorkspaceFolder,
} from './utils';
import { parseNodeFilePath, getNodeSiblingPaths } from './pure-utils';
import { getSavedScript, pickScriptWithPrefs } from './script-prefs';

// ── Script alias preferences ───────────────────────────────────────────────────

const SERVE_SCRIPT_ALIASES = [
  'dev',
  'serve',
  'start',
  'start:dev',
  'server',
  'develop',
  'watch',
  'run',
];

const BUILD_SCRIPT_ALIASES = ['build', 'compile', 'dist', 'build:prod', 'build:production'];

const BUILD_WATCH_SCRIPT_ALIASES = ['build:watch', 'watch', 'build:dev', 'dev:build'];

const TEST_SCRIPT_ALIASES = ['test', 'tests', 'unit', 'test:unit', 'e2e', 'integration'];

// ── Source / test file switching ───────────────────────────────────────────────

export async function switchFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor');
    return;
  }

  const currentPath = editor.document.uri.fsPath;
  const parsed = parseNodeFilePath(currentPath);
  if (!parsed) {
    vscode.window.showInformationMessage(
      'Current file is not a JavaScript/TypeScript source or test file',
    );
    return;
  }

  const candidates = getNodeSiblingPaths(parsed.basePath);
  const existing = candidates.filter((p) => fs.existsSync(p));

  if (existing.length <= 1) {
    vscode.window.showInformationMessage('No sibling source/test files found');
    return;
  }

  const labelFor = (filePath: string): string => {
    const p = parseNodeFilePath(filePath);
    const ext = p ? p.suffix : path.extname(filePath);
    if (p?.isTest) {
      return `$(beaker)  Test (${ext})`;
    }
    return `$(file-code)  Source (${ext})`;
  };

  type FileItem = vscode.QuickPickItem & { filePath: string };
  const items: FileItem[] = existing.map((p) => ({
    label: labelFor(p),
    filePath: p,
    description: p === currentPath ? '(current)' : undefined,
  }));

  const qp = vscode.window.createQuickPick<FileItem>();
  qp.items = items;
  qp.placeholder = 'Switch to source/test file…';
  qp.title = `Switch: ${path.basename(parsed.basePath)}.*`;
  qp.activeItems = items.filter((i) => i.filePath === currentPath);
  qp.matchOnDescription = true;

  const chosen = await new Promise<FileItem | undefined>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]);
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();

  if (!chosen || chosen.filePath === currentPath) {
    return;
  }

  const doc = await vscode.workspace.openTextDocument(chosen.filePath);
  await vscode.window.showTextDocument(doc, editor.viewColumn);
}

// ── Serve ─────────────────────────────────────────────────────────────────────

export async function serveNodeProject() {
  const resolved = await resolveWorkspaceAndProjects();
  if (!resolved) {
    return;
  }
  const { projects } = resolved;

  const project = await pickProjectWithCurrentFile(projects, 'Node Serve: Select Project', 'serve');
  if (!project) {
    return;
  }

  const script = await pickScriptWithPrefs({
    project,
    aliases: SERVE_SCRIPT_ALIASES,
    title: 'Node Serve: Select Script',
    placeHolder: 'Select an npm script',
    commandKey: 'serve',
  });
  if (!script) {
    return;
  }

  const terminalName = `serve: ${script} (${project.name})`;
  void runInTerminal(terminalName, `npm run ${script}`, project.dir, {
    trackAsServe: true,
  }).catch((err) => vscode.window.showErrorMessage(`Failed to start "${terminalName}": ${err}`));
}

// ── Test ──────────────────────────────────────────────────────────────────────

export async function testNodeProject() {
  const resolved = await resolveWorkspaceAndProjects();
  if (!resolved) {
    return;
  }
  const { projects } = resolved;

  const project = await pickProjectWithCurrentFile(projects, 'Node Test: Select Project', 'test');
  if (!project) {
    return;
  }

  const scripts = project.scripts;
  if (!scripts || Object.keys(scripts).length === 0) {
    vscode.window.showWarningMessage(
      `No npm scripts found in ${path.join(project.relativeDir || '.', 'package.json')}.`,
    );
    return;
  }

  const config = vscode.workspace.getConfiguration('nodeCliPlus');
  const watchMode = config.get<boolean>('test.watch', false);

  // A saved choice always wins; otherwise prefer a dedicated watch script
  // when watch mode is on.
  let script: string | null;
  const saved = getSavedScript('test', project);
  if (saved) {
    script = saved;
  } else if (watchMode && 'test:watch' in scripts) {
    script = 'test:watch';
  } else {
    script = await pickScriptWithPrefs({
      project,
      aliases: TEST_SCRIPT_ALIASES,
      title: 'Node Test: Select Script',
      placeHolder: 'Select a test script',
      commandKey: 'test',
    });
  }
  if (!script) {
    return;
  }

  // Offer to run only the current test file when the active editor is one.
  let fileArg = '';
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const activeIsTestFile = !!activeFile && parseNodeFilePath(activeFile)?.isTest === true;
  if (activeIsTestFile && activeFile && isPathInsideDir(project.dir, activeFile)) {
    const CURRENT = `$(file)  Current test file (${path.basename(activeFile)})`;
    const ALL = '$(list-flat)  All tests';
    const picked = await vscode.window.showQuickPick([CURRENT, ALL], {
      placeHolder: 'What should be tested?',
      title: `Node Test: ${project.name}`,
    });
    if (!picked) {
      return;
    }
    if (picked === CURRENT) {
      const relPath = path.relative(project.dir, activeFile).replaceAll(path.sep, '/');
      fileArg = ` -- "${relPath}"`;
    }
  }

  const terminalName = fileArg
    ? `test (${project.name}:${path.basename(activeFile!)})`
    : `test (${project.name})`;
  const command = `npm run ${script}${fileArg}`;

  void runInTerminal(terminalName, command, project.dir, {
    successMessage: watchMode ? undefined : `${terminalName} completed successfully.`,
    retryLabel: watchMode ? undefined : 'Retry',
  }).catch((err) => vscode.window.showErrorMessage(`Failed to start "${terminalName}": ${err}`));
}

function isPathInsideDir(dir: string, filePath: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ── Build ─────────────────────────────────────────────────────────────────────

export async function buildNodeProject() {
  await runBuild(false);
}

export async function buildNodeProjectWatch() {
  await runBuild(true);
}

async function runBuild(watch: boolean) {
  const resolved = await resolveWorkspaceAndProjects();
  if (!resolved) {
    return;
  }
  const { projects } = resolved;

  const title = watch ? 'Node Build Watch: Select Project' : 'Node Build: Select Project';
  const project = await pickProjectWithCurrentFile(
    projects,
    title,
    watch ? 'buildWatch' : 'build',
  );
  if (!project) {
    return;
  }

  const script = await pickScriptWithPrefs({
    project,
    aliases: watch ? BUILD_WATCH_SCRIPT_ALIASES : BUILD_SCRIPT_ALIASES,
    title: watch ? 'Node Build Watch: Select Script' : 'Node Build: Select Script',
    placeHolder: 'Select an npm script',
    commandKey: watch ? 'buildWatch' : 'build',
  });
  if (!script) {
    return;
  }

  const terminalName = watch ? `build --watch (${project.name})` : `build (${project.name})`;
  void runInTerminal(terminalName, `npm run ${script}`, project.dir, {
    trackAsServe: watch,
    successMessage: watch ? undefined : `build (${project.name}) completed successfully.`,
    retryLabel: watch ? undefined : 'Retry',
  }).catch((err) => vscode.window.showErrorMessage(`Failed to start "${terminalName}": ${err}`));
}

// ── Clear terminals ───────────────────────────────────────────────────────────

export async function clearFinishedTerminals() {
  if (extensionTerminals.size === 0) {
    vscode.window.showInformationMessage('No extension terminals to close.');
    return;
  }

  function getTerminalState(terminal: vscode.Terminal): {
    state: 'running' | 'terminated' | 'errored' | 'killed';
    label: string;
    icon: string;
  } {
    const trackedState = getTrackedTerminalState(terminal);
    if (trackedState) {
      switch (trackedState) {
        case 'running':
          return { state: 'running', label: 'running', icon: '$(play)' };
        case 'killed':
          return { state: 'killed', label: 'killed', icon: '$(circle-slash)' };
        case 'terminated':
          return { state: 'terminated', label: 'terminated', icon: '$(check)' };
        case 'errored':
          return { state: 'errored', label: 'errored', icon: '$(error)' };
      }
    }

    if (terminal.exitStatus === undefined) {
      return { state: 'running', label: 'running', icon: '$(play)' };
    }
    if (terminal.exitStatus.code === undefined) {
      return { state: 'killed', label: 'killed', icon: '$(circle-slash)' };
    }
    if (terminal.exitStatus.code === 0) {
      return { state: 'terminated', label: 'terminated', icon: '$(check)' };
    }
    return { state: 'errored', label: 'errored', icon: '$(error)' };
  }

  const stateOrder: Record<'running' | 'terminated' | 'errored' | 'killed', number> = {
    errored: 0,
    killed: 1,
    terminated: 2,
    running: 3,
  };

  type TerminalItem = vscode.QuickPickItem & {
    terminal: vscode.Terminal;
    state: 'running' | 'terminated' | 'errored' | 'killed';
  };

  const terminals = [...extensionTerminals].sort((a, b) => {
    const sa = getTerminalState(a);
    const sb = getTerminalState(b);
    return stateOrder[sa.state] - stateOrder[sb.state];
  });

  const terminalItems: TerminalItem[] = terminals.map((t) => {
    const { state, label, icon } = getTerminalState(t);
    return {
      label: `${icon} ${t.name}`,
      description: label,
      terminal: t,
      state,
    };
  });

  const qp = vscode.window.createQuickPick<TerminalItem>();
  qp.items = terminalItems;
  qp.canSelectMany = true;
  qp.placeholder = 'Search and select terminals to close...';
  qp.title = 'Close Terminals';
  // Pre-select finished (non-running) terminals
  qp.selectedItems = terminalItems.filter((i) => i.state !== 'running');

  const chosen = await new Promise<TerminalItem[]>((resolve) => {
    qp.onDidAccept(() => {
      resolve([...qp.selectedItems]);
      qp.hide();
    });
    qp.onDidHide(() => resolve([]));
    qp.show();
  });
  qp.dispose();

  for (const item of chosen) {
    item.terminal.dispose();
    extensionTerminals.delete(item.terminal);
  }

  if (chosen.length > 0) {
    vscode.window.showInformationMessage(
      `Closed ${chosen.length} terminal${chosen.length > 1 ? 's' : ''}.`,
    );
  }
}

// ── Run npm script ────────────────────────────────────────────────────────────

export async function runNpmScript() {
  const resolved = await resolveWorkspaceAndProjects();
  if (!resolved) {
    return;
  }
  const { projects } = resolved;

  const project = await pickProjectWithCurrentFile(
    projects,
    'Run npm Script: Select Project',
    'npmScript',
  );
  if (!project) {
    return;
  }

  const scripts = project.scripts;
  if (!scripts || Object.keys(scripts).length === 0) {
    vscode.window.showInformationMessage(
      `No npm scripts found in ${path.join(project.relativeDir || '.', 'package.json')}.`,
    );
    return;
  }

  const items: vscode.QuickPickItem[] = Object.entries(scripts).map(([name, cmd]) => ({
    label: name,
    description: cmd,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select an npm script to run',
    matchOnDescription: true,
    title: `npm scripts — ${project.name}`,
  });
  if (!picked) {
    return;
  }

  const terminalName = `npm: ${picked.label} (${project.name})`;
  await runInTerminal(terminalName, `npm run ${picked.label}`, project.dir);
}
