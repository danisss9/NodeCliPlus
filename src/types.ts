import * as vscode from 'vscode';

export interface DebugConfig {
  workspaceFolder: vscode.WorkspaceFolder;
  port: number;
  sessionName: string;
  browserSetting: string;
  browserDebugConfig: BrowserDebugConfig;
}

export interface ServeEntry {
  terminal: vscode.Terminal;
  command: string;
  cwd: string;
  debugConfig?: DebugConfig;
  activeDebugSession?: vscode.DebugSession;
}

/**
 * A package.json-backed project. The workspace root is always a project; when
 * the root package.json declares `workspaces`, every workspace package that
 * contains its own package.json becomes a project too.
 */
export interface NodeWorkspaceProject {
  /** package.json "name" (or a dir-based fallback like "root" / "packages/api") */
  name: string;
  /** Absolute path of the directory containing this package.json */
  dir: string;
  /** Directory relative to the workspace root; '' for the root project */
  relativeDir: string;
  scripts: Record<string, string>;
  /** dependencies + devDependencies + optionalDependencies merged */
  allDependencies: Record<string, string>;
  /** True for the workspace root package */
  isRoot: boolean;
}

export interface PersistedTerminalEntry {
  command: string;
  cwd: string;
  trackAsServe: boolean;
}

export type TerminalCommandState = 'running' | 'terminated' | 'errored' | 'killed';

export interface BrowserDebugConfig {
  type: string;
  runtimeExecutable?: string;
}

/** How Node: Debug Application should start debugging. */
export type DebugMode = 'auto' | 'browser' | 'node';
