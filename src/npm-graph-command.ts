import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { getExtensionContext } from './state';
import { pickWorkspaceFolder } from './utils';
import { spawnManaged } from './spawn';
import { createAnalysisPanel } from './webview-utils';
import { normalizedPackagePath } from './npm-graph';
import { loadNpmDependencyGraph } from './npm-graph-loader';
import { reviewPackageSecurityForRoot } from './security-command';

import { buildNpmGraphHtml } from './npm-graph-html';

const panels = new Map<string, ReturnType<typeof createAnalysisPanel>>();

export async function showNpmDependencyGraph(): Promise<void> {
  const root = await pickWorkspaceFolder();
  if (!root) { return; }
  const key = normalizedPackagePath(root, root);
  const existing = panels.get(key);
  if (existing && !existing.isDisposed()) {
    existing.panel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  const context = getExtensionContext();
  const assets = vscode.Uri.joinPath(context.extensionUri, 'dist');
  const view = createAnalysisPanel('npmDependencyGraph', 'npm Dependency Graph', { localResourceRoots: [assets] });
  panels.set(key, view);
  view.panel.onDidDispose(() => { panels.delete(key); });
  let busy = false;
  async function refresh() {
    if (busy || view.isDisposed()) { return; }
    busy = true;
    await view.panel.webview.postMessage({ type: 'loading' });
    try {
      const graph = await loadNpmDependencyGraph(root!, async (args, cwd) => {
        let stdout = '';
        let stderr = '';
        const result = await spawnManaged('npm', args, {
          cwd, shell: true, timeoutMs: 30_000,
          onStdout: chunk => { stdout += chunk; },
          onStderr: chunk => { stderr += chunk; },
        });
        return { ...result, stdout, stderr: stderr || (stdout ? '' : result.stdout) };
      });
      if (!view.isDisposed()) {
        view.setTitle(`npm Graph: ${graph.nodes.find(node => node.id === graph.root)?.name ?? 'Dependencies'}`);
        await view.panel.webview.postMessage({ type: 'graph', graph });
      }
    } catch (error) {
      if (!view.isDisposed()) {
        await view.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    } finally { busy = false; }
  }
  let openingSecurity = false;
  view.onMessage<{ command?: string }>(async message => {
    if (message && (message.command === 'ready' || message.command === 'refresh')) { return refresh(); }
    if (message?.command === 'securityScan' && !openingSecurity && !view.isDisposed()) {
      openingSecurity = true;
      try { await reviewPackageSecurityForRoot(root); }
      finally {
        openingSecurity = false;
        if (!view.isDisposed()) { await view.panel.webview.postMessage({ type: 'securityScanFinished' }); }
      }
    }
  });
  const nonce = randomBytes(24).toString('base64');
  const script = view.panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'npm-graph-webview.js'));
  const style = view.panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'npm-graph-webview.css'));
  view.setHtml(buildNpmGraphHtml(script.toString(), style.toString(), view.panel.webview.cspSource, nonce));
}

