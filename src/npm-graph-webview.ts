/// <reference lib="dom" />
import cytoscape = require('cytoscape');
import { DependencyGraphIndex } from './npm-graph-view-model';
import type { DependencyGraph, DependencyKind } from './npm-graph';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const summary = element('summary');
const search = element<HTMLInputElement>('search');
const details = element('details');
const results = element('results');
let index: DependencyGraphIndex | undefined;
let selected: string | undefined;
let expanded = new Set<string>();
let cy: cytoscape.Core | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let busy = false;
let missingPeersOnly = false;
let openingSecurity = false;

function color(variable: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(variable).trim() || fallback;
}
function kindColor(kind: DependencyKind): string {
  return {
    production: color('--vscode-charts-blue', '#3794ff'),
    development: color('--vscode-charts-purple', '#b180d7'),
    optional: color('--vscode-charts-green', '#89d185'),
    peer: color('--vscode-charts-orange', '#d18616'),
  }[kind];
}
function graphStyles(): cytoscape.StylesheetJson {
  return [
    { selector: 'node', style: {
      label: 'data(label)', 'background-color': 'data(color)', color: color('--vscode-foreground', '#cccccc'),
      'font-size': 11, 'text-wrap': 'wrap', 'text-max-width': '160px',
      'text-valign': 'bottom', 'text-margin-y': 7, width: 26, height: 26,
      'border-width': 2, 'border-color': 'data(color)',
    } },
    { selector: 'node.root', style: { shape: 'round-rectangle', width: 46, height: 36 } },
    { selector: 'node.expanded', style: { 'border-width': 4, 'border-color': color('--vscode-foreground', '#cccccc') } },
    { selector: 'node.problem', style: { 'border-color': color('--vscode-errorForeground', '#f48771'), 'border-width': 4, 'border-style': 'dashed' } },
    { selector: 'node:selected', style: { 'overlay-opacity': 0.2, 'overlay-color': color('--vscode-focusBorder', '#007fd4'), 'overlay-padding': 9 } },
    { selector: 'edge', style: {
      width: 1.3, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle',
      'line-color': 'data(color)', 'target-arrow-color': 'data(color)', opacity: 0.55,
    } },
  ];
}

function renderGraph(fit = false, resetPositions = false) {
  if (!index || !cy) { return; }
  const visible = index.visible(expanded);
  const edgeIds = new Set(visible.edges.map(edge => `edge:${edge.id}`));
  const existing = new Set(cy.nodes().map(node => node.id()));
  let ordinal = existing.size;
  cy.batch(() => {
    cy!.edges().filter(edge => !edgeIds.has(edge.id())).remove();
    cy!.nodes().filter(node => !visible.nodes.has(node.id())).remove();
    for (const id of visible.nodes) {
      const node = index!.nodes.get(id)!;
      const data = { id, label: `${node.name}\n${node.version ?? 'unresolved'}`, color: kindColor(node.kinds[0] ?? 'production') };
      let item = cy!.getElementById(id);
      if (item.empty()) {
        const parent = index!.incoming.get(id)?.find(edge => cy!.getElementById(edge.source).nonempty());
        const position = parent ? cy!.getElementById(parent.source).position() : { x: 0, y: 0 };
        // Deterministic offsets keep new siblings apart without moving existing nodes.
        item = cy!.add({ group: 'nodes', data, position: {
          x: position.x + Math.cos(ordinal * 2.4) * 110,
          y: position.y + Math.sin(ordinal * 2.4) * 110,
        } });
        ordinal++;
      }
      item.toggleClass('root', id === index!.graph.root);
      item.toggleClass('expanded', expanded.has(id));
      item.toggleClass('problem', node.status.some(status => status !== 'unresolved'));
    }
    for (const edge of visible.edges) {
      if (cy!.getElementById(`edge:${edge.id}`).empty()) {
        cy!.add({ group: 'edges', data: { id: `edge:${edge.id}`, source: edge.source, target: edge.target, color: kindColor(edge.kinds[0]) } });
      }
    }
  });
  if (!resetPositions) {
    cy.nodes().filter(node => existing.has(node.id())).lock();
  }
  const movable = cy.nodes().filter(node => !node.locked());
  try {
    // Compute final positions before the next paint, without visible simulation.
    // CoSE compares node pairs, so use a linear grid layout for large networks.
    if (cy.nodes().length > 300) {
      const bounds = cy.nodes().filter(node => node.locked()).boundingBox();
      const columns = Math.ceil(Math.sqrt(movable.length * Math.max(1, cy.width() / cy.height()) / 2));
      if (movable.length) {
        movable.layout({
          name: 'grid', animate: false, fit: false, cols: columns,
          boundingBox: {
            x1: resetPositions || !existing.size ? 0 : bounds.x2 + 180,
            y1: resetPositions || !existing.size ? 0 : bounds.y1,
            w: columns * 200, h: Math.ceil(movable.length / columns) * 100,
          },
        }).run();
      }
    } else if (movable.length) {
      cy.layout({
        name: 'cose', animate: false, fit: false,
        randomize: false, numIter: 250, nodeRepulsion: () => 10000,
        idealEdgeLength: () => 110, nodeOverlap: 20, componentSpacing: 120,
      }).run();
    }
  } finally {
    cy.nodes().unlock();
  }
  if (fit) { cy.fit(undefined, 55); }
  summary.textContent = `${index.graph.source} · ${visible.nodes.size - 1} of ${index.graph.nodes.length - 1} packages visible · ${visible.edges.length} connections`;
  element('empty').hidden = index.graph.edges.length > 0;
  if (selected && !visible.nodes.has(selected)) { selected = index.graph.root; }
  if (selected) { cy.nodes().unselect(); cy.getElementById(selected).select(); }
  showDetails();
  updateExpandAll();
}

