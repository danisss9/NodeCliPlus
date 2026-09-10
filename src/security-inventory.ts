import * as fs from 'fs/promises';
import * as path from 'path';
import { asObject, normalizedPackagePath, type DependencyKind } from './npm-graph';
import { checkCancelled, contained, errorMessage, readBounded, relativeFile, safeRealpath } from './security-files';
import { SECURITY_LIMITS, type InstalledPackage, type ScanCoverage } from './security-types';

export interface PackageInventory { root: string; packages: InstalledPackage[]; coverage: ScanCoverage }
export async function collectPackages(workspaceRoot: string, signal?: AbortSignal,
  limits: { packages: number; depth: number } = SECURITY_LIMITS): Promise<PackageInventory> {
  const root = await fs.realpath(workspaceRoot);
  const coverage: ScanCoverage = { component: 'inventory', state: 'complete', checked: 0, messages: [] };
  const packages = new Map<string, InstalledPackage>();
  const moduleDirs = new Set<string>();
  const issue = (message: string) => { coverage.state = 'partial'; if (coverage.messages.length < 1000) { coverage.messages.push(message); } };
  let visitedDirectories = 0;
  async function entries(directory: string) {
    checkCancelled(signal);
    if (++visitedDirectories > limits.packages * 4) { throw new Error('Package directory traversal limit reached'); }
    return fs.readdir(directory, { withFileTypes: true });
  }
  async function add(directory: string, workspace = false): Promise<void> {
    checkCancelled(signal);
    if (packages.size >= limits.packages) { issue('Installed package count limit reached'); return; }
    try {
      const real = await safeRealpath(root, directory);
      const key = normalizedPackagePath(real, root);
      const location = relativeFile(root, directory);
      const existing = packages.get(key);
      if (existing) {
        if (!existing.locations.includes(location)) { existing.locations.push(location); }
        existing.workspace ||= workspace;
        return;
      }
      const manifestPath = await safeRealpath(root, path.join(real, 'package.json'));
      const parsed: unknown = JSON.parse((await readBounded(manifestPath, SECURITY_LIMITS.fileBytes)).toString());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error('Expected package manifest object'); }
      const manifest = asObject(parsed);
      const name = typeof manifest.name === 'string' ? manifest.name : path.basename(real);
      const version = typeof manifest.version === 'string' ? manifest.version : 'unknown';
      if (version === 'unknown' && !workspace) { issue(`${location}: installed version is missing`); }
      packages.set(key, { id: relativeFile(root, real), directory: real, name, version, manifest,
        locations: [location], kinds: [], dependencyPath: [], workspace });
      await modules(path.join(real, 'node_modules'));
    } catch (error) { checkCancelled(signal); issue(`${relativeFile(root, directory)}: ${errorMessage(error)}`); }
  }
  async function modules(directory: string): Promise<void> {
    checkCancelled(signal);
    try {
      const real = await safeRealpath(root, directory);
      if (moduleDirs.has(real)) { return; }
      moduleDirs.add(real);
      for (const entry of await entries(real)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) { continue; }
        const target = path.join(real, entry.name);
        if (entry.name === '.pnpm') {
          for (const store of await entries(await safeRealpath(root, target))) {
            if (store.isDirectory()) { await modules(store.name === 'node_modules' ? path.join(target, store.name) : path.join(target, store.name, 'node_modules')); }
          }
        } else if (entry.name.startsWith('@')) {
          for (const scoped of await entries(await safeRealpath(root, target))) {
            if (scoped.isDirectory() || scoped.isSymbolicLink()) { await add(path.join(target, scoped.name)); }
          }
        } else if (!entry.name.startsWith('.')) { await add(target); }
      }
    } catch (error) {
      checkCancelled(signal);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { issue(`${relativeFile(root, directory)}: ${errorMessage(error)}`); }
    }
  }
  await add(root, true);
  const rootPackage = packages.get(normalizedPackagePath(root, root));
  if (!rootPackage) { throw new Error('Cannot read workspace package.json'); }
  const workspaces = rootPackage.manifest.workspaces;
  const patterns = (Array.isArray(workspaces) ? workspaces : asObject(workspaces).packages);
  if (Array.isArray(patterns)) {
    const globs = patterns.filter((value): value is string => typeof value === 'string').map(pattern => {
      const escaped = pattern.replace(/\\/g, '/').replace(/\/$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
    });
    const seen = new Set<string>();
    async function walk(directory: string, depth: number): Promise<void> {
      if (depth > limits.depth) { issue('Workspace discovery depth limit reached'); return; }
      const real = await safeRealpath(root, directory);
      if (seen.has(real)) { return; } seen.add(real);
      for (const entry of await entries(real)) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) { continue; }
        const next = path.join(real, entry.name);
        if (globs.some(glob => glob.test(relativeFile(root, next)))) { await add(next, true); }
        await walk(next, depth + 1);
      }
    }
    try { await walk(root, 0); } catch (error) { checkCancelled(signal); issue(errorMessage(error)); }
  }
  const result = [...packages.values()];
  const byLocation = new Map<string, InstalledPackage>();
  for (const pkg of result) {
    for (const location of pkg.locations) { byLocation.set(normalizedPackagePath(path.resolve(root, location), root), pkg); }
  }
  rootPackage.dependencyPath = [rootPackage.name];
  const queue = [rootPackage, ...result.filter(pkg => pkg.workspace && pkg !== rootPackage)];
  for (const pkg of queue) { if (!pkg.dependencyPath.length) { pkg.dependencyPath = [rootPackage.name, `${pkg.name} (workspace)`]; } }
  const expanded = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const pkg = queue[i];
    if (expanded.has(pkg.id)) { continue; } expanded.add(pkg.id);
    for (const [field, kind] of [['dependencies', 'production'], ['devDependencies', 'development'], ['optionalDependencies', 'optional'], ['peerDependencies', 'peer']] as const) {
      for (const name of Object.keys(asObject(pkg.manifest[field]))) {
        const target = resolveInstalledPackage(pkg.directory, name, root, byLocation);
        if (!target) { continue; }
        const inherited: DependencyKind[] = pkg.workspace || !pkg.kinds.length ? [kind] : pkg.kinds;
        target.kinds = [...new Set([...target.kinds, ...inherited])];
        if (!target.dependencyPath.length) { target.dependencyPath = [...pkg.dependencyPath, `${target.name}@${target.version}`]; }
        queue.push(target);
      }
    }
  }
  for (const pkg of result) {
    if (!pkg.dependencyPath.length) { pkg.dependencyPath = [rootPackage.name, `${pkg.name}@${pkg.version} (unlinked/extraneous installation)`]; }
  }
  try { await fs.access(path.join(root, 'node_modules')); }
  catch { issue('No node_modules directory. Installed package and lifecycle coverage is incomplete; Yarn PnP is not supported.'); }
  coverage.checked = result.length;
  return { root, packages: result, coverage };
}

export function resolveInstalledPackage(from: string, name: string, root: string, locations: Map<string, InstalledPackage>): InstalledPackage | undefined {
  if (!/^(?:@[^/\\.][^/\\]*\/)?[^/\\.][^/\\]*$/.test(name)) { return; }
  for (let directory = from; contained(root, directory); directory = path.dirname(directory)) {
    const candidate = locations.get(normalizedPackagePath(path.join(directory, 'node_modules', name), root));
    if (candidate) { return candidate; }
    if (directory === path.dirname(directory)) { break; }
  }
  return;
}
