import * as path from 'path';

export type DependencyKind = 'production' | 'development' | 'optional' | 'peer';
export type GraphSource = 'Installed' | 'Lockfile' | 'Declared only';
export interface DependencyNode {
  id: string;
  name: string;
  version?: string;
  path?: string;
  kinds: DependencyKind[];
  status: string[];
}
export interface DependencyEdge {
  id: string;
  source: string;
  target: string;
  name: string;
  requested?: string;
  kinds: DependencyKind[];
  optionalPeer?: boolean;
}
export interface DependencyGraph {
  source: GraphSource;
  root: string;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  diagnostics: string[];
}

type JsonObject = Record<string, unknown>;
export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : {};
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
export function normalizedPackagePath(value: string, root: string): string {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(root);
  const resolved = (windows ? path.win32 : path.posix).resolve(root, value).replace(/\\/g, '/');
  return windows ? resolved.toLowerCase() : resolved;
}

function declarations(pkg: JsonObject): Map<string, { requested: string; kinds: DependencyKind[] }> {
  const result = new Map<string, { requested: string; kinds: DependencyKind[] }>();
  for (const [field, kind] of [
    ['dependencies', 'production'], ['devDependencies', 'development'],
    ['peerDependencies', 'peer'], ['optionalDependencies', 'optional'],
  ] as const) {
    for (const [name, requested] of Object.entries(asObject(pkg[field]))) {
      if (typeof requested !== 'string') { continue; }
      const existing = result.get(name);
      const kinds = existing?.kinds ?? [];
      // npm optionalDependencies override a matching dependencies entry.
      if (kind === 'optional' && kinds.includes('production')) {
        kinds.splice(kinds.indexOf('production'), 1);
      }
      kinds.push(kind);
      result.set(name, { requested, kinds });
    }
  }
  return result;
}

/** Normalize npm's logical tree, retaining the identity of physical package copies. */
export function normalizeDependencyGraph(
  tree: JsonObject, manifest: JsonObject, workspaceRoot: string, source: GraphSource,
  diagnostics: string[] = [],
): DependencyGraph {
  const root = normalizedPackagePath(workspaceRoot, workspaceRoot);
  const nodes = new Map<string, DependencyNode>();
  const edges = new Map<string, DependencyEdge>();
  const messages = new Set(diagnostics);
  const rootNode: DependencyNode = {
    id: root, name: str(manifest.name) ?? path.basename(workspaceRoot),
    version: str(manifest.version), path: workspaceRoot, kinds: [], status: [],
  };
  nodes.set(root, rootNode);
  const queue: { raw: JsonObject; id: string; isRoot?: boolean }[] = [{ raw: tree, id: root, isRoot: true }];
  const visited = new WeakSet<object>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { raw, id, isRoot } = queue[cursor];
    if (visited.has(raw)) { continue; }
    visited.add(raw);
    if (Array.isArray(raw.problems)) {
      for (const problem of raw.problems) {
        if (typeof problem === 'string') { messages.add(problem); }
      }
    }
    const packageInfo = isRoot ? manifest : raw;
    const declared = declarations(packageInfo);
    const peerMeta = asObject(packageInfo.peerDependenciesMeta);
    if (!isRoot) {
      for (const [name, requested] of Object.entries(asObject(raw._dependencies))) {
        if (typeof requested === 'string' && !declared.has(name)) {
          declared.set(name, { requested, kinds: ['production'] });
        }
      }
    }
    const children = new Map(Object.entries(asObject(raw.dependencies)));
    // Missing direct declarations must still be visible, even with incomplete npm output.
    if (isRoot) {
      for (const name of declared.keys()) {
        if (!children.has(name)) {
          children.set(name, source === 'Declared only' || asObject(peerMeta[name]).optional === true ? {} : { missing: true });
        }
      }
    }
    for (const [name, value] of children) {
      const child = asObject(value);
      const childPath = str(child.path);
      const childId = childPath ? normalizedPackagePath(childPath, workspaceRoot)
        : `${id}/node_modules/${name}`;
      const declaration = declared.get(name);
      const kinds: DependencyKind[] = declaration?.kinds ?? (
        child.peer ? ['peer'] : child.optional ? ['optional'] : child.dev ? ['development'] : ['production']
      );
      const statuses = ['missing', 'invalid', 'extraneous'].filter(key => Boolean(child[key]));
      if (source === 'Declared only' || (!str(child.version) && !statuses.length)) { statuses.push('unresolved'); }
      let node = nodes.get(childId);
      if (!node) {
        node = { id: childId, name: str(child.name) ?? name, version: str(child.version), path: childPath, kinds: [], status: [] };
        nodes.set(childId, node);
      }
      node.version ??= str(child.version);
      node.kinds = [...new Set([...node.kinds, ...kinds])];
      node.status = [...new Set([...node.status, ...statuses])];
      const edgeId = JSON.stringify([id, childId, name]);
      const previous = edges.get(edgeId);
      edges.set(edgeId, {
        id: edgeId, source: id, target: childId, name,
        requested: declaration?.requested ?? previous?.requested,
        kinds: [...new Set([...(previous?.kinds ?? []), ...kinds])],
        optionalPeer: asObject(peerMeta[name]).optional === true,
      });
      queue.push({ raw: child, id: childId });
    }
  }
  return { root, source, nodes: [...nodes.values()], edges: [...edges.values()], diagnostics: [...messages] };
}
