import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { NodeWorkspaceProject } from './types';
import { readJsonc } from './jsonc-io';
import {
  activeServeTerminals,
  clearTrackedTerminalState,
  extensionTerminals,
  getTrackedTerminalState,
  getExtensionContext,
  logDiagnostic,
  persistTerminalEntry,
  removePersistedTerminalEntry,
} from './state';
import { expandWorkspaces, findBestProjectForPath } from './pure-utils';

export { isPathInside, validateCustomCommand, semverSatisfies } from './pure-utils';
export { findBestProjectForPath };

// ── package.json / workspaces resolution ────────────────────────────────────────

interface RootPackageJson {
  name?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface WorkspacePackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface ProjectsCacheEntry {
  projects: NodeWorkspaceProject[];
  /** Signature of root + workspace package.json mtimes; changes invalidate the cache. */
  signature: string;
}

const projectsCache = new Map<string, ProjectsCacheEntry>();

function mergeDeps(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}): Record<string, string> {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
}

/** Reads a project directory's package.json, or `null` when missing/unparseable. */
export function readPackageJsonAt(dir: string): WorkspacePackageJson | null {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return null;
  }
  return readJsonc<WorkspacePackageJson>(pkgPath);
}

/** Builds the project name for a workspace package (name field, else relative dir). */
function projectNameFor(pkg: WorkspacePackageJson | null, relativeDir: string, isRoot: boolean): string {
  if (pkg?.name) {
    return pkg.name;
  }
  if (isRoot) {
    return 'root';
  }
  return relativeDir.replaceAll(path.sep, '/') || 'root';
}

async function fileMtime(filePath: string): Promise<number> {
  try {
    return (await fs.promises.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Resolves every project in a workspace root: the root package itself plus,
 * when `workspaces` is declared, every workspace package with its own
 * package.json. Results are cached until any relevant package.json's mtime
 * changes.
 */
export async function resolveProjects(workspaceRoot: string): Promise<NodeWorkspaceProject[]> {
  const rootPkgPath = path.join(workspaceRoot, 'package.json');
  const rootPkg = readJsonc<RootPackageJson>(rootPkgPath);
  if (!rootPkg) {
    return [];
  }

  const workspaceDirs = expandWorkspaces(workspaceRoot, rootPkg.workspaces);
  const workspacePkgPaths = workspaceDirs.map((rel) => path.join(workspaceRoot, rel, 'package.json'));

  // Cheap invalidation: the signature covers the root package.json plus every
  // workspace package.json currently known.
  const mtimes = await Promise.all(
    [rootPkgPath, ...workspacePkgPaths].map((p) => fileMtime(p)),
  );
  const signature = mtimes.join(',');

  const cached = projectsCache.get(workspaceRoot);
  if (cached && cached.signature === signature) {
    return cached.projects;
  }

  const projects: NodeWorkspaceProject[] = [
    {
      name: projectNameFor(rootPkg, '', true),
      dir: workspaceRoot,
      relativeDir: '',
      scripts: rootPkg.scripts ?? {},
      allDependencies: mergeDeps(rootPkg),
      isRoot: true,
    },
  ];

  for (const rel of workspaceDirs) {
    const dir = path.join(workspaceRoot, rel);
    const pkg = readPackageJsonAt(dir);
    if (!pkg) {
      continue;
    }
    projects.push({
      name: projectNameFor(pkg, rel, false),
      dir,
      relativeDir: rel,
      scripts: pkg.scripts ?? {},
      allDependencies: mergeDeps(pkg),
      isRoot: false,
    });
  }

  projectsCache.set(workspaceRoot, { projects, signature });
  return projects;
}

/** Invalidate the project cache for a workspace root (called when package.json files change). */
export function invalidateProjectsCache(workspaceRoot: string): void {
  projectsCache.delete(workspaceRoot);
}

// ── Workspace helpers ──────────────────────────────────────────────────────────

export async function resolveWorkspaceAndProjects(): Promise<{
  workspaceFolder: vscode.WorkspaceFolder;
  workspaceRoot: string;
  projects: NodeWorkspaceProject[];
} | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return null;
  }

  let workspaceFolder: vscode.WorkspaceFolder;
  if (workspaceFolders.length === 1) {
    workspaceFolder = workspaceFolders[0];
  } else {
    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'Select workspace folder',
    });
    if (!picked) {
      return null;
    }
    workspaceFolder = picked;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const rootPkgPath = path.join(workspaceRoot, 'package.json');

  if (!fs.existsSync(rootPkgPath)) {
    vscode.window.showErrorMessage('No package.json found in workspace root');
    return null;
  }

  const projects = await resolveProjects(workspaceRoot);
  if (projects.length === 0) {
    vscode.window.showErrorMessage('Failed to parse package.json');
    return null;
  }

  return { workspaceFolder, workspaceRoot, projects };
}

