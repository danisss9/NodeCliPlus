const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildSecurityHtml } = require('../../out/security-html');
let server, base;
function fixture() {
  const finding = (id, category, severity, name) => ({ id, category, severity, confidence: 'medium', packageId: name, packageName: name, version: '1.0.0', location: `node_modules/${name}`, dependencyPath: ['app', name], ruleId: `rule-${id}`, title: 'Install script review', description: 'Investigate this installation input.', recommendation: 'Inspect the evidence.', references: ['https://example.invalid/advisory'], evidence: [{ file: `node_modules/${name}/install.js`, line: 2, column: 1, snippet: '<script>window.pwned = true</script>', lifecycle: `${name}:postinstall`, chain: ['postinstall', 'install.js'] }] });
  return { schemaVersion: 1, id: 'fixture', projectName: 'Example application', startedAt: '2026-09-08T10:00:00Z', finishedAt: '2026-09-08T10:01:00Z', state: 'partial', packageCount: 100, inputCount: 15, inputBytes: 16384, engineVersion: '1.20.0', catalogVersion: '2026-09-08.1', rulesetVersion: '1.0.0', coverage: [{ component: 'scripts', state: 'partial', checked: 15, messages: ['One dynamic reference could not be resolved.'] }], findings: [finding('one', 'known-malicious', 'critical', 'compromised'), finding('two', 'vulnerability', 'high', 'vulnerable'), finding('three', 'script-pattern', 'low', 'installer')] };
}
test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/export') {
      response.setHeader('Content-Type', 'text/html');
      response.end(buildSecurityHtml({ nonce: 'browser-test', standalone: true, report: fixture(), script: fs.readFileSync(path.resolve('dist/security-webview.js'), 'utf8'), style: fs.readFileSync(path.resolve('dist/security-webview.css'), 'utf8') }));
    } else if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html'); response.end(buildSecurityHtml({ nonce: 'browser-test', cspSource: base, script: `${base}/security-webview.js`, style: `${base}/security-webview.css` }));
    } else if (['/security-webview.js', '/security-webview.css'].includes(request.url)) {
      response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css'); response.end(fs.readFileSync(path.join(__dirname, '../../dist', request.url.slice(1))));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => new Promise(resolve => server.close(resolve)));
async function mount(page, report = fixture()) {
  await page.addInitScript(() => { window.__commands = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.__commands.push(message) }); });
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.goto(base);
  await expect.poll(() => page.evaluate(() => window.__commands)).toContainEqual({ command: 'ready' });
  await page.evaluate(report => window.dispatchEvent(new MessageEvent('message', { data: { type: 'report', report } })), report);
  await expect(page.locator('.finding')).toHaveCount(report.findings.length);
}
test('renders separate categories, partial coverage and escaped evidence', async ({ page }) => {
  await mount(page); await expect(page.locator('.total')).toHaveCount(3);
  await expect(page.locator('.coverage')).toHaveAttribute('open', '');
  await page.locator('.finding summary').first().click();
  await expect(page.locator('.evidence pre').first()).toContainText('<script>window.pwned');
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await page.screenshot({ path: '.security-test-results/report-webview.png', fullPage: true });
});
test('searches and combines severity/category filters', async ({ page }) => {
  await mount(page); await page.locator('#search').fill('installer');
  await expect(page.locator('.finding:visible')).toHaveCount(1);
  await page.locator('#severity').selectOption('high'); await expect(page.locator('#no-matches')).toBeVisible();
  await page.locator('#search').fill(''); await page.locator('#category').selectOption('vulnerability');
  await expect(page.locator('.finding:visible')).toHaveCount(1); await expect(page.locator('#finding-count')).toHaveText('1 of 3 findings');
});
test('sends host-owned evidence IDs and supports rescan, cancellation and export actions', async ({ page }) => {
  await mount(page); await page.locator('.finding summary').first().click();
  await page.locator('[data-open]').first().click(); await page.locator('[data-reference]').first().click();
  await page.locator('#save').click(); await page.locator('#rescan').click();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'progress', message: 'Scanning inputs…' } })));
  await expect(page.locator('#save')).toBeDisabled(); await expect(page.locator('#rescan')).toBeDisabled();
  await page.locator('#cancel').click();
  const commands = await page.evaluate(() => window.__commands);
  expect(commands).toContainEqual({ command: 'openFile', findingId: 'one', evidenceIndex: 0 });
  expect(commands).toContainEqual({ command: 'openReference', findingId: 'one', referenceIndex: 0 });
  for (const command of ['save', 'rescan', 'cancel']) { expect(commands).toContainEqual({ command }); }
});
test('shows bounded zero-findings language and cancelled state', async ({ page }) => {
  await mount(page, { ...fixture(), findings: [], state: 'cancelled' });
  await expect(page.locator('.empty')).toContainText('No findings detected within the scanned scope');
  await expect(page.locator('.overview .state')).toHaveText('cancelled');
});
test('an install with automatic review disabled leaves Rescan available and clears stale results', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'idle', message: 'Installation finished. Run Rescan to review the current installed files.' } })));
  await expect(page.locator('#rescan')).toBeEnabled(); await expect(page.locator('#save')).toBeDisabled(); await expect(page.locator('#cancel')).toBeDisabled();
  await expect(page.locator('.finding')).toHaveCount(0); await expect(page.locator('#report')).toContainText('Run Rescan');
});
test('standalone HTML works without VS Code or external assets', async ({ page }) => {
  const requests = []; page.on('request', request => requests.push(request.url()));
  await page.goto(`${base}/export`); await expect(page.locator('.finding')).toHaveCount(3);
  await page.locator('#search').fill('installer'); await expect(page.locator('.finding:visible')).toHaveCount(1);
  await page.locator('.finding:visible summary').click(); await expect(page.locator('.finding:visible .evidence')).toBeVisible();
  expect(requests).toEqual([`${base}/export`]); await expect(page.locator('[data-open]')).toHaveCount(0);
});
test('supports narrow layouts and light/dark themes without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 }); await page.emulateMedia({ colorScheme: 'light' });
  await mount(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.emulateMedia({ colorScheme: 'dark' }); await page.locator('.finding summary').first().click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
