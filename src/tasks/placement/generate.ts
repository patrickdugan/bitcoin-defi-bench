// Fixture generator for the placement and routing families: a connected public-topology sample,
// synthetic hidden capacities and directional balances, two hotspot pairs, and a demand stream
// under each regime. Ported from Spiral's src/spiral_ln/public_topology.py with the same
// distributions and rules. It is not bit-identical: the random streams are the bench's own, and
// every list is canonicalized before a seeded draw touches it (the audit's reproducibility
// finding), so these are new samples, not reproductions of the recorded ones.
//
// A fixture holds integers and strings only.

import { canonical, sha256 } from "../../harness/json.ts";
import { cmp, nodeId, pairKey, sortedPair } from "../../harness/order.ts";
import { stream } from "../../harness/prng.ts";
import { adjacencyOf, components, type PublicEdge, type PublicGraph } from "./gml.ts";

export const FIXTURE_VERSION = "placement-fixture/v0";
export const SAMPLING_MODES = ["hub", "random", "periphery"] as const;
export const BALANCE_MODELS = ["balanced_band", "uniform", "polarized"] as const;
export const REGIMES = ["stationary", "shift"] as const;
export type SamplingMode = (typeof SAMPLING_MODES)[number];
export type BalanceModel = (typeof BALANCE_MODELS)[number];
export type Regime = (typeof REGIMES)[number];

export interface PlacementConfig {
  node_count: number;
  steps: number;
  evaluation_start: number;
  hotspot_probability: number;
  hotspot_forward_probability: number;
  amounts: number[];
  capacity_median: number;
  capacity_log_sigma: number;
  capacity_minimum: number;
  capacity_maximum: number;
  candidate_path_limit: number;
  max_route_attempts: number;
  budget_sats: number;
  attempts: number;
  min_pair_sats: number;
  new_channel_policy: { base_fee_msat: number; fee_ppm: number; cltv_delta: number };
}

export type Demand = [source: string, target: string, sats: number];

export interface PlacementFixture {
  version: string;
  seed: number;
  sample: { id: string; mode: SamplingMode; attempt: number; source_node_sha256: string; snapshot_sha256: string };
  nodes: string[];
  edges: PublicEdge[];
  capacity: number[];
  balance_uv: { [model in BalanceModel]: number[] };
  hotspots: { first: [string, string]; second: [string, string] };
  demand: { [regime in Regime]: Demand[] };
}

/** Anchor candidates by sampling mode, as Spiral's _anchor_candidates. */
function anchorCandidates(nodes: readonly string[], adjacency: Map<string, string[]>, mode: SamplingMode): string[] {
  const degree = (n: string): number => adjacency.get(n)?.length ?? 0;
  if (mode === "hub") {
    return [...nodes].sort((a, b) => degree(b) - degree(a) || cmp(a, b)).slice(0, 64);
  }
  if (mode === "periphery") {
    const low = nodes.filter((n) => degree(n) <= 2);
    if (low.length > 0) return low;
  }
  return [...nodes];
}

/** Frontier growth from an anchor inside the giant component, as Spiral's sample_connected_subgraph. */
const giantCache = new WeakMap<PublicGraph, string[]>();

export function sampleNodes(graph: PublicGraph, seed: number, attempt: number, nodeCount: number, mode: SamplingMode): string[] {
  if (!giantCache.has(graph)) giantCache.set(graph, components(graph.nodes, graph.adjacency)[0]!);
  const giant = giantCache.get(graph)!;
  if (nodeCount < 8 || nodeCount > giant.length) throw new Error("node_count must fit inside the largest component");
  const inGiant = new Set(giant);
  const rng = stream("placement/sample", seed, attempt);
  const anchor = rng.pick(anchorCandidates(giant, graph.adjacency, mode));
  const selected = new Set<string>([anchor]);
  const frontier = [anchor];
  while (selected.size < nodeCount) {
    if (frontier.length === 0) throw new Error("connected frontier exhausted before reaching the sample size");
    const current = frontier.splice(rng.int(frontier.length), 1)[0]!;
    // Neighbor lists are sorted in the adjacency map, so the shuffle starts from a canonical order.
    const neighbors = (graph.adjacency.get(current) ?? []).filter((n) => inGiant.has(n) && !selected.has(n));
    rng.shuffle(neighbors);
    for (const neighbor of neighbors) {
      selected.add(neighbor);
      frontier.push(neighbor);
      if (selected.size === nodeCount) break;
    }
  }
  return [...selected].sort(cmp);
}

function balanceFraction(model: BalanceModel, u: number): number {
  if (model === "balanced_band") return 0.3 + 0.4 * u;
  if (model === "uniform") return 0.02 + 0.96 * u;
  return u < 0.5 ? 0.01 + 0.14 * (2 * u) : 0.85 + 0.14 * (2 * u - 1);
}

/** All-pairs hop distances by BFS. Unreachable pairs are absent. */
export function hopDistances(nodes: readonly string[], adjacency: Map<string, string[]>): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const start of nodes) {
    const dist = new Map<string, number>([[start, 0]]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const d = dist.get(queue[i]!)!;
      for (const next of adjacency.get(queue[i]!) ?? []) {
        if (!dist.has(next)) { dist.set(next, d + 1); queue.push(next); }
      }
    }
    out.set(start, dist);
  }
  return out;
}

/**
 * Two non-adjacent hotspot pairs, as Spiral's choose_hotspot_pairs: pairs at distance ≥ 3 when at
 * least two exist, otherwise any non-adjacent pair; drawn from the 32 greatest by (distance, left,
 * right). The second pair shares no endpoint with the first. Returns null when no disjoint second
 * pair exists, which the caller treats as a failed generator invariant.
 */
