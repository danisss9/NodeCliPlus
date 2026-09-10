import { escapeHtml } from './html-utils';

export function buildNpmGraphHtml(script: string, style: string, cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${escapeHtml(nonce)}'; style-src ${escapeHtml(cspSource)} 'unsafe-inline'; img-src data:;">
<title>npm Dependency Graph</title><link rel="stylesheet" href="${escapeHtml(style)}"></head>
<body>
<header><div><h1>npm Dependency Graph</h1><p id="summary" role="status">Loading dependencies…</p></div>
<div class="toolbar"><button id="missing-peers" aria-pressed="false" disabled>Find missing peer dependencies</button><button id="security-scan" title="Open a package security review for this workspace">Security scan</button><button id="expand-all" disabled>Expand all packages</button><button id="fit" disabled>Fit</button><button id="reset" disabled>Reset</button><button id="refresh">Refresh</button></div></header>
<div id="diagnostics" role="status" hidden></div>
<main><section class="network" aria-label="Dependency network">
<div id="graph" aria-label="Interactive dependency graph. Use package search for keyboard navigation."></div>
<div id="empty" hidden>No dependencies declared.</div>
<div class="legend" aria-label="Dependency types"><span class="production">Production</span><span class="development">Development</span><span class="optional">Optional</span><span class="peer">Peer</span><span class="problem">Dependency problem</span></div>
<p class="hint">Drag nodes · Scroll to zoom · Drag background to pan</p>
</section><aside aria-label="Package explorer">
<label for="search">Find a package</label><input id="search" type="search" placeholder="Package name or version" autocomplete="off" disabled>
<p id="peer-notice" role="status" hidden></p>
<p id="search-count" role="status"></p><div id="results" aria-label="Package search results"></div>
<section id="details" aria-label="Selected package"><h2>Select a package</h2><p>Select a node or search result to inspect and expand its dependencies.</p></section>
</aside></main><script nonce="${escapeHtml(nonce)}" src="${escapeHtml(script)}"></script></body></html>`;
}
