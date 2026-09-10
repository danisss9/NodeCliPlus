import type { DependencyEdge, DependencyGraph } from './npm-graph';

/** Adjacency index shared by the webview and tests; traversal is iterative and cycle-safe. */
export class DependencyGraphIndex {
  readonly outgoing = new Map<string, DependencyEdge[]>();
  readonly incoming = new Map<string, DependencyEdge[]>();
  readonly nodes: Map<string, DependencyGraph['nodes'][number]>;
  private readonly parents = new Map<string, string>();

  constructor(readonly graph: DependencyGraph) {
    this.nodes = new Map(graph.nodes.map(node => [node.id, node]));
    for (const edge of graph.edges) {
      const outgoing = this.outgoing.get(edge.source) ?? [];
      outgoing.push(edge);
      this.outgoing.set(edge.source, outgoing);
      const incoming = this.incoming.get(edge.target) ?? [];
      incoming.push(edge);
      this.incoming.set(edge.target, incoming);
    }
    const queue = [graph.root];
    this.parents.set(graph.root, graph.root);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const edge of this.outgoing.get(queue[cursor]) ?? []) {
        if (!this.parents.has(edge.target)) {
          this.parents.set(edge.target, edge.source);
          queue.push(edge.target);
        }
      }
    }
  }

  visible(expanded: ReadonlySet<string>): { nodes: Set<string>; edges: DependencyEdge[] } {
    const nodes = new Set([this.graph.root]);
    const edges: DependencyEdge[] = [];
    const queue = [this.graph.root];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor];
      if (!expanded.has(id)) { continue; }
      for (const edge of this.outgoing.get(id) ?? []) {
        edges.push(edge);
        if (!nodes.has(edge.target)) {
          nodes.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    return { nodes, edges };
  }

  shortestPath(target: string): string[] {
    if (!this.parents.has(target)) { return []; }
    const result = [target];
    while (result[result.length - 1] !== this.graph.root) {
      result.push(this.parents.get(result[result.length - 1])!);
    }
    return result.reverse();
  }

  missingPeerIds(): Set<string> {
    if (this.graph.source === 'Declared only') { return new Set(); }
    return new Set(this.graph.edges.filter(edge => edge.kinds.includes('peer') && !edge.optionalPeer
      && this.nodes.get(edge.target)?.status.includes('missing')).map(edge => edge.target));
  }
}