function text(tag: string, content: string, parent: HTMLElement): HTMLElement {
  const child = document.createElement(tag);
  child.textContent = content;
  parent.appendChild(child);
  return child;
}

function selectPackage(id: string, reveal = false) {
  if (!index || !cy) { return; }
  selected = id;
  if (reveal && cy.getElementById(id).empty()) {
    for (const ancestor of index.shortestPath(id).slice(0, -1)) { expanded.add(ancestor); }
    renderGraph();
  }
  cy.nodes().unselect();
  const node = cy.getElementById(id);
  node.select();
  if (reveal) { cy.center(node); }
  showDetails();
}

function showDetails() {
  if (!index || !selected) { return; }
  const node = index.nodes.get(selected);
  if (!node) { return; }
  details.replaceChildren();
  text('h2', node.name, details);
  text('p', `Version: ${node.version ?? 'Unresolved'}`, details);
  if (node.kinds.length) { text('p', `Types: ${node.kinds.join(', ')}`, details); }
  text('p', `Status: ${node.id === index.graph.root ? 'Project' : node.status.join(', ') || (index.graph.source === 'Installed' ? 'Installed' : 'Recorded in lockfile')}`, details);
  if (node.path) { text('p', node.path, details).className = 'package-path'; }
  const dependencies = index.outgoing.get(node.id) ?? [];
  text('p', `${dependencies.length} immediate dependencies`, details);
  const toggle = document.createElement('button');
  toggle.id = 'toggle-package';
  toggle.textContent = expanded.has(node.id) ? 'Collapse' : 'Expand';
  toggle.disabled = dependencies.length === 0 || node.id === index.graph.root;
  toggle.setAttribute('aria-expanded', String(expanded.has(node.id)));
  toggle.addEventListener('click', () => {
    if (expanded.has(node.id)) { expanded.delete(node.id); } else { expanded.add(node.id); }
    // Forget expansion state for branches removed by a collapse.
    const visible = index!.visible(expanded).nodes;
    expanded = new Set([...expanded].filter(id => visible.has(id)));
    renderGraph();
    element('toggle-package').focus();
  });
  details.appendChild(toggle);
  const incoming = index.incoming.get(node.id) ?? [];
  if (incoming.length) {
    text('h3', 'Required by', details);
    const list = document.createElement('ul');
    for (const edge of incoming.slice(0, 100)) {
      const parent = index.nodes.get(edge.source)!;
      const item = text('li', `${parent.name}: ${edge.name}${edge.requested ? ` ${edge.requested}` : ''} (${edge.kinds.join(', ')})`, list);
      item.title = parent.path ?? parent.id;
    }
    details.appendChild(list);
    if (incoming.length > 100) { text('p', `${incoming.length - 100} more dependents`, details); }
  }
}

function searchPackages() {
  if (!index) { return; }
  const query = search.value.trim().toLowerCase();
  const missingPeers = missingPeersOnly ? index.missingPeerIds() : undefined;
  const matches = index.graph.nodes.filter(node => {
    if (node.id === index!.graph.root || missingPeers && !missingPeers.has(node.id)) { return false; }
    if (query) {
      return `${node.name} ${node.version ?? ''} ${(index!.incoming.get(node.id) ?? []).map(edge => edge.name).join(' ')}`.toLowerCase().includes(query);
    }
    return missingPeersOnly || (index!.outgoing.get(index!.graph.root) ?? []).some(edge => edge.target === node.id);
  });
  element('missing-peers').setAttribute('aria-pressed', String(missingPeersOnly));
  const notice = element('peer-notice');
  notice.hidden = !missingPeersOnly;
  notice.textContent = index.graph.source === 'Declared only'
    ? 'Missing peers cannot be checked from declarations alone. Install dependencies, then Refresh.'
    : index.graph.source === 'Lockfile'
      ? 'Showing missing required peers reported in the lockfile; installed packages have not been checked. Optional peers are excluded.'
      : 'Showing missing required peers in the current graph, including nested packages. Optional peers are excluded. Use Refresh to check again.';
  results.replaceChildren();
  element('search-count').textContent = missingPeersOnly && index.graph.source === 'Declared only' ? 'Peer check unavailable'
    : `${matches.length} ${missingPeersOnly ? `${query ? 'matching ' : ''}missing peer ${matches.length === 1 ? 'dependency' : 'dependencies'}` : `${query ? 'matching' : 'direct'} packages`}${matches.length > 100 ? ' · showing first 100; refine your search' : ''}`;
  for (const node of matches.slice(0, 100)) {
    const button = document.createElement('button');
    button.className = 'result';
    button.textContent = `${node.name} ${node.version ?? '(unresolved)'}`;
    button.title = node.path ?? node.id;
    button.addEventListener('click', () => selectPackage(node.id, true));
    results.appendChild(button);
  }
}

