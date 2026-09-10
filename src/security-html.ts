import { escapeHtml as escape } from './html-utils';
import { REVIEW_NOTICE, type FindingCategory, type SecurityReviewReport } from './security-types';

const LABELS: Record<FindingCategory, string> = { 'known-malicious': 'Known malicious', vulnerability: 'Vulnerabilities', 'script-pattern': 'Suspicious script patterns' };
export function reportContent(report: SecurityReviewReport, standalone = false): string {
  const count = (category: FindingCategory) => report.findings.filter(finding => finding.category === category).length;
  return `<section class="overview" aria-label="Review summary">
  <div><span class="state ${escape(report.state)}">${escape(report.state)}</span><h2>${escape(report.projectName)}</h2>
  <p>${escape(new Date(report.finishedAt).toLocaleString())} · ${report.packageCount} installed packages · ${report.inputCount} script inputs · ${(report.inputBytes / 1048576).toFixed(1)} MiB</p>
  ${report.installOutcome ? `<p>Installation result: ${escape(report.installOutcome)}. This review examines the resulting files.</p>` : ''}</div>
  <div class="totals">${Object.entries(LABELS).map(([category, label]) => `<div class="total"><strong>${count(category as FindingCategory)}</strong><span>${label}</span></div>`).join('')}</div></section>
  <p class="notice">${escape(REVIEW_NOTICE)}</p>
  <details class="coverage" ${report.state !== 'complete' ? 'open' : ''}><summary>Scan coverage · ${escape(report.state)}</summary>
  <p>YARA-X ${escape(report.engineVersion)} · Catalog ${escape(report.catalogVersion)} · Rules ${escape(report.rulesetVersion)}</p>
  <p>Started ${escape(report.startedAt)} · Finished ${escape(report.finishedAt)}</p>
  ${report.coverage.map(item => `<section><h3>${escape(item.component)} <span class="state ${escape(item.state)}">${escape(item.state)}</span></h3><p>${item.checked} checked</p>${item.messages.length ? `<ul>${item.messages.map(message => `<li>${escape(message)}</li>`).join('')}</ul>` : ''}</section>`).join('')}</details>
  <div class="filters"><label>Find a package or pattern<input id="search" type="search" placeholder="Package name, version, rule, or file"></label>
  <label>Category<select id="category"><option value="">All categories</option>${Object.entries(LABELS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
  <label>Severity<select id="severity"><option value="">All severities</option>${['critical', 'high', 'moderate', 'low'].map(value => `<option>${value}</option>`).join('')}</select></label></div>
  <p id="finding-count" role="status">${report.findings.length} findings</p>
  ${!report.findings.length ? '<p class="empty">No findings detected within the scanned scope. Review scan coverage above.</p>' : ''}
  <p id="no-matches" hidden>No findings match these filters.</p><section id="findings" aria-label="Security findings">
  ${report.findings.map(finding => `<details class="finding" data-category="${escape(finding.category)}" data-severity="${escape(finding.severity)}" data-search="${escape([finding.packageName, finding.version, finding.title, finding.ruleId, finding.location, ...finding.evidence.map(item => item.file)].join(' ').toLowerCase())}">
  <summary><span class="severity ${escape(finding.severity)}">${escape(finding.severity)}</span><span><strong>${escape(finding.packageName)}@${escape(finding.version)}</strong><span class="finding-title">${escape(finding.title)}</span></span><span class="category">${LABELS[finding.category]}</span></summary>
  <div class="finding-body"><p>${escape(finding.description)}</p><p>Confidence: <strong>${escape(finding.confidence)}</strong> · Rule/advisory: <code>${escape(finding.ruleId)}</code></p>
  <p>Installed location: <code>${escape(finding.location)}</code></p><p>Dependency path: ${escape(finding.dependencyPath.join(' → '))}</p>
  <h3>Suggested next step</h3><p>${escape(finding.recommendation)}</p>
  ${finding.references.filter(url => /^https?:\/\//.test(url)).map((url, index) => `<a href="${escape(url)}" rel="noreferrer noopener" target="_blank" data-reference="${escape(finding.id)}" data-index="${index}">Source ${index + 1}</a>`).join(' ')}
  ${finding.evidence.length ? `<h3>Evidence and installation references</h3>${finding.evidence.map((evidence, index) => `<section class="evidence"><p><code>${escape(evidence.file)}:${evidence.line}:${evidence.column}</code>
  ${standalone ? '' : `<button data-open="${escape(finding.id)}" data-index="${index}">Open File</button>`}</p>
  ${evidence.lifecycle ? `<p>Lifecycle: ${escape(evidence.lifecycle)}</p>` : ''}<p>${escape(evidence.chain.join(' → '))}</p>
  ${evidence.derived ? `<p>${escape(evidence.derived)}</p>` : ''}<pre><code>${escape(evidence.snippet)}</code></pre></section>`).join('')}` : ''}</div></details>`).join('')}</section>`;
}
export function buildSecurityHtml(options: { nonce: string; cspSource?: string; script: string; style: string; report?: SecurityReviewReport; standalone?: boolean }): string {
  const { nonce, standalone } = options;
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${standalone ? `'nonce-${nonce}'` : options.cspSource}; img-src data:; base-uri 'none'; form-action 'none';`;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><title>Package Security Review</title>
  ${standalone ? `<style nonce="${escape(nonce)}">${options.style}</style>` : `<link rel="stylesheet" href="${escape(options.style)}">`}</head><body>
  <header><div><h1>Package Security Review</h1><p id="progress" role="status">${options.report ? 'Review finished' : 'Preparing review…'}</p></div>
  ${standalone ? '<span>Exported report</span>' : '<div class="actions"><button id="rescan">Rescan</button><button id="cancel" disabled>Cancel</button><button id="save" disabled>Save HTML</button></div>'}</header>
  <main id="report">${options.report ? reportContent(options.report, standalone) : '<p class="notice">Reading installed dependencies and installation scripts…</p>'}</main>
  ${standalone ? `<script nonce="${escape(nonce)}">${options.script.replace(/<\/script/gi, '<\\/script')}</script>` : `<script nonce="${escape(nonce)}" src="${escape(options.script)}"></script>`}</body></html>`;
}