export async function pickWorkspaceFolder(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return null;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select workspace folder',
  });
  return picked?.uri.fsPath ?? null;
}

// ── Project selection helpers ──────────────────────────────────────────────────

export function getLastProject(commandKey: string): string | undefined {
  return getExtensionContext().globalState.get<string>(`lastProject.${commandKey}`);
}

export function setLastProject(commandKey: string, project: string): void {
  void getExtensionContext().globalState.update(`lastProject.${commandKey}`, project);
}

export function findProjectByName(projects: NodeWorkspaceProject[], name: string): NodeWorkspaceProject | undefined {
  return projects.find((p) => p.name === name);
}

export function detectActiveFileProject(projects: NodeWorkspaceProject[]): NodeWorkspaceProject | null {
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!activeFile) {
    return null;
  }
  const name = findBestProjectForPath(activeFile, projects);
  return name ? (findProjectByName(projects, name) ?? null) : null;
}

/**
 * QuickPick over project names with "Current project" (derived from the active
 * file) and "Last used" convenience entries. Single-project workspaces skip
 * the prompt entirely.
 */
export async function pickProjectWithCurrentFile(
  projects: NodeWorkspaceProject[],
  title: string,
  commandKey?: string,
): Promise<NodeWorkspaceProject | null> {
  if (projects.length === 0) {
    vscode.window.showErrorMessage('No projects found in package.json');
    return null;
  }
  if (projects.length === 1) {
    return projects[0];
  }

  const current = detectActiveFileProject(projects);
  const currentInList = current ?? null;
  const CURRENT_LABEL = currentInList ? `$(file)  Current project (${currentInList.name})` : null;

  const last = commandKey ? getLastProject(commandKey) : undefined;
  const lastProject =
    last && !currentInList ? (findProjectByName(projects, last) ?? null) : null;
  const LAST_LABEL = lastProject ? `$(history)  Last used (${lastProject.name})` : null;

  const choices = [
    ...(CURRENT_LABEL ? [CURRENT_LABEL] : []),
    ...(LAST_LABEL ? [LAST_LABEL] : []),
    ...projects.map((p) => p.name),
  ];
  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select project',
    title,
  });
  if (!picked) {
    return null;
  }
  if (CURRENT_LABEL && picked === CURRENT_LABEL) {
    if (commandKey) {
      setLastProject(commandKey, currentInList!.name);
    }
    return currentInList!;
  }
  if (LAST_LABEL && picked === LAST_LABEL) {
    return lastProject!;
  }
  if (commandKey) {
    setLastProject(commandKey, picked);
  }
  return findProjectByName(projects, picked) ?? null;
}

// ── Tool resolution ────────────────────────────────────────────────────────────

export function quoteShellPath(filePath: string): string {
  return /\s/.test(filePath) ? `"${filePath.replace(/"/g, '\\"')}"` : filePath;
}

function getLocalEslintPath(workspaceRoot: string): string | null {
  const executable = process.platform === 'win32' ? 'eslint.cmd' : 'eslint';
  const cliPath = path.join(workspaceRoot, 'node_modules', '.bin', executable);
  return fs.existsSync(cliPath) ? cliPath : null;
}

/**
 * Resolves how to spawn ESLint directly (used for lint + `--fix`). Prefers the
 * locally installed binary in node_modules/.bin, falling back to `npx eslint`.
 */
export function resolveEslintSpawn(
  workspaceRoot: string,
  args: string[],
): { command: string; args: string[]; shell: boolean; displayCommand: string } {
  const localEslint = getLocalEslintPath(workspaceRoot);
  if (localEslint) {
    return {
      command: localEslint,
      args,
      shell: process.platform === 'win32',
      displayCommand: `${quoteShellPath(localEslint)} ${args.join(' ')}`,
    };
  }

  return {
    command: 'npx',
    args: ['eslint', ...args],
    shell: true,
    displayCommand: `npx eslint ${args.join(' ')}`,
  };
}

