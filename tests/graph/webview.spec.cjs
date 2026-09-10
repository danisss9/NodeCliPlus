const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildNpmGraphHtml } = require('../../out/npm-graph-html');
const { normalizeDependencyGraph } = require('../../out/npm-graph');

let server;
let base;
const root = '/project';
const pkg = (name, dependencies = {}) => ({ name, version: '1.0.0', path: `${root}/node_modules/${name}`, dependencies });
function fixture() {
  const shared = pkg('shared', { leaf: pkg('leaf') });
  return normalizeDependencyGraph({ dependencies: {
    alpha: pkg('alpha', { shared }), beta: pkg('beta', { shared }),
    bad: { ...pkg('bad'), invalid: '^2' },
  } }, { name: 'test-app', dependencies: { alpha: '^1', beta: '^1', bad: '^2' } }, root, 'Installed');
}

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(buildNpmGraphHtml(`${base}/npm-graph-webview.js`, `${base}/npm-graph-webview.css`, base, 'browser-test'));
    } else if (['/npm-graph-webview.js', '/npm-graph-webview.css'].includes(request.url)) {
      response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      response.end(fs.readFileSync(path.join(__dirname, '../../dist', request.url.slice(1))));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

async function mount(page, graph = fixture()) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__commands = [];
    window.acquireVsCodeApi = () => ({ postMessage: message => window.__commands.push(message) });
  });
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.goto(base);
  await expect.poll(() => page.evaluate(() => window.__commands)).toContainEqual({ command: 'ready' });
  await page.evaluate(graph => window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph } })), graph);
  await expect(page.locator('#summary')).toContainText(graph.source);
  return errors;
}
async function select(page, name) {
  await page.locator('#search').fill(name);
  await page.locator('#results button').filter({ hasText: `${name} 1.0.0` }).first().click();
  await expect(page.locator('#details h2')).toHaveText(name);
}
async function visibleNames(page) {
  return page.evaluate(() => document.getElementById('graph')._cyreg.cy.nodes().map(node => node.data('label').split('\n')[0]).sort());
}

async function expectStableLayout(page) {
  const moved = await page.evaluate(async () => {
    const cy = document.getElementById('graph')._cyreg.cy;
    const snapshot = () => JSON.stringify({
      positions: cy.nodes().map(node => node.position()), pan: cy.pan(), zoom: cy.zoom(),
    });
    const initial = snapshot();
    for (let frame = 0; frame < 30; frame++) {
      await new Promise(requestAnimationFrame);
      if (snapshot() !== initial) { return true; }
    }
    return false;
  });
  expect(moved).toBe(false);
}

test('shows settled positions immediately on load, expansion, reset and refresh', async ({ page }) => {
  const errors = await mount(page);
  await expectStableLayout(page);
  await select(page, 'alpha');
  await page.locator('#toggle-package').click();
  await expectStableLayout(page);
  await page.locator('#reset').click();
  await expectStableLayout(page);
  await page.evaluate(graph => window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph } })), fixture());
  await expectStableLayout(page);
  expect(errors).toEqual([]);
});

