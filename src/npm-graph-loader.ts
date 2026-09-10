import * as fs from 'fs/promises';
import * as path from 'path';
import { asObject, normalizeDependencyGraph, type DependencyGraph, type GraphSource } from './npm-graph';

export interface NpmGraphRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}
export type NpmGraphRunner = (args: string[], cwd: string) => Promise<NpmGraphRunResult>;

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

/** Reads local project data only. The process runner is injected to test failures without invoking npm. */
export async function loadNpmDependencyGraph(workspaceRoot: string, run: NpmGraphRunner): Promise<DependencyGraph> {
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'package.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error('Expected a JSON object'); }
    manifest = asObject(parsed);
  } catch (error) {
    throw new Error(`Cannot read workspace package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [installed, lock, shrinkwrap] = await Promise.all([
    exists(path.join(workspaceRoot, 'node_modules')),
    exists(path.join(workspaceRoot, 'package-lock.json')),
    exists(path.join(workspaceRoot, 'npm-shrinkwrap.json')),
  ]);
  const source: GraphSource = installed ? 'Installed' : lock || shrinkwrap ? 'Lockfile' : 'Declared only';
  if (source === 'Declared only') {
    return normalizeDependencyGraph({}, manifest, workspaceRoot, source, [
      'No node_modules or npm lockfile found. Only direct declarations are available; versions are unresolved.',
    ]);
  }
  const args = ['ls', '--all', '--json', '--long', '--offline', '--include=dev', '--include=optional', '--include=peer'];
  if (source === 'Lockfile') { args.push('--package-lock-only'); }
  // Include the root and all linked npm workspaces, independent of local npm defaults.
  if (manifest.workspaces) { args.push('--workspaces', '--include-workspace-root'); }
  let failure: string;
  try {
    const result = await run(args, workspaceRoot);
    if (result.timedOut) {
      failure = 'npm dependency inspection timed out after 30 seconds.';
    } else {
      let tree: Record<string, unknown> = {};
      try { tree = asObject(JSON.parse(result.stdout)); } catch { /* Fall back below. */ }
      if (typeof tree.name === 'string' || typeof tree.path === 'string' || tree.dependencies && typeof tree.dependencies === 'object') {
        const diagnostics: string[] = [];
        if (result.exitCode !== 0) {
          diagnostics.push(`npm exited with code ${result.exitCode}; showing the available dependency tree.`);
        }
        if (result.stderr.trim()) { diagnostics.push(result.stderr.trim().slice(0, 2000)); }
        return normalizeDependencyGraph(tree, manifest, workspaceRoot, source, diagnostics);
      }
      failure = result.stderr.trim().slice(0, 2000) || 'npm returned no usable dependency tree.';
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  return normalizeDependencyGraph({}, manifest, workspaceRoot, 'Declared only', [
    `${failure} Showing direct package.json declarations with unresolved versions.`,
  ]);
}
