import * as fs from 'fs/promises';
import * as path from 'path';
import * as ts from 'typescript';
import { builtinModules } from 'module';
import { setImmediate as yieldEventLoop } from 'timers/promises';
import { asObject, normalizedPackagePath } from './npm-graph';
import { type PackageInventory, resolveInstalledPackage } from './security-inventory';
import { checkCancelled, contained, errorMessage, readBounded, relativeFile, safeRealpath } from './security-files';
import { SECURITY_LIMITS, type Evidence, type InstalledPackage, type ScanCoverage, type ScanInput } from './security-types';

const HOOKS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
type Task = { kind: 'file' | 'command'; value: string; pkg: InstalledPackage; evidence: Evidence; depth: number; base: string };
export interface ScriptDiscovery { inputs: ScanInput[]; coverage: ScanCoverage; bytes: number }

/** Tokenizes literals and shell separators only; it never expands or evaluates shell expressions. */
export function tokenizeCommand(command: string): string[][] {
  const segments: string[][] = [[]]; let token = '', quote = '', started = false;
  const flush = () => { if (started) { segments[segments.length - 1].push(token); } token = ''; started = false; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) { quote = ''; }
      else if (char === '\\' && quote === '"' && ['"', '\\'].includes(command[i + 1])) { token += command[++i]; }
      else { token += char; }
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { flush(); if (char === '\n') { segments.push([]); } }
    else if (';&|<>'.includes(char)) { flush(); segments.push([]); }
    else { token += char; started = true; }
  }
  if (quote) { throw new Error('Unterminated command quote'); }
  flush(); return segments.filter(segment => segment.length);
}

