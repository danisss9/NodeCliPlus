import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeDependencyGraph, normalizedPackagePath } from '../npm-graph';
import { DependencyGraphIndex } from '../npm-graph-view-model';
import { loadNpmDependencyGraph, type NpmGraphRunner } from '../npm-graph-loader';
import { spawnManaged } from '../spawn';
import { buildNpmGraphHtml } from '../npm-graph-html';
import { showNpmDependencyGraph } from '../npm-graph-command';
import { getExtensionContext, setExtensionContext } from '../state';

const root = '/project';
const pkg = (name: string, version = '1.0.0', dependencies = {}) => ({
  name, version, path: `${root}/node_modules/${name}`, dependencies,
});

suite('npm dependency graph normalization and navigation', () => {
  test('starts with direct dependencies and preserves shared branches on collapse', () => {
    const shared = pkg('shared', '2.0.0', { leaf: pkg('leaf') });
    const graph = normalizeDependencyGraph({ dependencies: {
      a: pkg('a', '1.0.0', { shared }), b: pkg('b', '1.0.0', { shared }),
    } }, { name: 'app', dependencies: { a: '^1', b: '^1' } }, root, 'Installed');
    const index = new DependencyGraphIndex(graph);
    const id = (name: string) => graph.nodes.find(node => node.name === name)!.id;
    const expanded = new Set([graph.root]);
    assert.strictEqual(index.visible(expanded).nodes.size, 3);
    expanded.add(id('a'));
    expanded.add(id('b'));
    expanded.add(id('shared'));
    assert.strictEqual(index.visible(expanded).nodes.size, 5);
    expanded.delete(id('a'));
    assert.ok(index.visible(expanded).nodes.has(id('leaf')));
    expanded.delete(id('b'));
    assert.strictEqual(index.visible(expanded).nodes.size, 3);
    assert.deepStrictEqual(index.shortestPath(id('leaf')), [graph.root, id('a'), id('shared'), id('leaf')]);
    assert.deepStrictEqual(index.shortestPath('absent'), []);
  });

  test('merges repeated npm references and retains outgoing edges and separate versions', () => {
    const graph = normalizeDependencyGraph({ dependencies: {
      a: pkg('a', '1', { shared: pkg('shared', '1') }),
      b: pkg('b', '1', { shared: pkg('shared', '1', { leaf: pkg('leaf') }) }),
      c: pkg('c', '1', { shared: { ...pkg('shared', '2'), path: `${root}/node_modules/c/node_modules/shared` } }),
    } }, {}, root, 'Installed');
    assert.strictEqual(graph.nodes.filter(node => node.name === 'shared').length, 2);
    assert.ok(graph.edges.some(edge => edge.source.endsWith('/shared') && edge.target.endsWith('/leaf')));
    assert.strictEqual(graph.nodes.length, 7);
  });

  test('handles cycles, scoped aliases, workspace links, missing peers and invalid packages', () => {
    const a = pkg('@scope/a');
    const b = pkg('b', '2');
    a.dependencies = { b };
    b.dependencies = { a };
    const graph = normalizeDependencyGraph({ dependencies: {
      alias: a, workspace: { ...pkg('local'), path: '/project/packages/local' },
      peer: { missing: true }, bad: { ...pkg('bad'), invalid: '^2', extraneous: true },
    }, problems: ['missing: peer'] }, {
      dependencies: { alias: 'npm:@scope/a@^1', workspace: 'file:packages/local' }, peerDependencies: { peer: '^3' },
    }, root, 'Installed');
    const index = new DependencyGraphIndex(graph);
    assert.strictEqual(index.visible(new Set(graph.nodes.map(node => node.id))).nodes.size, 6);
    assert.ok(graph.edges.some(edge => edge.name === 'alias' && edge.requested === 'npm:@scope/a@^1'));
    assert.ok(graph.nodes.some(node => node.id === '/project/packages/local'));
    assert.deepStrictEqual(graph.nodes.find(node => node.name === 'peer')?.status, ['missing']);
    assert.deepStrictEqual(graph.nodes.find(node => node.name === 'bad')?.status, ['invalid', 'extraneous']);
    assert.deepStrictEqual(graph.diagnostics, ['missing: peer']);
  });

  test('preserves dependency kinds and requested ranges, including optional overrides', () => {
    const graph = normalizeDependencyGraph({ dependencies: { a: {
      ...pkg('a', '1', { peer: pkg('peer'), optional: pkg('optional') }),
      _dependencies: { peer: '^3', optional: '^2' },
      peerDependencies: { peer: '^3' }, optionalDependencies: { optional: '^2' },
    } } }, { dependencies: { a: '^1' }, optionalDependencies: { a: '^1.2' } }, root, 'Installed');
    assert.deepStrictEqual(graph.edges.find(edge => edge.name === 'a')?.kinds, ['optional']);
    assert.deepStrictEqual(graph.edges.find(edge => edge.name === 'peer')?.kinds, ['peer']);
    assert.deepStrictEqual(graph.edges.find(edge => edge.name === 'optional')?.kinds, ['optional']);
    assert.strictEqual(graph.edges.find(edge => edge.name === 'peer')?.requested, '^3');
  });

  test('normalizes Windows identities without merging distinct POSIX paths', () => {
    assert.strictEqual(normalizedPackagePath('C:\\APP\\node_modules\\A', 'C:\\App'), 'c:/app/node_modules/a');
    assert.notStrictEqual(normalizedPackagePath('/app/A', '/app'), normalizedPackagePath('/app/a', '/app'));
  });

  test('finds required missing peers without flagging optional, ordinary missing, or invalid dependencies', () => {
    const graph = normalizeDependencyGraph({ dependencies: { plugin: {
      ...pkg('plugin', '1', { required: { missing: true }, optional: { missing: true },
        ordinary: { missing: true }, invalid: { ...pkg('invalid'), invalid: '^2' } }),
      peerDependencies: { required: '^1', optional: '^1', invalid: '^2' },
      peerDependenciesMeta: { optional: { optional: true } },
    } } }, { peerDependencies: { direct: '^1', optionalRoot: '^1' },
      peerDependenciesMeta: { optionalRoot: { optional: true } } }, root, 'Installed');
    const index = new DependencyGraphIndex(graph);
    assert.deepStrictEqual([...index.missingPeerIds()].map(id => index.nodes.get(id)!.name).sort(), ['direct', 'required']);
    const declarations = new DependencyGraphIndex(normalizeDependencyGraph({}, { peerDependencies: { direct: '^1' } }, root, 'Declared only'));
    assert.strictEqual(declarations.missingPeerIds().size, 0);
  });

  test('normalizes and searches a 5000-package graph without recursive traversal', () => {
    const tree: Record<string, unknown> = { name: 'app' };
    let parent = tree;
    for (let i = 0; i < 5000; i++) {
      const child = pkg(`package-${i}`);
      parent.dependencies = { [`package-${i}`]: child };
      parent = child;
    }
    const graph = normalizeDependencyGraph(tree, {}, root, 'Installed');
    const index = new DependencyGraphIndex(graph);
    assert.strictEqual(graph.nodes.length, 5001);
    assert.strictEqual(index.visible(new Set([graph.root])).nodes.size, 2);
    assert.strictEqual(index.shortestPath(`${root}/node_modules/package-4999`).length, 5001);
    assert.strictEqual(index.visible(new Set(graph.nodes.map(node => node.id))).nodes.size, 5001);
  });
});