function chooseHotspots(nodes: readonly string[], adjacency: Map<string, string[]>, seed: number, attempt: number): { first: [string, string]; second: [string, string] } | null {
  const dist = hopDistances(nodes, adjacency);
  type Cand = { d: number; left: string; right: string };
  const nonadjacent: Cand[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = dist.get(nodes[i]!)!.get(nodes[j]!) ?? 0;
      if (d >= 2) nonadjacent.push({ d, left: nodes[i]!, right: nodes[j]! });
    }
  }
  const long = nonadjacent.filter((c) => c.d >= 3);
  const candidates = long.length >= 2 ? long : nonadjacent;
  if (candidates.length < 2) return null;
  candidates.sort((a, b) => b.d - a.d || cmp(b.left, a.left) || cmp(b.right, a.right));
  const rng = stream("placement/hotspot", seed, attempt);
  const first = rng.pick(candidates.slice(0, 32));
  const disjoint = candidates.filter((c) => c.left !== first.left && c.left !== first.right && c.right !== first.left && c.right !== first.right);
  if (disjoint.length === 0) return null;
  const second = rng.pick(disjoint.slice(0, 32));
  return { first: [first.left, first.right], second: [second.left, second.right] };
}

function demandStreams(nodes: readonly string[], hotspots: { first: [string, string]; second: [string, string] }, seed: number, attempt: number, config: PlacementConfig): { [regime in Regime]: Demand[] } {
  const rng = stream("placement/demand", seed, attempt);
  const out: { [regime in Regime]: Demand[] } = { stationary: [], shift: [] };
  for (let i = 0; i < config.steps; i++) {
    // Every draw is taken on every step, whichever branch uses it, so the two regimes share one
    // stream and differ only in which hotspot pair is active after the boundary.
    const hot = rng.next() < config.hotspot_probability;
    const forward = rng.next() < config.hotspot_forward_probability;
    const a = rng.int(nodes.length);
    let b = rng.int(nodes.length - 1);
    if (b >= a) b += 1;
    const sats = rng.pick(config.amounts);
    for (const regime of REGIMES) {
      if (hot) {
        const pair = regime === "shift" && i >= config.evaluation_start ? hotspots.second : hotspots.first;
        out[regime].push(forward ? [pair[0], pair[1], sats] : [pair[1], pair[0], sats]);
      } else {
        out[regime].push([nodes[a]!, nodes[b]!, sats]);
      }
    }
  }
  return out;
}

/** Sampling attempts allowed before a seed is declared ungeneratable. */
export const MAX_SAMPLE_ATTEMPTS = 16;

export function generateFixture(graph: PublicGraph, snapshotSha256: string, seed: number, config: PlacementConfig): PlacementFixture {
  const mode = SAMPLING_MODES[seed % SAMPLING_MODES.length]!;
  for (let attempt = 0; attempt < MAX_SAMPLE_ATTEMPTS; attempt++) {
    const originals = sampleNodes(graph, seed, attempt, config.node_count, mode);
    const label = new Map(originals.map((name, i) => [name, nodeId(i)]));
    const edges: PublicEdge[] = graph.edges
      .filter((e) => label.has(e.u) && label.has(e.v))
      .map((e) => {
        const [u, v] = sortedPair(label.get(e.u)!, label.get(e.v)!);
        return { u, v, base_fee_msat: e.base_fee_msat, fee_ppm: e.fee_ppm, cltv_delta: e.cltv_delta };
      })
      .sort((x, y) => cmp(pairKey(x.u, x.v), pairKey(y.u, y.v)));
    const nodes = originals.map((_, i) => nodeId(i));
    const adjacency = adjacencyOf(edges);
    if (components(nodes, adjacency).length !== 1) continue;
    const hotspots = chooseHotspots(nodes, adjacency, seed, attempt);
    if (hotspots === null) continue;

    const capRng = stream("placement/capacity", seed, attempt);
    const balRng = stream("placement/balance", seed, attempt);
    const capacity: number[] = [];
    const balance_uv: { [model in BalanceModel]: number[] } = { balanced_band: [], uniform: [], polarized: [] };
    for (let i = 0; i < edges.length; i++) {
      const raw = Math.floor(Math.exp(Math.log(config.capacity_median) + config.capacity_log_sigma * capRng.normal()));
      const cap = Math.max(config.capacity_minimum, Math.min(config.capacity_maximum, raw));
      capacity.push(cap);
      // One uniform draw per edge, mapped through each ensemble, so the three balance models are paired.
      const u = balRng.next();
      for (const model of BALANCE_MODELS) {
        balance_uv[model].push(Math.max(1, Math.min(cap - 1, Math.floor(cap * balanceFraction(model, u)))));
      }
    }
    const sourceHash = sha256(originals.join("\n"));
    return {
      version: FIXTURE_VERSION,
      seed,
      sample: { id: `public-${mode}-${seed}-${sourceHash.slice(0, 12)}`, mode, attempt, source_node_sha256: sourceHash, snapshot_sha256: snapshotSha256 },
      nodes,
      edges,
      capacity,
      balance_uv,
      hotspots,
      demand: demandStreams(nodes, hotspots, seed, attempt, config),
    };
  }
  throw new Error(`seed ${seed}: no sample satisfied the generator invariants in ${MAX_SAMPLE_ATTEMPTS} attempts`);
}

/** Exact bytes of a fixture file. */
export const fixtureBytes = (fixture: PlacementFixture): string => `${canonical(fixture)}\n`;

export const fixturePath = (seed: number): string => `fixtures/placement/seed-${String(seed).padStart(4, "0")}.json`;