function updateExpandAll() {
  element<HTMLButtonElement>('expand-all').disabled = busy || !index
    || [...index.outgoing.keys()].every(id => expanded.has(id));
}

function setBusy(value: boolean) {
  busy = value;
  element<HTMLButtonElement>('refresh').disabled = value;
  element<HTMLButtonElement>('fit').disabled = value || !cy;
  element<HTMLButtonElement>('reset').disabled = value || !cy;
  element<HTMLButtonElement>('missing-peers').disabled = value || !index;
  updateExpandAll();
  search.disabled = value || !index;
  if (value) { summary.textContent = 'Loading dependencies…'; }
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (message?.type === 'securityScanFinished') {
    openingSecurity = false;
    element<HTMLButtonElement>('security-scan').disabled = false;
    element('security-scan').textContent = 'Security scan';
  }
  if (message?.type === 'loading') { setBusy(true); }
  if (message?.type === 'error') {
    setBusy(false);
    element('diagnostics').hidden = false;
    element('diagnostics').textContent = message.message;
    summary.textContent = index ? `${index.graph.source} · Refresh failed; showing previous graph` : 'Unable to load dependencies';
  }
  if (message?.type === 'graph') {
    // Reuse the canvas on refresh.
    cy?.elements().remove();
    index = new DependencyGraphIndex(message.graph as DependencyGraph);
    expanded = new Set([index.graph.root]);
    selected = index.graph.root;
    search.value = '';
    const diagnostics = element('diagnostics');
    diagnostics.replaceChildren();
    diagnostics.hidden = !index.graph.diagnostics.length;
    if (index.graph.diagnostics.length) {
      const disclosure = document.createElement('details');
      text('summary', `${index.graph.diagnostics.length} dependency notices`, disclosure);
      text('pre', index.graph.diagnostics.join('\n'), disclosure);
      diagnostics.appendChild(disclosure);
    }
    if (!cy) {
      cy = cytoscape({ container: element('graph'), style: graphStyles(), minZoom: 0.001, maxZoom: 4, wheelSensitivity: 1 });
      cy.on('tap', 'node', event => selectPackage(event.target.id()));
    }
    renderGraph(true, true);
    searchPackages();
    setBusy(false);
  }
});
search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchPackages, 100); });
search.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'Enter') { clearTimeout(searchTimer); searchPackages(); }
  if (event.key === 'ArrowDown') { results.querySelector('button')?.focus(); }
  if (event.key === 'Enter') { results.querySelector('button')?.click(); }
});
element('fit').addEventListener('click', () => cy?.fit(undefined, 55));
element('missing-peers').addEventListener('click', () => {
  if (!index || busy) { return; }
  missingPeersOnly = !missingPeersOnly;
  search.value = '';
  searchPackages();
  search.focus();
});
element('security-scan').addEventListener('click', () => {
  if (openingSecurity) { return; }
  openingSecurity = true;
  element<HTMLButtonElement>('security-scan').disabled = true;
  element('security-scan').textContent = 'Opening security review…';
  vscode.postMessage({ command: 'securityScan' });
});
element('expand-all').addEventListener('click', () => {
  if (!index || busy) { return; }
  expanded = new Set([index.graph.root, ...index.outgoing.keys()]);
  renderGraph(true, true);
});
element('reset').addEventListener('click', () => {
  if (!index) { return; }
  expanded = new Set([index.graph.root]);
  selected = index.graph.root;
  missingPeersOnly = false;
  search.value = '';
  renderGraph(true, true);
  searchPackages();
});
element('refresh').addEventListener('click', () => {
  if (!busy) { setBusy(true); vscode.postMessage({ command: 'refresh' }); }
});
const observer = new MutationObserver(() => {
  if (cy) {
    cy.nodes().forEach(node => { node.data('color', kindColor(index!.nodes.get(node.id())?.kinds[0] ?? 'production')); });
    cy.edges().forEach(edge => {
      const original = index!.outgoing.get(edge.source().id())?.find(candidate => `edge:${candidate.id}` === edge.id());
      edge.data('color', kindColor(original?.kinds[0] ?? 'production'));
    });
    cy.style(graphStyles());
  }
});
observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-id'] });
window.addEventListener('pagehide', () => { clearTimeout(searchTimer); observer.disconnect(); cy?.destroy(); });
vscode.postMessage({ command: 'ready' });