suite('npm dependency graph collection', () => {
  let folder: string;
  setup(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'node-cli-plus-graph-'));
    await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'app', dependencies: { a: '^1' }, devDependencies: { dev: '~2' } }));
  });
  teardown(async () => {
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep + 'node-cli-plus-graph-'));
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const successful: NpmGraphRunner = async () => ({ stdout: JSON.stringify({ name: 'app', dependencies: { a: pkg('a') } }), stderr: '', exitCode: 0 });

  test('declared fallback does not run npm and includes all direct dependency types', async () => {
    const graph = await loadNpmDependencyGraph(folder, async () => { throw new Error('Must not call npm'); });
    assert.strictEqual(graph.source, 'Declared only');
    assert.strictEqual(graph.nodes.length, 3);
    assert.ok(graph.nodes.slice(1).every(node => !node.version && node.status.includes('unresolved')));
    assert.deepStrictEqual(graph.nodes.find(node => node.name === 'dev')?.kinds, ['development']);
  });

  test('installed tree wins over lockfile and uses offline flags for all dependency kinds', async () => {
    await fs.mkdir(path.join(folder, 'node_modules'));
    await fs.writeFile(path.join(folder, 'package-lock.json'), '{}');
    const graph = await loadNpmDependencyGraph(folder, async (args, cwd) => {
      assert.strictEqual(cwd, folder);
      assert.deepStrictEqual(args, ['ls', '--all', '--json', '--long', '--offline', '--include=dev', '--include=optional', '--include=peer']);
      return successful(args, cwd);
    });
    assert.strictEqual(graph.source, 'Installed');
    assert.ok(graph.nodes.find(node => node.name === 'dev')?.status.includes('missing'));
  });

  for (const lockfile of ['package-lock.json', 'npm-shrinkwrap.json']) {
    test(`uses ${lockfile} without node_modules`, async () => {
      await fs.writeFile(path.join(folder, lockfile), '{}');
      const graph = await loadNpmDependencyGraph(folder, async (args, cwd) => {
        assert.ok(args.includes('--package-lock-only'));
        return successful(args, cwd);
      });
      assert.strictEqual(graph.source, 'Lockfile');
    });
  }

  test('includes npm workspaces and preserves partial output from a failing npm process', async () => {
    await fs.mkdir(path.join(folder, 'node_modules'));
    await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'app', workspaces: ['packages/*'] }));
    const graph = await loadNpmDependencyGraph(folder, async args => {
      assert.ok(args.includes('--workspaces'));
      assert.ok(args.includes('--include-workspace-root'));
      return { stdout: JSON.stringify({ name: 'app', dependencies: { local: pkg('local') } }), stderr: 'npm error missing peer', exitCode: 1 };
    });
    assert.strictEqual(graph.source, 'Installed');
    assert.strictEqual(graph.nodes.length, 2);
    assert.ok(graph.diagnostics.some(message => message.includes('code 1')));
    assert.ok(graph.diagnostics.some(message => message.includes('missing peer')));
  });

  for (const [name, run] of Object.entries<NpmGraphRunner>({
    'missing npm': async () => { throw new Error('npm ENOENT'); },
    'invalid output': async () => ({ stdout: 'not json', stderr: 'npm failed', exitCode: 1 }),
    'error-only JSON': async () => ({ stdout: '{"error":{"code":"EJSONPARSE"}}', stderr: '', exitCode: 1 }),
    timeout: async () => ({ stdout: '{}', stderr: '', exitCode: 124, timedOut: true }),
  })) {
    test(`${name} falls back to unresolved declarations with a notice`, async () => {
      await fs.mkdir(path.join(folder, 'node_modules'));
      const graph = await loadNpmDependencyGraph(folder, run);
      assert.strictEqual(graph.source, 'Declared only');
      assert.strictEqual(graph.nodes.length, 3);
      assert.ok(graph.diagnostics[0].includes('unresolved'));
    });
  }

  test('rejects missing, malformed, and non-object manifests', async () => {
    for (const content of ['{', '[]', 'null']) {
      await fs.writeFile(path.join(folder, 'package.json'), content);
      await assert.rejects(loadNpmDependencyGraph(folder, successful), /Cannot read workspace package.json/);
    }
    await fs.unlink(path.join(folder, 'package.json'));
    await assert.rejects(loadNpmDependencyGraph(folder, successful), /Cannot read workspace package.json/);
  });

  test('empty manifest yields just the project node', async () => {
    await fs.writeFile(path.join(folder, 'package.json'), '{}');
    const graph = await loadNpmDependencyGraph(folder, successful);
    assert.strictEqual(graph.nodes.length, 1);
    assert.strictEqual(graph.edges.length, 0);
  });

  test('managed timeout settles even if process close is delayed', async function () {
    this.timeout(5000);
    const result = await spawnManaged('node', ['-e', 'setInterval(() => {}, 1000)'], { cwd: folder, shell: false, timeoutMs: 100 });
    assert.strictEqual(result.exitCode, 124);
    assert.strictEqual(result.timedOut, true);
  });
});

