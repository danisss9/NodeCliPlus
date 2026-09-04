import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  npmOutput,
  scriptsOutput,
  diagnosticOutput,
  activeServeTerminals,
  clearTrackedTerminalState,
  extensionTerminals,
  setTrackedTerminalFinished,
  setTrackedTerminalRunning,
  depCheckTimeouts,
  setExtensionContext,
  loadPersistedTerminalEntries,
  removePersistedTerminalEntry,
} from './state';
import {
  serveNodeProject,
  testNodeProject,
  buildNodeProject,
  buildNodeProjectWatch,
  clearFinishedTerminals,
  switchFile,
  runNpmScript,
} from './commands';
import {
  debugNodeProject,
  debugBuildWatchProject,
  restartNodeServe,
} from './debug';
import {
  runNpmInstall,
  setupDependencyCheck,
  teardownDependencyCheck,
  scheduleDependencyCheck,
  checkToolVersions,
  checkDependencies,
} from './dependencies';
import { pickWorkspaceFolder } from './utils';
import { killAllManagedChildren } from './spawn';
import { checkMemoryLeaks } from './memory-leak';
import { setupNpmrcCommand } from './npmrc';
import { checkBuildErrors } from './build-errors';
import { checkLint } from './lint-issues';
import { showPackageUpdates } from './package-updates';
import { manageJsonConfig } from './json-config';

export function activate(context: vscode.ExtensionContext) {
  setExtensionContext(context);

  // ── Clear stale terminal entries from previous sessions ───────────────────
  const persisted = loadPersistedTerminalEntries();
  for (const name of Object.keys(persisted)) {
    removePersistedTerminalEntry(name);
  }

  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (extensionTerminals.has(event.terminal)) {
        setTrackedTerminalRunning(event.terminal);
      }
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      if (extensionTerminals.has(event.terminal)) {
        setTrackedTerminalFinished(event.terminal, event.exitCode);
      }
    }),
    vscode.commands.registerCommand('node-cli-plus.debugNode', () => debugNodeProject(context)),
    vscode.commands.registerCommand('node-cli-plus.debugBuildWatch', () =>
      debugBuildWatchProject(context),
    ),
    vscode.commands.registerCommand('node-cli-plus.serveNode', () => serveNodeProject()),
    vscode.commands.registerCommand('node-cli-plus.buildNode', () => buildNodeProject()),
    vscode.commands.registerCommand('node-cli-plus.buildNodeWatch', () => buildNodeProjectWatch()),
    vscode.commands.registerCommand('node-cli-plus.restartNodeServe', () =>
      restartNodeServe(context),
    ),
    vscode.commands.registerCommand('node-cli-plus.testNode', () => testNodeProject()),
    vscode.commands.registerCommand('node-cli-plus.lintNode', () => checkLint()),
    vscode.commands.registerCommand('node-cli-plus.updatePackages', () => showPackageUpdates()),
    vscode.commands.registerCommand('node-cli-plus.switchFile', () => switchFile()),
    vscode.commands.registerCommand('node-cli-plus.clearTerminals', () =>
      clearFinishedTerminals(),
    ),
    vscode.commands.registerCommand('node-cli-plus.runNpmScript', () => runNpmScript()),
    vscode.commands.registerCommand('node-cli-plus.checkMemoryLeaks', () => checkMemoryLeaks()),
    vscode.commands.registerCommand('node-cli-plus.setupNpmrc', () => setupNpmrcCommand()),
    vscode.commands.registerCommand('node-cli-plus.checkBuildErrors', () => checkBuildErrors()),
    vscode.commands.registerCommand('node-cli-plus.manageJsonConfig', () => manageJsonConfig()),
    vscode.commands.registerCommand('node-cli-plus.npmInstall', () => runNpmInstall(false)),
    vscode.commands.registerCommand('node-cli-plus.npmCleanInstall', () => runNpmInstall(true)),
    vscode.commands.registerCommand('node-cli-plus.checkDependencies', async () => {
      const workspaceRoot = await pickWorkspaceFolder();
      if (workspaceRoot) {
        await checkDependencies(workspaceRoot);
      }
    }),
    vscode.commands.registerCommand('node-cli-plus.checkToolVersions', async () => {
      const workspaceRoot = await pickWorkspaceFolder();
      if (workspaceRoot) {
        await checkToolVersions(workspaceRoot);
      }
    }),
    vscode.commands.registerCommand('node-cli-plus.openCommandPalette', () =>
      vscode.commands.executeCommand('workbench.action.quickOpen', '>Node CLI Plus'),
    ),
  );

  // ── Status bar button: opens the command palette filtered to this extension ─
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.name = 'Node CLI Plus';
  statusBarItem.text = 'Node CLI +';
  statusBarItem.tooltip = 'Open the command palette with Node CLI Plus commands';
  statusBarItem.command = 'node-cli-plus.openCommandPalette';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    setupDependencyCheck(context, folder.uri.fsPath);
    if (fs.existsSync(path.join(folder.uri.fsPath, 'package.json'))) {
      void checkToolVersions(folder.uri.fsPath);
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.added) {
        setupDependencyCheck(context, folder.uri.fsPath);
        if (fs.existsSync(path.join(folder.uri.fsPath, 'package.json'))) {
          void checkToolVersions(folder.uri.fsPath);
        }
      }
      for (const folder of e.removed) {
        teardownDependencyCheck(folder.uri.fsPath);
      }
    }),
  );

  // activeServeTerminals / extensionTerminals cleanup is handled inside
  // runInTerminal()'s onDidCloseTerminal listener. Nothing extra needed here.

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      clearTrackedTerminalState(terminal);
    }),
  );

  context.subscriptions.push(npmOutput, scriptsOutput, diagnosticOutput);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('nodeCliPlus.checkToolVersions.enabled')) {
        const tvEnabled = vscode.workspace
          .getConfiguration('nodeCliPlus')
          .get<boolean>('checkToolVersions.enabled', true);
        if (tvEnabled) {
          for (const folder of vscode.workspace.workspaceFolders ?? []) {
            void checkToolVersions(folder.uri.fsPath);
          }
        }
      }
      if (e.affectsConfiguration('nodeCliPlus.checkDependencies.enabled')) {
        const enabled = vscode.workspace
          .getConfiguration('nodeCliPlus')
          .get<boolean>('checkDependencies.enabled', true);
        if (enabled) {
          for (const folder of vscode.workspace.workspaceFolders ?? []) {
            scheduleDependencyCheck(folder.uri.fsPath, 500);
          }
        } else {
          for (const [key, timeout] of depCheckTimeouts) {
            clearTimeout(timeout);
            depCheckTimeouts.delete(key);
          }
        }
      }
    }),
  );
}

export function deactivate() {
  for (const timeout of depCheckTimeouts.values()) {
    clearTimeout(timeout);
  }
  depCheckTimeouts.clear();
  killAllManagedChildren();
}