export async function discoverInstallInputs(inventory: PackageInventory, signal?: AbortSignal,
  limits: { fileBytes: number; totalBytes: number; files: number; depth: number; decodedBytes: number } = SECURITY_LIMITS): Promise<ScriptDiscovery> {
  const { root, packages } = inventory;
  const coverage: ScanCoverage = { component: 'scripts', state: 'complete', checked: 0, messages: [] };
  const inputs = new Map<string, ScanInput>(); const tasks: Task[] = []; const expanded = new Set<string>();
  const locations = new Map<string, InstalledPackage>();
  let bytes = 0;
  const issue = (message: string) => { coverage.state = 'partial'; if (coverage.messages.length < 1000) { coverage.messages.push(message); } };
  for (const pkg of packages) { for (const location of pkg.locations) { locations.set(normalizedPackagePath(path.resolve(root, location), root), pkg); } }
  const owners = [...packages].sort((a, b) => b.directory.length - a.directory.length);
  function executableMapping(command: string, base: string): string | undefined {
    for (const candidate of packages) {
      const bins = asObject(candidate.manifest.bin);
      const value = typeof candidate.manifest.bin === 'string' && candidate.name.split('/').pop() === command
        ? candidate.manifest.bin : bins[command];
      if (typeof value === 'string' && resolveInstalledPackage(base, candidate.name, root, locations)?.id === candidate.id) {
        return path.resolve(candidate.directory, value);
      }
    }
    return;
  }
  const add = (key: string, data: Buffer, pkg: InstalledPackage, evidence: Evidence, kind: ScanInput['kind']) => {
    const existing = inputs.get(key);
    if (existing) {
      if (existing.evidence.length < 32 && !existing.evidence.some(item => item.lifecycle === evidence.lifecycle && item.chain.join() === evidence.chain.join())) { existing.evidence.push(evidence); }
      return true;
    }
    if (data.length > limits.fileBytes || bytes + data.length > limits.totalBytes || inputs.size >= limits.files) {
      issue(`${evidence.file}: scan input size/count limit reached`); return false;
    }
    inputs.set(key, { key, bytes: data, packageId: pkg.id, evidence: [evidence], kind }); bytes += data.length;
    return true;
  };
  for (const pkg of packages) {
    const scripts = asObject(pkg.manifest.scripts);
    const hookPositions = new Map<string, { line: number; column: number }>();
    if (HOOKS.some(hook => typeof scripts[hook] === 'string')) {
      try {
        const raw = (await readBounded(await safeRealpath(root, path.join(pkg.directory, 'package.json')), limits.fileBytes)).toString();
        const json = ts.parseJsonText('package.json', raw);
        const locate = (node: ts.Node) => {
          if (ts.isPropertyAssignment(node) && node.name.getText(json).replace(/["']/g, '') === 'scripts' && ts.isObjectLiteralExpression(node.initializer)) {
            for (const property of node.initializer.properties) {
              if (ts.isPropertyAssignment(property)) {
                const position = json.getLineAndCharacterOfPosition(property.initializer.getStart(json));
                hookPositions.set(property.name.getText(json).replace(/["']/g, ''), { line: position.line + 1, column: position.character + 1 });
              }
            }
          }
          ts.forEachChild(node, locate);
        };
        locate(json);
      } catch (error) { checkCancelled(signal); issue(`${pkg.id}/package.json: ${errorMessage(error)}`); }
    }
    for (const hook of HOOKS) {
      if (typeof scripts[hook] !== 'string') { continue; }
      const command = scripts[hook] as string;
      const evidence: Evidence = { file: relativeFile(root, path.join(pkg.directory, 'package.json')), line: 1, column: 1,
        ...hookPositions.get(hook),
        snippet: command.slice(0, 500), lifecycle: `${pkg.name}:${hook}`, chain: [`${pkg.id}/package.json → ${hook}`] };
      tasks.push({ kind: 'command', value: command, pkg, evidence, depth: 0, base: pkg.directory });
      coverage.checked++;
    }
    if (!scripts.install && !scripts.preinstall) {
      try {
        const binding = await safeRealpath(root, path.join(pkg.directory, 'binding.gyp'));
        const evidence: Evidence = { file: relativeFile(root, binding), line: 1, column: 1, snippet: 'node-gyp rebuild (implicit install)',
          lifecycle: `${pkg.name}:install (implicit)`, chain: [`${pkg.id}/binding.gyp → implicit node-gyp rebuild`] };
        tasks.push({ kind: 'file', value: binding, pkg, evidence, depth: 0, base: pkg.directory });
        add(`implicit:${pkg.id}`, Buffer.from('node-gyp rebuild'), pkg, evidence, 'command');
        issue(`${evidence.file}: implicit native build; compiler actions and generated binaries are not statically resolved`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { issue(`${pkg.id}: ${errorMessage(error)}`); } }
    }
  }
  async function resolveFile(value: string, base: string, attempts = new Set<string>()): Promise<string> {
    const absolute = path.resolve(base, value);
    if (!contained(root, absolute)) { throw new Error('Referenced path leaves the workspace'); }
    if (attempts.has(absolute)) { throw new Error('Cyclic package entry point'); } attempts.add(absolute);
    for (const candidate of [absolute, ...['.js', '.cjs', '.mjs', '.ts', '.json'].map(extension => absolute + extension)]) {
      try { const real = await safeRealpath(root, candidate); if ((await fs.stat(real)).isFile()) { return real; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    }
    try {
      const manifest = asObject(JSON.parse((await readBounded(await safeRealpath(root, path.join(absolute, 'package.json')), limits.fileBytes)).toString()));
      if (typeof manifest.main === 'string') { return resolveFile(manifest.main, absolute, attempts); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    for (const entry of ['index.js', 'index.cjs', 'index.mjs', 'index.ts', 'index.json']) {
      try { const real = await safeRealpath(root, path.join(absolute, entry)); if ((await fs.stat(real)).isFile()) { return real; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    }
    throw new Error(`Unresolved file reference: ${value.slice(0, 160)}`);
  }
  function enqueue(task: Task, kind: Task['kind'], value: string, base = task.base, file?: string) {
    if (tasks.length >= limits.files * 4) { issue('Script reference count limit reached'); return; }
    tasks.push({ ...task, kind, value, base, depth: task.depth + 1,
      evidence: { ...task.evidence, ...(file ? { file } : {}), chain: [...task.evidence.chain, value.slice(0, 200)] } });
  }
  async function moduleFile(specifier: string, task: Task): Promise<string | undefined> {
    if (BUILTINS.has(specifier)) { return; }
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) { return resolveFile(specifier, task.base); }
    const pieces = specifier.split('/'); const name = pieces.splice(0, specifier.startsWith('@') ? 2 : 1).join('/');
    const pkg = resolveInstalledPackage(task.base, name, root, locations);
    if (!pkg) { throw new Error(`Unresolved installed module: ${specifier}`); }
    if (pkg.manifest.exports) { issue(`${task.evidence.file}: package exports conditions for ${name} are approximated using the installed entry point`); }
    return resolveFile(pieces.length ? pieces.join('/') : '.', pkg.directory);
  }
  function literals(text: string, task: Task, source: ts.SourceFile) {
    const walk = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) && node.text.length >= 256) {
        const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
        const evidence = { ...task.evidence, line: pos.line + 1, column: pos.character + 1, snippet: node.text.slice(0, 160), derived: 'extracted string literal' };
        let data = node.text;
        add(`literal:${task.value}:${node.pos}`, Buffer.from(`ACP_LITERAL\n${data}`), task.pkg, evidence, 'literal');
        for (let layer = 1; layer <= 2; layer++) {
          const compact = data.replace(/\s/g, '');
          const encoding = /^[a-f\d]+$/i.test(compact) && compact.length % 2 === 0 ? 'hex'
            : /^[A-Za-z\d+/]+={0,2}$/.test(compact) && compact.length % 4 === 0 ? 'base64' : undefined;
          if (!encoding) { break; }
          if (compact.length > limits.decodedBytes * (encoding === 'hex' ? 2 : 4 / 3) + 4) { issue(`${evidence.file}: decoded payload size limit reached`); break; }
          const decoded = Buffer.from(compact, encoding);
          if (decoded.length > limits.decodedBytes) { issue(`${evidence.file}: decoded payload size limit reached`); break; }
          add(`decoded:${task.value}:${node.pos}:${layer}`, Buffer.concat([Buffer.from('ACP_DECODED\n'), decoded]), task.pkg,
            { ...evidence, derived: `${encoding} decoding, layer ${layer}; location refers to original literal` }, 'decoded');
          data = decoded.toString();
          if (layer === 2 && /^(?:[a-f\d]{256,}|[A-Za-z\d+/]{256,}={0,2})$/i.test(data.trim())) { issue(`${evidence.file}: decoded payload depth limit reached`); }
        }
      }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteralLike(specifier)) { enqueue(task, 'file', `module:${specifier.text}`); }
      }
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(source);
        const argument = node.arguments[0];
        if (['require', 'require.resolve', 'import'].includes(name)) {
          if (argument && ts.isStringLiteralLike(argument)) { enqueue(task, 'file', `module:${argument.text}`); }
          else { issue(`${task.evidence.file}: dynamic module reference cannot be resolved`); }
        }
        if (/(?:^|\.)(?:readFileSync|readFile|createReadStream)$/.test(name)) {
          if (argument && ts.isStringLiteralLike(argument) && !BUILTINS.has(argument.text)) { enqueue(task, 'file', argument.text); }
          else { issue(`${task.evidence.file}: dynamic file/payload reference cannot be resolved`); }
        }
        if (/(?:^|\.)(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)$/.test(name)) {
          if (argument && ts.isStringLiteralLike(argument)) {
            const next = node.arguments[1];
            if (next && ts.isArrayLiteralExpression(next) && next.elements.every(ts.isStringLiteralLike)) {
              enqueue(task, 'command', [argument.text, ...next.elements.map(element => (element as ts.StringLiteralLike).text)].map(value => JSON.stringify(value)).join(' '));
            } else if (/exec(?:Sync)?$/.test(name)) { enqueue(task, 'command', argument.text); }
            else { issue(`${task.evidence.file}: process arguments cannot be statically resolved`); }
          } else { issue(`${task.evidence.file}: dynamic process command cannot be resolved`); }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  for (let cursor = 0; cursor < tasks.length; cursor++) {
    checkCancelled(signal); await yieldEventLoop();
    const task = tasks[cursor];
    if (task.depth > limits.depth) { issue(`${task.evidence.file}: script reference depth limit reached`); continue; }
    const expansionKey = `${task.evidence.lifecycle}:${task.base}:${task.kind}:${task.value}`;
    if (expanded.has(expansionKey)) { continue; } expanded.add(expansionKey);
    try {
      if (task.kind === 'command') {
        if (!add(`command:${task.pkg.id}:${task.value}`, Buffer.from(task.value), task.pkg, task.evidence, 'command')) { continue; }
        if (/\$\(|`|%[A-Za-z_][\w]*%|\$\{/.test(task.value)) { issue(`${task.evidence.file}: dynamic shell expression is not evaluated`); }
        for (let tokens of tokenizeCommand(task.value)) {
          tokens = [...tokens];
          if (['cross-env', 'cross-env-shell', 'env'].includes(tokens[0])) {
            const wrapper = tokens.shift()!;
            if (wrapper !== 'env') {
              const wrapperFile = executableMapping(wrapper, task.base);
              if (wrapperFile) { enqueue(task, 'file', wrapperFile); }
              else { issue(`${task.evidence.file}: installed ${wrapper} wrapper cannot be resolved`); }
            }
          }
          while (/^[\w]+=.*/.test(tokens[0] ?? '')) { tokens.shift(); }
          if (!tokens.length) { continue; }
          const executable = path.basename(tokens[0]).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
          if (['npm', 'pnpm', 'yarn'].includes(executable)) {
            const runAt = tokens.indexOf('run') >= 0 ? tokens.indexOf('run') : tokens.indexOf('run-script');
            const scriptName = runAt >= 0 ? tokens[runAt + 1] : executable === 'yarn' ? tokens[1] : undefined;
            const script = scriptName ? asObject(task.pkg.manifest.scripts)[scriptName] : undefined;
            if (typeof script === 'string') {
              for (const hook of [`pre${scriptName}`, scriptName!, `post${scriptName}`]) {
                const command = asObject(task.pkg.manifest.scripts)[hook]; if (typeof command === 'string') { enqueue(task, 'command', command); }
              }
            } else { issue(`${task.evidence.file}: package-manager command cannot be resolved: ${tokens.slice(0, 3).join(' ')}`); }
            continue;
          }
          if (['node', 'nodejs', 'tsx', 'ts-node', 'bash', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd', 'python', 'python3'].includes(executable)) {
            const inline = tokens.findIndex(value => ['-e', '--eval', '-c', '-command', '/c'].includes(value.toLowerCase()));
            if (inline >= 0 && tokens[inline + 1]) {
              const value = tokens[inline + 1];
              if (['node', 'nodejs', 'tsx', 'ts-node'].includes(executable)) {
                const source = ts.createSourceFile('inline.js', value, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
                const inlineTask = { ...task, value: `inline:${task.value}` };
                add(inlineTask.value, Buffer.from(value), task.pkg, { ...task.evidence, derived: 'inline JavaScript' }, 'command');
                literals(value, inlineTask, source);
              } else if (['bash', 'sh', 'zsh', 'cmd'].includes(executable)) { enqueue(task, 'command', value); }
              else { issue(`${task.evidence.file}: inline ${executable} is scanned as text; its references are not resolved`); }
            } else {
              const files = tokens.slice(1).filter(value => !value.startsWith('-') && !value.startsWith('/') || /\.(?:js|cjs|mjs|ts|sh|ps1|py|cmd|bat)$/i.test(value));
              if (files.length) { enqueue(task, 'file', files[0], task.base); }
              else { issue(`${task.evidence.file}: interpreter command has no resolvable script`); }
            }
            continue;
          }
          if (['echo', 'printf', 'exit', 'true', 'false', 'test', 'mkdir', 'rm', 'cp', 'mv', 'chmod', 'touch'].includes(executable)) { continue; }
          if (executable === 'cd') { issue(`${task.evidence.file}: shell directory changes are not followed`); continue; }
          const bin = executableMapping(tokens[0], task.base);
          if (bin || /[/\\]|\.(?:js|sh|ps1|py|cmd|bat)$/i.test(tokens[0])) { enqueue(task, 'file', bin ?? tokens[0]); }
          else { issue(`${task.evidence.file}: external command ${tokens[0].slice(0, 100)} is not inspected`); }
        }
      } else {
        const file = task.value.startsWith('module:') ? await moduleFile(task.value.slice(7), task) : await resolveFile(task.value, task.base);
        if (!file) { continue; }
        const owner = owners.find(pkg => contained(pkg.directory, file)) ?? task.pkg;
        const evidence = { ...task.evidence, file: relativeFile(root, file), line: 1, column: 1 };
        const fileTask = { ...task, value: file, base: path.dirname(file), pkg: owner, evidence };
        const data = await readBounded(file, limits.fileBytes);
        evidence.snippet = data.toString('utf8', 0, 300);
        if (!add(`file:${file}`, data, owner, evidence, 'source')) { continue; }
        const text = data.toString();
        if (/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/.test(file) || /^#!.*\bnode\b/.test(text)) {
          const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
          if ((source as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) { issue(`${evidence.file}: source contains parser errors; references may be incomplete`); }
          literals(text, fileTask, source);
        } else if (/\.(?:sh|bash|cmd|bat)$/.test(file)) { enqueue(fileTask, 'command', text); }
        else if (/\.(?:ps1|py|gyp|exe|dll|node|wasm)$/.test(file)) { issue(`${evidence.file}: scanned as bytes; language/native references are not resolved`); }
      }
    } catch (error) { checkCancelled(signal); issue(`${task.evidence.file}: ${errorMessage(error)}`); }
    if (inputs.size >= limits.files || bytes >= limits.totalBytes) { issue('Remaining script inputs skipped after reaching scan limits'); break; }
  }
  coverage.messages = [...new Set(coverage.messages)];
  return { inputs: [...inputs.values()], coverage, bytes };
}