suite('npm dependency graph extension integration', () => {
  test('security scan uses the graph workspace, ignores duplicate requests, and acknowledges failures', async () => {
    const utils = require('../utils') as typeof import('../utils');
    const views = require('../webview-utils') as typeof import('../webview-utils');
    const security = require('../security-command') as typeof import('../security-command');
    const previous = { picker: utils.pickWorkspaceFolder, create: views.createAnalysisPanel, review: security.reviewPackageSecurityForRoot };
    const contextBefore = getExtensionContext();
    const messages: unknown[] = [], roots: string[] = [];
    let handler!: (message: { command?: string; root?: string }) => void | Promise<void>;
    let dispose!: () => void;
    let finish!: () => void;
    const selectedRoot = path.join(os.tmpdir(), 'node-cli-plus-graph-security');
    try {
      setExtensionContext({ extensionUri: vscode.extensions.getExtension('danisss9.node-cli-plus')!.extensionUri, subscriptions: [] } as unknown as vscode.ExtensionContext);
      utils.pickWorkspaceFolder = async () => selectedRoot;
      views.createAnalysisPanel = (() => ({
        panel: { onDidDispose: (callback: () => void) => { dispose = callback; }, webview: {
          postMessage: async (message: unknown) => { messages.push(message); return true; },
          asWebviewUri: (uri: vscode.Uri) => uri, cspSource: 'test',
        } },
        isDisposed: () => false, setHtml: () => {}, setTitle: () => {},
        onMessage: (callback: typeof handler) => { handler = callback; },
      })) as unknown as typeof views.createAnalysisPanel;
      security.reviewPackageSecurityForRoot = async selected => { roots.push(selected); await new Promise<void>(resolve => { finish = resolve; }); };
      await showNpmDependencyGraph();
      const pending = handler({ command: 'securityScan', root: '/untrusted-message-path' });
      await handler({ command: 'securityScan' });
      assert.deepStrictEqual(roots, [selectedRoot]);
      finish(); await pending;
      assert.deepStrictEqual(messages, [{ type: 'securityScanFinished' }]);
      security.reviewPackageSecurityForRoot = async () => { throw new Error('scan failed'); };
      await assert.rejects(async () => handler({ command: 'securityScan' }), /scan failed/);
      assert.strictEqual(messages.length, 2);
    } finally {
      dispose?.(); utils.pickWorkspaceFolder = previous.picker;
      views.createAnalysisPanel = previous.create; security.reviewPackageSecurityForRoot = previous.review;
      setExtensionContext(contextBefore);
    }
  });

  test('loads real webviews, reuses panels per folder, and recreates closed panels', async function () {
    this.timeout(15000);
    const extension = vscode.extensions.getExtension('danisss9.node-cli-plus')!;
    const contextBefore = getExtensionContext();
    const subscriptions: vscode.Disposable[] = [];
    setExtensionContext({ extensionUri: extension.extensionUri, subscriptions } as vscode.ExtensionContext);
    // Substitute only folder selection; use the real panel, webview assets and loader.
    const utils = require('../utils') as { pickWorkspaceFolder: () => Promise<string | null> };
    const pickerBefore = utils.pickWorkspaceFolder;
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'node-cli-plus-graph-panels-'));
    const one = path.join(folder, 'one');
    const two = path.join(folder, 'two');
    try {
      for (const target of [one, two]) {
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, 'package.json'), JSON.stringify({ name: path.basename(target), dependencies: { example: '^1' } }));
      }
      utils.pickWorkspaceFolder = async () => one;
      await showNpmDependencyGraph();
      assert.strictEqual(subscriptions.length, 1);
      const first = subscriptions[0] as vscode.WebviewPanel;
      const deadline = Date.now() + 10000;
      while (first.title !== 'npm Graph: one' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.strictEqual(first.title, 'npm Graph: one', 'Bundled webview should send ready and load the selected package.json');
      await showNpmDependencyGraph();
      assert.strictEqual(subscriptions.length, 1);
      utils.pickWorkspaceFolder = async () => two;
      await showNpmDependencyGraph();
      assert.strictEqual(subscriptions.length, 2);
      first.dispose();
      utils.pickWorkspaceFolder = async () => one;
      await showNpmDependencyGraph();
      assert.strictEqual(subscriptions.length, 3);
      utils.pickWorkspaceFolder = async () => null;
      await showNpmDependencyGraph();
      assert.strictEqual(subscriptions.length, 3);
    } finally {
      utils.pickWorkspaceFolder = pickerBefore;
      for (const subscription of subscriptions) { subscription.dispose(); }
      setExtensionContext(contextBefore);
      assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep + 'node-cli-plus-graph-panels-'));
      await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('command activates and has a unique shortcut with a macOS override', async () => {
    const extension = vscode.extensions.getExtension('danisss9.node-cli-plus');
    assert.ok(extension);
    await extension.activate();
    assert.ok((await vscode.commands.getCommands(true)).includes('node-cli-plus.showNpmDependencyGraph'));
    const bindings = extension.packageJSON.contributes.keybindings as { command: string; key: string; mac?: string }[];
    const binding = bindings.find(item => item.command === 'node-cli-plus.showNpmDependencyGraph');
    assert.strictEqual(binding?.key, 'ctrl+shift+n f');
    assert.strictEqual(binding?.mac, 'cmd+shift+n f');
    assert.strictEqual(bindings.filter(item => item.key === binding?.key).length, 1);
  });

  test('webview uses a nonce and only packaged script and stylesheet URLs', () => {
    const html = buildNpmGraphHtml('https://local/script.js?x="', 'https://local/style.css', 'https://local', 'test-nonce');
    assert.ok(html.includes("script-src 'nonce-test-nonce'"));
    assert.ok(!html.includes("script-src 'unsafe-inline'"));
    assert.ok(html.includes('script.js?x=&quot;'));
    assert.ok(html.includes('id="search"'));
  });
});
