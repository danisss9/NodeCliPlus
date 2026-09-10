import { reportContent } from './security-html';
import type { SecurityReviewReport } from './security-types';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
interface PageElement { value?: string; textContent: string | null; disabled?: boolean; hidden?: boolean; innerHTML: string }
interface PageDocument {
  getElementById(id: string): PageElement | null;
  querySelectorAll(selector: string): ArrayLike<{ hidden: boolean; dataset: Record<string, string | undefined> }>;
  addEventListener(type: string, listener: (event: PageEvent) => void): void;
}
interface PageEvent {
  target?: { closest(selector: string): { id?: string; dataset: Record<string, string>; getAttribute(name: string): string | null } | null };
  preventDefault(): void;
}
const document = (globalThis as unknown as { document: PageDocument }).document;
const bridge = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
const element = (id: string) => document.getElementById(id);
function filter() {
  const search = element('search')?.value?.toLowerCase() ?? '';
  const category = element('category')?.value ?? '';
  const severity = element('severity')?.value ?? '';
  let shown = 0, total = 0;
  for (const finding of Array.from(document.querySelectorAll('.finding'))) {
    total++;
    finding.hidden = !(finding.dataset.search?.includes(search) && (!category || finding.dataset.category === category) && (!severity || finding.dataset.severity === severity));
    if (!finding.hidden) { shown++; }
  }
  const count = element('finding-count'); if (count) { count.textContent = `${shown} of ${total} findings`; }
  const empty = element('no-matches'); if (empty) { empty.hidden = shown !== 0 || total === 0; }
}
document.addEventListener('input', filter); document.addEventListener('change', filter);
document.addEventListener('click', event => {
  const target = event.target?.closest('button, a[data-reference]');
  if (!target || !bridge) { return; }
  if (target.dataset.open) { bridge.postMessage({ command: 'openFile', findingId: target.dataset.open, evidenceIndex: Number(target.dataset.index) }); }
  else if (target.dataset.reference) { event.preventDefault(); bridge.postMessage({ command: 'openReference', findingId: target.dataset.reference, referenceIndex: Number(target.dataset.index) }); }
  else if (['rescan', 'cancel', 'save'].includes(target.id ?? '')) { bridge.postMessage({ command: target.id }); }
});
(globalThis as unknown as { addEventListener(type: string, callback: (event: { data: { type: string; message?: string; report?: SecurityReviewReport } }) => void): void })
  .addEventListener('message', event => {
    const message = event.data;
    if (!message || !['progress', 'report', 'idle'].includes(message.type)) { return; }
    const progress = element('progress'); if (progress) { progress.textContent = message.message ?? (message.report ? `Review ${message.report.state}` : 'Scanning…'); }
    const busy = message.type === 'progress';
    const cancel = element('cancel'); if (cancel) { cancel.disabled = !busy; }
    const rescan = element('rescan'); if (rescan) { rescan.disabled = busy; }
    const save = element('save'); if (save) { save.disabled = busy || !message.report; }
    if (message.type === 'report' && message.report) {
      const report = element('report'); if (report) { report.innerHTML = reportContent(message.report); } filter();
    }
    if (message.type === 'idle') { const report = element('report'); if (report) { report.textContent = message.message ?? 'Run Rescan to review the current installed files.'; } }
  });
bridge?.postMessage({ command: 'ready' });
filter();
