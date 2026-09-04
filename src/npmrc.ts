import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { pickWorkspaceFolder } from './utils';
import { writeFileAtomic } from './jsonc-io';

export async function setupNpmrcCommand() {
  const workspaceRoot = await pickWorkspaceFolder();
  if (!workspaceRoot) {
    return;
  }

  const workspaceNpmrcPath = path.join(workspaceRoot, '.npmrc');
  if (!fs.existsSync(workspaceNpmrcPath)) {
    vscode.window.showInformationMessage('No .npmrc found in the workspace root.');
    return;
  }

  let workspaceNpmrcContent = '';
  try {
    workspaceNpmrcContent = fs.readFileSync(workspaceNpmrcPath, 'utf-8');
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to read workspace .npmrc: ${error}`);
    return;
  }

  // Extract all registries from the workspace .npmrc
  // Match lines like: registry=https://registry.npmjs.org/
  // or @scope:registry=https://npm.pkg.github.com/
  const registryRegex = /(?:^|\n)(?:@[^:]+:)?registry=(https?:\/\/[^\s\n]+)/g;
  const registries = new Set<string>();
  let match;

  while ((match = registryRegex.exec(workspaceNpmrcContent)) !== null) {
    let url = match[1];
    // Ensure URL has a trailing slash for the standard format
    if (!url.endsWith('/')) {
      url += '/';
    }
    registries.add(url);
  }

  if (registries.size === 0) {
    vscode.window.showInformationMessage('No registries found in the workspace .npmrc.');
    return;
  }

  const globalNpmrcPath = path.join(os.homedir(), '.npmrc');
  let globalNpmrcContent = '';

  if (fs.existsSync(globalNpmrcPath)) {
    try {
      globalNpmrcContent = fs.readFileSync(globalNpmrcPath, 'utf-8');
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to read global .npmrc: ${error}`);
      return;
    }
  }

  let updatedGlobalNpmrc = globalNpmrcContent;
  let addedTokens = 0;

  for (const registryUrl of registries) {
    // Extract the host and path without the protocol
    // e.g., https://registry.npmjs.org/ -> registry.npmjs.org/
    const urlObj = new URL(registryUrl);
    const registryPath = `${urlObj.host}${urlObj.pathname}`;

    // Check if the auth token already exists
    const tokenRegex = new RegExp(`//${registryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:_authToken=`);
    if (tokenRegex.test(updatedGlobalNpmrc)) {
      continue; // Token already exists for this registry
    }

    const pat = await vscode.window.showInputBox({
      prompt: `Enter Personal Access Token (PAT) for ${registryUrl}`,
      password: true,
      ignoreFocusOut: true,
    });

    if (pat) {
      // Append the token to the global .npmrc
      const prefix = updatedGlobalNpmrc.length > 0 && !updatedGlobalNpmrc.endsWith('\n') ? '\n' : '';
      updatedGlobalNpmrc += `${prefix}//${registryPath}:_authToken=${pat}\n`;
      addedTokens++;
    }
  }

  if (addedTokens > 0) {
    try {
      writeFileAtomic(globalNpmrcPath, updatedGlobalNpmrc);
      vscode.window.showInformationMessage(`Successfully added ${addedTokens} auth token(s) to global .npmrc.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to write to global .npmrc: ${error}`);
    }
  } else if (registries.size > 0) {
    vscode.window.showInformationMessage('No new auth tokens were added to the global .npmrc.');
  }
}
