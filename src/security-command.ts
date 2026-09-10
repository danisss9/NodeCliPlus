import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getExtensionContext, logDiagnostic } from './state';
import { createAnalysisPanel, type AnalysisPanel } from './webview-utils';
import { buildSecurityHtml } from './security-html';
import { reviewPackageSecurity } from './security-review';
import { SecurityReviewJobs } from './security-jobs';
import { contained, safeRealpath } from './security-files';
import type { SecurityReviewReport } from './security-types';

const panels = new Map<string, AnalysisPanel>();
const reports = new Map<string, SecurityReviewReport>();
const progress = new Map<string, string>();
const dismissed = new Set<string>();
let jobs: SecurityReviewJobs | undefined;
async function validRoot(root: string): Promise<string | undefined> {
  if (!vscode.workspace.isTrusted) { return; }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  if (!folder || folder.uri.scheme !== 'file') { return; }
  return fs.realpath(root);
}
function service(): SecurityReviewJobs {
  if (jobs) { return jobs; }
  jobs = new SecurityReviewJobs(async (root, signal, installOutcome) => {
    dismissed.delete(root);
    const context = getExtensionContext();
    return reviewPackageSecurity({ root, storage: context.globalStorageUri.fsPath,
      rules: vscode.Uri.joinPath(context.extensionUri, 'resources', 'security', 'install-scripts.yar').fsPath,
      signal, installOutcome,
      auditEnabled: vscode.workspace.getConfiguration('nodeCliPlus', vscode.Uri.file(root)).get('securityReview.npmAudit.enabled', true),
      onProgress: message => { progress.set(root, message); void panels.get(root)?.panel.webview.postMessage({ type: 'progress', message }); },
    });
  }, (root, report, mode) => {
    reports.set(root, report); progress.delete(root);
    if (dismissed.has(root)) { return; }
    if (mode === 'manual' || report.findings.length || report.state !== 'complete') {
      const panel = openReport(root); void panel.panel.webview.postMessage({ type: 'report', report });
    } else {
      void panels.get(root)?.panel.webview.postMessage({ type: 'report', report });
      void vscode.window.showInformationMessage('Package security review finished: no findings detected within the scanned scope.', 'View Report').then(action => {
        if (action === 'View Report') { openReport(root); }
      });
    }
  }, (root, error) => {
    progress.delete(root); logDiagnostic(`Package security review failed: ${error}`);
    void vscode.window.showErrorMessage(`Package security review failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  getExtensionContext().subscriptions.push({ dispose: () => { jobs?.dispose(); jobs = undefined; panels.clear(); reports.clear(); progress.clear(); dismissed.clear(); } });
  return jobs;
}
export async function reviewPackageSecurityCommand(): Promise<void> {
  if (!vscode.workspace.isTrusted) { vscode.window.showErrorMessage('Package security review requires a trusted workspace.'); return; }
  const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
  if (!folders.length) { vscode.window.showErrorMessage('Open a filesystem workspace to review installed packages.'); return; }
  const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the workspace to review' });
  if (!folder || folder.uri.scheme !== 'file') { return; }
  await reviewPackageSecurityForRoot(folder.uri.fsPath);
}
/** Opens a manual review for a workspace already selected by another view. */
export async function reviewPackageSecurityForRoot(workspaceRoot: string): Promise<void> {
  if (!vscode.workspace.isTrusted) { vscode.window.showErrorMessage('Package security review requires a trusted workspace.'); return; }
  const root = await validRoot(workspaceRoot); if (!root) { return; }
  openReport(root); service().request(root, 'manual');
}
export async function beginSecurityInstall(root: string): Promise<string | undefined> {
  const real = await validRoot(root); if (!real) { return; }
  service().beginInstall(real); reports.delete(real);
  progress.set(real, 'Waiting for installation to finish…');
  void panels.get(real)?.panel.webview.postMessage({ type: 'progress', message: progress.get(real) });
  return real;
}
export function endSecurityInstall(root: string | undefined, outcome: 'success' | 'failed' | undefined): void {
  if (!root) { return; }
  const enabled = vscode.workspace.isTrusted && vscode.workspace.getConfiguration('nodeCliPlus', vscode.Uri.file(root)).get('securityReview.afterInstall.enabled', true);
  service().endInstall(root, outcome, enabled);
  if (!service().busy(root)) {
    progress.delete(root);
    void panels.get(root)?.panel.webview.postMessage({ type: 'idle', message: 'Installation finished. Run Rescan to review the current installed files.' });
  }
}
export async function resolveEvidenceFile(root: string, report: SecurityReviewReport, findingId: string, index: number): Promise<{ file: string; line: number; column: number } | undefined> {
  if (!Number.isSafeInteger(index) || index < 0) { return; }
  const evidence = report.findings.find(finding => finding.id === findingId)?.evidence[index];
  if (!evidence) { return; }
  const absolute = path.resolve(root, evidence.file);
  if (!contained(root, absolute)) { return; }
  const file = await safeRealpath(root, absolute);
  if (!(await fs.stat(file)).isFile()) { return; }
  return { file, line: Math.max(0, evidence.line - 1), column: Math.max(0, evidence.column - 1) };
}
function openReport(root: string): AnalysisPanel {
  const existing = panels.get(root);
  if (existing && !existing.isDisposed()) { existing.panel.reveal(vscode.ViewColumn.Beside, true); return existing; }
  const context = getExtensionContext();
  const assets = vscode.Uri.joinPath(context.extensionUri, 'dist');
  const view = createAnalysisPanel('packageSecurityReview', 'Package Security Review', { localResourceRoots: [assets], enableCommandUris: false });
  panels.set(root, view);
  view.panel.onDidDispose(() => { panels.delete(root); dismissed.add(root); jobs?.cancel(root); });
  view.onMessage<unknown>(async raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return; }
    const message = raw as Record<string, unknown>;
    const report = reports.get(root);
    switch (message.command) {
      case 'ready':
        if (progress.has(root)) { await view.panel.webview.postMessage({ type: 'progress', message: progress.get(root) }); }
        else if (report) { await view.panel.webview.postMessage({ type: 'report', report }); }
        break;
      case 'rescan': if (vscode.workspace.isTrusted) { service().request(root, 'manual'); } break;
      case 'cancel': service().cancel(root); break;
      case 'save': {
        if (!report || service().busy(root)) { return; }
        const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(root, 'package-security-report.html')), filters: { 'HTML report': ['html'] } });
        if (!destination) { return; }
        const [script, style] = await Promise.all(['security-webview.js', 'security-webview.css'].map(file => fs.readFile(vscode.Uri.joinPath(assets, file).fsPath, 'utf8')));
        const html = buildSecurityHtml({ nonce: randomBytes(24).toString('base64'), script, style, report, standalone: true });
        await vscode.workspace.fs.writeFile(destination, Buffer.from(html));
        vscode.window.showInformationMessage('Security report saved.');
        break;
      }
      case 'openFile': {
        if (!report || typeof message.findingId !== 'string' || typeof message.evidenceIndex !== 'number') { return; }
        const target = await resolveEvidenceFile(root, report, message.findingId, message.evidenceIndex);
        if (target) {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
          const position = document.validatePosition(new vscode.Position(target.line, target.column));
          await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true, viewColumn: vscode.ViewColumn.One });
        }
        break;
      }
      case 'openReference': {
        if (!report || typeof message.findingId !== 'string' || !Number.isSafeInteger(message.referenceIndex) || Number(message.referenceIndex) < 0) { return; }
        const url = report.findings.find(finding => finding.id === message.findingId)?.references[Number(message.referenceIndex)];
        if (url && /^https?:\/\//.test(url)) { await vscode.env.openExternal(vscode.Uri.parse(url)); }
        break;
      }
    }
  });
  view.setHtml(buildSecurityHtml({ nonce: randomBytes(24).toString('base64'), cspSource: view.panel.webview.cspSource,
    script: view.panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'security-webview.js')).toString(),
    style: view.panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'security-webview.css')).toString() }));
  return view;
}
