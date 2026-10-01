// Candidate paths. The catalog for a (source, target) pair is the first `limit` simple paths under
// the total order (hop count, node sequence), computed from the public graph and independent of
// hidden balances. Spiral used NetworkX's shortest_simple_paths, whose order among equal-length
// paths follows container iteration order; the audit names that as a reproducibility defect. Here
// the order is total, so the catalog is a function of the graph alone.
//
// Yen's algorithm. It returns the exact first k paths under the order because, for a fixed root
// prefix, comparing whole paths is comparing spur paths, and the spur search returns the least
// spur under the same order.

import { cmpSeq } from "../../harness/order.ts";

type Adjacency = Map<string, string[]>; // sorted neighbor lists

/** Least path from source to target under (hop count, node sequence), avoiding blocked nodes and directed edges. */
function leastPath(adj: Adjacency, source: string, target: string, blockedNodes: Set<string>, blockedEdges: Set<string>): string[] | null {
  // Distance to target by BFS from the target. Moving y ← x uses the forward edge x → y.
  const dist = new Map<string, number>([[target, 0]]);
  const queue = [target];
  for (let i = 0; i < queue.length; i++) {
    const y = queue[i]!;
    const d = dist.get(y)!;
    for (const x of adj.get(y) ?? []) {
      if (dist.has(x) || blockedNodes.has(x) || blockedEdges.has(`${x}>${y}`)) continue;
      dist.set(x, d + 1);
      queue.push(x);
    }
  }
  if (!dist.has(source)) return null;
  const path = [source];
  let current = source;
  while (current !== target) {
    const d = dist.get(current)!;
    // Neighbor lists are sorted, so the first neighbor one step closer is the lexicographically least.
    const next = (adj.get(current) ?? []).find((n) => dist.get(n) === d - 1 && !blockedEdges.has(`${current}>${n}`));
    if (next === undefined) throw new Error("leastPath: distance labels are inconsistent");
    path.push(next);
    current = next;
  }
  return path;
}

const order = (a: readonly string[], b: readonly string[]): number => a.length - b.length || cmpSeq(a, b);

export function kShortestSimplePaths(adj: Adjacency, source: string, target: string, k: number): string[][] {
  if (source === target || !adj.has(source) || !adj.has(target)) return [];
  const first = leastPath(adj, source, target, new Set(), new Set());
  if (first === null) return [];
  const accepted: string[][] = [first];
  const candidates = new Map<string, string[]>();
  const seen = new Set<string>([first.join(">")]);
  while (accepted.length < k) {
    const previous = accepted[accepted.length - 1]!;
    for (let i = 0; i + 1 < previous.length; i++) {
      const root = previous.slice(0, i + 1);
      const blockedEdges = new Set<string>();
      for (const p of accepted) {
        if (p.length > i + 1 && root.every((n, j) => p[j] === n)) blockedEdges.add(`${p[i]}>${p[i + 1]}`);
      }
      const blockedNodes = new Set(root.slice(0, i));
      const spur = leastPath(adj, previous[i]!, target, blockedNodes, blockedEdges);
      if (spur === null) continue;
      const path = [...root.slice(0, i), ...spur];
      const key = path.join(">");
      if (!seen.has(key)) { seen.add(key); candidates.set(key, path); }
    }
    if (candidates.size === 0) break;
    let bestKey = "";
    let best: string[] | null = null;
    for (const [key, path] of candidates) {
      if (best === null || order(path, best) < 0) { best = path; bestKey = key; }
    }
    candidates.delete(bestKey);
    accepted.push(best!);
  }
  return accepted;
}

/** Catalog of candidate paths, cached per (source, target). Built from public structure only. */
export class PathCatalog {
  private readonly adj: Adjacency;
  private readonly limit: number;
  private readonly cache = new Map<string, string[][]>();

  constructor(adj: Adjacency, limit: number) {
    this.adj = adj;
    this.limit = limit;
  }

  paths(source: string, target: string): string[][] {
    const key = `${source}>${target}`;
    let found = this.cache.get(key);
    if (!found) {
      found = kShortestSimplePaths(this.adj, source, target, this.limit);
      this.cache.set(key, found);
    }
    return found;
  }
}