// ── Terminal helpers ───────────────────────────────────────────────────────────

const RESTART_CTRL_C_DELAY_MS = 500;

/**
 * Creates a terminal, runs a command, and shows a success notification on exit
 * code 0 or a warning notification with an optional Retry button on non-zero
 * exit. When `retryLabel` is set and no `onRetry` handler is provided, the
 * exact same command is re-launched automatically.
 *
 * If a terminal with the same name already exists in `extensionTerminals`:
 * - Running: the user is offered to restart it.
 * - Terminated/errored: the old terminal is disposed and a fresh one is opened.
 */
export async function runInTerminal(
  name: string,
  command: string,
  cwd: string,
  options?: {
    trackAsServe?: boolean;
    successMessage?: string;
    retryLabel?: string;
    onRetry?: () => void;
  },
): Promise<vscode.Terminal> {
  // ── Reuse check ────────────────────────────────────────────────────────────
  const existing = [...extensionTerminals].find((t) => t.name === name);
  if (existing) {
    const isRunning = getTrackedTerminalState(existing) === 'running';
    if (isRunning) {
      // Terminal already running — offer restart
      const action = await vscode.window.showInformationMessage(
        `"${name}" is already running. Restart it?`,
        'Restart',
        'Show',
      );
      // Re-check terminal is still valid after awaiting user input
      if (getTrackedTerminalState(existing) !== 'running') {
        extensionTerminals.delete(existing);
        clearTrackedTerminalState(existing);
        removePersistedTerminalEntry(name);
        // Fall through to create a new terminal below
      } else if (action === 'Restart') {
        existing.show();
        existing.sendText('\x03');
        await new Promise<void>((r) => setTimeout(r, RESTART_CTRL_C_DELAY_MS));
        existing.sendText(command);
        return existing;
      } else if (action === 'Show') {
        existing.show();
        return existing;
      } else {
        return existing;
      }
    } else {
      // Terminated or errored — reuse the existing terminal
      existing.show();
      existing.sendText(command);
      return existing;
    }
  }

  // ── Create new terminal ────────────────────────────────────────────────────
  const terminal = vscode.window.createTerminal({ name, cwd });
  extensionTerminals.add(terminal);
  persistTerminalEntry(name, { command, cwd, trackAsServe: options?.trackAsServe ?? false });

  if (options?.trackAsServe) {
    activeServeTerminals.set(name, { terminal, command, cwd });
  }
  terminal.show();
  terminal.sendText(command);

  const disposable = vscode.window.onDidCloseTerminal(async (closed) => {
    if (closed !== terminal) {
      return;
    }
    disposable.dispose();
    extensionTerminals.delete(closed);
    clearTrackedTerminalState(closed);
    removePersistedTerminalEntry(name);

    // Also clean up activeServeTerminals here so we don't rely solely on the
    // extension.ts handler
    for (const [key, entry] of activeServeTerminals) {
      if (entry.terminal === closed) {
        activeServeTerminals.delete(key);
        break;
      }
    }

    const exitStatus = closed.exitStatus;
    if (exitStatus === undefined) {
      // Should not happen (we're inside onDidCloseTerminal), but guard anyway
      return;
    }

    const code = exitStatus.code;
    if (code === undefined) {
      // Terminal was killed without a proper exit (e.g. user closed the tab
      // mid-run or the process was force-killed).
      logDiagnostic(`Terminal "${name}" closed without an exit code (killed/forced close).`);
      return;
    }

    if (code === 0) {
      if (options?.successMessage) {
        vscode.window.showInformationMessage(options.successMessage);
      }
    } else {
      const retryLabel = options?.retryLabel;
      if (retryLabel) {
        const action = await vscode.window.showWarningMessage(
          `${name} failed (exit code ${code}).`,
          retryLabel,
        );
        if (action === retryLabel) {
          if (options.onRetry) {
            options.onRetry();
          } else {
            void runInTerminal(name, command, cwd, options);
          }
        }
      } else {
        vscode.window.showWarningMessage(`${name} failed (exit code ${code}).`);
      }
    }
  });

  return terminal;
}
