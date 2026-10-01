// Reader for the public-gossip GML snapshot (Valko and Marx Gómez, Harvard Dataverse
// DOI 10.7910/DVN/2OAVO6, CC BY 4.0). Used only when fixtures are built; a bench run reads
// hash-bound fixtures and never the snapshot. Gossip gives topology and channel policy. It does
// not give capacity or directional balance, which stay synthetic.
//
// The graph is read as Spiral's load_public_graph reads it: undirected, nodes keyed by their
// label, self-loops removed. Policy fields default to 1000 msat, 100 ppm, 40 blocks when absent.

import { cmp, pairKey, sortedPair } from "../../harness/order.ts";

export interface PublicEdge {
  u: string;
  v: string;
  base_fee_msat: number;
  fee_ppm: number;
  cltv_delta: number;
}

export interface PublicGraph {
  nodes: string[];                    // sorted labels
  edges: PublicEdge[];                // endpoints canonical, list sorted by (u, v)
  adjacency: Map<string, string[]>;   // sorted neighbor lists
  duplicatePairs: number;
}

const nonNegInt = (raw: string | undefined, fallback: number): number => {
  const n = raw === undefined ? fallback : Math.trunc(Number(raw));
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
};

export function parseGml(text: string): PublicGraph {
  const labelById = new Map<string, string>();
  const records: Array<{ fields: Map<string, string> }> = [];
  const stack: string[] = [];
  let fields: Map<string, string> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.endsWith("[")) {
      const name = line.slice(0, -1).trim();
      stack.push(name);
      if (stack.length === 2 && (name === "node" || name === "edge")) fields = new Map();
      continue;
    }
    if (line === "]") {
      const name = stack.pop();
      if (stack.length === 1 && fields) {
        if (name === "node") labelById.set(fields.get("id")!, fields.get("label")!);
        else if (name === "edge") records.push({ fields });
        fields = null;
      }
      continue;
    }
    if (stack.length === 2 && fields) {
      const space = line.indexOf(" ");
      const key = line.slice(0, space);
      let value = line.slice(space + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      fields.set(key, value);
    }
  }
  const byPair = new Map<string, PublicEdge & { scid: string }>();
  let duplicatePairs = 0;
  for (const { fields: f } of records) {
    const a = labelById.get(f.get("source")!);
    const b = labelById.get(f.get("target")!);
    if (a === undefined || b === undefined) throw new Error("edge references an unknown node id");
    if (a === b) continue;
    const [u, v] = sortedPair(a, b);
    const edge = {
      u, v,
      base_fee_msat: nonNegInt(f.get("fee_base_msat"), 1000),
      fee_ppm: nonNegInt(f.get("fee_proportional_millionths"), 100),
      cltv_delta: nonNegInt(f.get("cltv_expiry_delta"), 40),
      scid: f.get("scid") ?? "",
    };
    const key = pairKey(u, v);
    const existing = byPair.get(key);
    if (existing) {
      duplicatePairs += 1;
      // Parallel records collapse to one aggregate channel; keep the smallest scid, not the first seen.
      if (cmp(edge.scid, existing.scid) < 0) byPair.set(key, edge);
    } else {
      byPair.set(key, edge);
    }
  }
  const edges: PublicEdge[] = [...byPair.keys()].sort(cmp).map((k) => {
    const { scid: _scid, ...edge } = byPair.get(k)!;
    return edge;
  });
  return { nodes: [...labelById.values()].sort(cmp), edges, adjacency: adjacencyOf(edges), duplicatePairs };
}

export function adjacencyOf(edges: ReadonlyArray<{ u: string; v: string }>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push(b);
  };
  for (const e of edges) { add(e.u, e.v); add(e.v, e.u); }
  for (const list of adj.values()) list.sort(cmp);
  return adj;
}

/** Connected components as sorted node lists, largest first, ties by first node. */
export function components(nodes: readonly string[], adjacency: Map<string, string[]>): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const start of nodes) {
    if (seen.has(start)) continue;
    const comp = [start];
    seen.add(start);
    for (let i = 0; i < comp.length; i++) {
      for (const next of adjacency.get(comp[i]!) ?? []) {
        if (!seen.has(next)) { seen.add(next); comp.push(next); }
      }
    }
    out.push(comp.sort(cmp));
  }
  return out.sort((a, b) => b.length - a.length || cmp(a[0]!, b[0]!));
}

export function graphStats(graph: PublicGraph): { nodes: number; edges: number; components: number; largest: number; max_degree: number } {
  const comps = components(graph.nodes, graph.adjacency);
  let maxDegree = 0;
  for (const list of graph.adjacency.values()) maxDegree = Math.max(maxDegree, list.length);
  return { nodes: graph.nodes.length, edges: graph.edges.length, components: comps.length, largest: comps[0]!.length, max_degree: maxDegree };
}