test('expands every nested level, handles cycles and can collapse and reset afterwards', async ({ page }) => {
  const graph = fixture();
  const alpha = graph.nodes.find(node => node.name === 'alpha').id;
  const leaf = graph.nodes.find(node => node.name === 'leaf').id;
  graph.edges.push({ id: 'cycle', source: leaf, target: alpha, name: 'alpha', kinds: ['production'], requested: '^1' });
  const errors = await mount(page, graph);
  await page.locator('#expand-all').click();
  expect(await visibleNames(page)).toEqual(graph.nodes.map(node => node.name).sort());
  expect(await page.evaluate(() => document.getElementById('graph')._cyreg.cy.edges().length)).toBe(graph.edges.length);
  await expect(page.locator('#expand-all')).toBeDisabled();
  await expectStableLayout(page);
  await select(page, 'shared');
  await expect(page.locator('#toggle-package')).toHaveText('Collapse');
  await page.locator('#toggle-package').click();
  expect(await visibleNames(page)).not.toContain('leaf');
  await expect(page.locator('#expand-all')).toBeEnabled();
  await page.locator('#expand-all').click();
  await page.locator('#reset').click();
  expect(await visibleNames(page)).toEqual(['alpha', 'bad', 'beta', 'test-app']);
  await expect(page.locator('#expand-all')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('expands, preserves shared branches, searches hidden packages and resets', async ({ page }) => {
  const errors = await mount(page);
  expect(await visibleNames(page)).toEqual(['alpha', 'bad', 'beta', 'test-app']);
  await select(page, 'alpha');
  await page.locator('#toggle-package').click();
  expect(await visibleNames(page)).toContain('shared');
  await select(page, 'beta');
  await page.locator('#toggle-package').click();
  await select(page, 'alpha');
  await page.locator('#toggle-package').click();
  expect(await visibleNames(page)).toContain('shared');
  await select(page, 'beta');
  await page.locator('#toggle-package').click();
  expect(await visibleNames(page)).not.toContain('shared');
  await select(page, 'leaf');
  expect(await visibleNames(page)).toContain('leaf');
  await expect(page.locator('#details')).toContainText('shared: leaf');
  await page.locator('#reset').click();
  expect(await visibleNames(page)).toHaveLength(4);
  await expect(page.locator('#search')).toHaveValue('');
  expect(errors).toEqual([]);
});

test('supports keyboard exploration, node dragging, pan, zoom and fit', async ({ page }) => {
  const errors = await mount(page);
  await page.locator('#search').fill('alpha');
  await expect(page.locator('#results button')).toHaveCount(1);
  await page.locator('#search').press('ArrowDown');
  await expect(page.locator('#results button')).toBeFocused();
  await page.locator('#results button').press('Enter');
  await page.locator('#toggle-package').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#toggle-package')).toHaveText('Collapse');
  await page.locator('#fit').click();
  const getPoint = () => page.evaluate(() => {
    const container = document.getElementById('graph');
    const node = container._cyreg.cy.nodes().filter(node => node.data('label').startsWith('alpha\n'))[0];
    const rect = container.getBoundingClientRect();
    const point = node.renderedPosition();
    return { x: rect.x + point.x, y: rect.y + point.y };
  });
  const before = await getPoint();
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.mouse.move(before.x + 60, before.y + 35, { steps: 8 });
  await page.mouse.up();
  const after = await getPoint();
  expect(Math.abs(after.x - before.x)).toBeGreaterThan(30);
  const originalZoom = await page.evaluate(() => document.getElementById('graph')._cyreg.cy.zoom());
  await page.mouse.wheel(0, -300);
  await expect.poll(() => page.evaluate(() => document.getElementById('graph')._cyreg.cy.zoom())).toBeGreaterThan(originalZoom);
  const pan = await page.evaluate(() => document.getElementById('graph')._cyreg.cy.pan());
  const box = await page.locator('#graph').boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 40, { steps: 8 });
  await page.mouse.up();
  const nextPan = await page.evaluate(() => document.getElementById('graph')._cyreg.cy.pan());
  expect(Math.abs(nextPan.x - pan.x)).toBeGreaterThan(30);
  await page.locator('#fit').click();
  expect(errors).toEqual([]);
});

test('preserves existing package positions when expanding a branch', async ({ page }) => {
  await mount(page);
  await select(page, 'alpha');
  await page.locator('#fit').click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const positions = () => page.evaluate(() => document.getElementById('graph')._cyreg.cy.nodes().filter(node => !node.data('label').startsWith('shared\n')).map(node => ({ id: node.id(), ...node.position() })));
  const before = await positions();
  await page.locator('#toggle-package').click();
  await expect.poll(() => page.evaluate(() => document.getElementById('graph')._cyreg.cy.nodes().some(node => node.locked()))).toBe(false);
  const after = await positions();
  for (const position of before) {
    const next = after.find(node => node.id === position.id);
    expect(next.x).toBeCloseTo(position.x, 3);
    expect(next.y).toBeCloseTo(position.y, 3);
  }
});

test('refresh, failure notices, empty data and hostile package text are safe', async ({ page }) => {
  const errors = await mount(page);
  await page.locator('#refresh').click();
  expect(await page.evaluate(() => window.__commands)).toContainEqual({ command: 'refresh' });
  await expect(page.locator('#refresh')).toBeDisabled();
  await expect(page.locator('#expand-all')).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'package.json is malformed' } })));
  await expect(page.locator('#diagnostics')).toContainText('malformed');
  await expect(page.locator('#refresh')).toBeEnabled();
  const malicious = '<img src=x onerror="window.hacked=true">';
  const graph = normalizeDependencyGraph({}, { name: 'empty', dependencies: { [malicious]: '^1' } }, root, 'Declared only', ['npm failed']);
  await page.evaluate(graph => window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph } })), graph);
  await page.locator('#results button').click();
  await expect(page.locator('#details h2')).toHaveText(malicious);
  await expect(page.locator('#details img')).toHaveCount(0);
  expect(await page.evaluate(() => window.hacked)).toBeUndefined();
  await expect(page.locator('#details')).toContainText('Unresolved');
  const empty = normalizeDependencyGraph({}, { name: 'empty' }, root, 'Declared only');
  await page.evaluate(graph => window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph } })), empty);
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#expand-all')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('loads 5000 packages, reveals a deep result, and follows theme changes', async ({ page }, testInfo) => {
  const dependencies = {};
  for (let i = 0; i < 50; i++) {
    const children = {};
    for (let j = 0; j < 99; j++) { children[`child-${i}-${j}`] = pkg(`child-${i}-${j}`); }
    dependencies[`group-${i}`] = pkg(`group-${i}`, children);
  }
  const graph = normalizeDependencyGraph({ dependencies }, { name: 'large-app' }, root, 'Installed');
  const start = Date.now();
  const errors = await mount(page, graph);
  await expect(page.locator('#summary')).toContainText('50 of 5000 packages');
  await select(page, 'child-49-98');
  await expect(page.locator('#summary')).toContainText('149 of 5000 packages');
  expect(Date.now() - start).toBeLessThan(10000);
  await page.locator('#fit').click();
  await page.screenshot({ path: testInfo.outputPath('graph-dark.png') });
  await page.evaluate(() => {
    document.body.style.cssText = '--vscode-editor-background: #ffffff; --vscode-foreground: #222222; --vscode-sideBar-background: #f3f3f3; --vscode-input-background: #ffffff; --vscode-input-foreground: #222222; --vscode-charts-blue: #005fb8; --vscode-descriptionForeground: #555555';
  });
  await expect.poll(() => page.evaluate(() => document.getElementById('graph')._cyreg.cy.nodes()[0].style('color'))).toBe('rgb(34,34,34)');
  await page.screenshot({ path: testInfo.outputPath('graph-light.png') });
  const expandStart = Date.now();
  await page.locator('#expand-all').click();
  await expect(page.locator('#summary')).toContainText('5000 of 5000 packages');
  expect(await visibleNames(page)).toHaveLength(5001);
  await expectStableLayout(page);
  expect(Date.now() - expandStart).toBeLessThan(10000);
  const fits = await page.evaluate(() => {
    const cy = document.getElementById('graph')._cyreg.cy;
    const bounds = cy.elements().renderedBoundingBox();
    return bounds.x1 >= 0 && bounds.y1 >= 0 && bounds.x2 <= cy.width() && bounds.y2 <= cy.height();
  });
  expect(fits).toBe(true);
  await page.setViewportSize({ width: 600, height: 400 });
  await expect(page.locator('#search')).toBeVisible();
  await expect(page.locator('#refresh')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('finds nested missing peers, reveals their dependents, and clears resolved results on refresh', async ({ page }) => {
  const graph = normalizeDependencyGraph({ dependencies: {
    alpha: pkg('alpha', { plugin: { ...pkg('plugin', {
      required: { missing: true }, optional: {}, ordinary: { missing: true },
      incompatible: { ...pkg('incompatible'), invalid: '^2' },
    }), peerDependencies: { required: '^3', optional: '^1', incompatible: '^2' },
    peerDependenciesMeta: { optional: { optional: true } } } }),
  } }, { name: 'app', dependencies: { alpha: '^1' } }, root, 'Installed');
  const errors = await mount(page, graph);
  await page.locator('#search').fill('unrelated');
  await page.getByRole('button', { name: 'Find missing peer dependencies' }).click();
  await expect(page.locator('#missing-peers')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#search')).toHaveValue('');
  await expect(page.locator('#search-count')).toHaveText('1 missing peer dependency');
  await expect(page.locator('#results button')).toHaveCount(1);
  await expect(page.locator('#results button')).toHaveText('required (unresolved)');
  await page.locator('#search').press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(await visibleNames(page)).toContain('required');
  await expect(page.locator('#details')).toContainText('plugin: required ^3 (peer)');
  await expect(page.locator('#details')).toContainText('Status: missing');
  await page.locator('#search').fill('absent');
  await expect(page.locator('#search-count')).toHaveText('0 matching missing peer dependencies');
  await page.locator('#reset').click();
  await expect(page.locator('#missing-peers')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#peer-notice')).toBeHidden();
  await page.locator('#missing-peers').click();
  await page.locator('#refresh').click();
  await expect(page.locator('#missing-peers')).toBeDisabled();
  await page.evaluate(graph => window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph } })), fixture());
  await expect(page.locator('#missing-peers')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#search-count')).toHaveText('0 missing peer dependencies');
  await page.locator('#missing-peers').click();
  await expect(page.locator('#results button')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('describes peer-check coverage for lockfile and declaration-only graphs', async ({ page }) => {
  const graph = normalizeDependencyGraph({}, { name: 'app', peerDependencies: { required: '^3', optional: '^1' },
    peerDependenciesMeta: { optional: { optional: true } } }, root, 'Lockfile');
  await mount(page, graph);
  await page.locator('#missing-peers').click();
  await expect(page.locator('#peer-notice')).toContainText('installed packages have not been checked');
  await expect(page.locator('#results button')).toHaveCount(1);
  graph.source = 'Declared only';
  await page.evaluate(graph => window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph } })), graph);
  await expect(page.locator('#peer-notice')).toContainText('cannot be checked');
  await expect(page.locator('#search-count')).toHaveText('Peer check unavailable');
});

test('opens security review with duplicate-click protection and re-enables the action after completion', async ({ page }) => {
  const errors = await mount(page);
  await page.getByRole('button', { name: 'Security scan', exact: true }).click();
  await expect(page.locator('#security-scan')).toBeDisabled();
  await expect(page.locator('#security-scan')).toHaveText('Opening security review…');
  expect(await page.evaluate(() => window.__commands.filter(message => message.command === 'securityScan'))).toEqual([{ command: 'securityScan' }]);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'securityScanFinished' } })));
  await expect(page.locator('#security-scan')).toBeEnabled();
  await expect(page.locator('#security-scan')).toHaveText('Security scan');
  await page.setViewportSize({ width: 600, height: 400 });
  await expect(page.locator('#security-scan')).toBeVisible();
  await expect(page.locator('#missing-peers')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
