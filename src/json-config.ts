/**
 * Entry point for "Node: Manage JSON Configs" (Ctrl+Shift+N J). Detects which
 * config files actually exist in the workspace, lets the user pick one, and opens
 * the matching webview editor.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { pickWorkspaceFolder } from './utils';
import { showEslintEditor } from './json-config-eslint';
import { showTsconfigEditor } from './json-config-tsconfig';

type ConfigKind = 'eslint' | 'tsconfig';

interface ConfigPickItem extends vscode.QuickPickItem {
  configKind: ConfigKind;
  filePath: string;
}

const ESLINT_CANDIDATES = [
  // Flat config (preferred order).
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  // Legacy config.
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
];
const TSCONFIG_CANDIDATES = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.spec.json'];

export async function manageJsonConfig(): Promise<void> {
  const workspaceRoot = await pickWorkspaceFolder();
  if (!workspaceRoot) {
    return;
  }

  const items = collectExistingConfigs(workspaceRoot);
  if (items.length === 0) {
    vscode.window.showInformationMessage(
      `No manageable JSON config files found in ${path.basename(workspaceRoot)}.`,
    );
    return;
  }

  const picked =
    items.length === 1
      ? items[0]
      : await vscode.window.showQuickPick(items, {
          placeHolder: 'Which config file do you want to manage?',
          title: 'Manage JSON Configs',
        });
  if (!picked) {
    return;
  }

  switch (picked.configKind) {
    case 'eslint':
      await showEslintEditor(picked.filePath, workspaceRoot);
      return;
    case 'tsconfig':
      showTsconfigEditor(picked.filePath, workspaceRoot);
      return;
  }
}

function collectExistingConfigs(workspaceRoot: string): ConfigPickItem[] {
  const items: ConfigPickItem[] = [];

  // ESLint — first existing config variant (JSON, JS, or TS).
  const eslintFile = ESLINT_CANDIDATES.map((f) => path.join(workspaceRoot, f)).find(fs.existsSync);
  if (eslintFile) {
    items.push({
      configKind: 'eslint',
      filePath: eslintFile,
      label: `$(law) ${path.basename(eslintFile)}`,
      description: 'ESLint rules',
    });
  }

  // TypeScript — every existing tsconfig variant.
  for (const candidate of TSCONFIG_CANDIDATES) {
    const full = path.join(workspaceRoot, candidate);
    if (fs.existsSync(full)) {
      items.push({
        configKind: 'tsconfig',
        filePath: full,
        label: `$(settings-gear) ${candidate}`,
        description: 'TypeScript compiler options',
      });
    }
  }

  return items;
}
