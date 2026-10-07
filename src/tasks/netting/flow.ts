// Minimum-cost flow by successive shortest paths with Bellman-Ford on the residual graph. The
// instances here are small (a few dozen nodes, a few hundred arcs) and amounts are integers, so
// this is exact and fast enough; it is the ceiling baseline of family 6 and the identity control's
// direct computation. No dependency.

export interface Arc {
  from: number;
  to: number;
  capacity: number;
  /** Cost per unit of flow, an integer (parts per million of the amount in this family). */
  cost: number;
}

export interface FlowResult {
  /** Flow on each input arc, in input order. */
  flows: number[];
  /** Σ flow × cost over arcs. */
  cost: number;
  /** Total amount routed from sources to sinks. */
  routed: number;
}

/**
 * Route the supplies to the demands at minimum cost. `supply[i] > 0` is an amount node i must
 * send; `< 0` an amount it must receive; the supplies must sum to zero. Throws if the arcs cannot
 * carry every supply.
 */
export function minCostFlow(nodeCount: number, arcs: readonly Arc[], supply: readonly number[]): FlowResult {
  const total = supply.reduce((a, s) => a + s, 0);
  if (total !== 0) throw new Error(`supplies sum to ${total}, not zero`);
  const source = nodeCount;
  const sink = nodeCount + 1;
  const n = nodeCount + 2;
  // Residual arcs stored in pairs: 2k is forward, 2k+1 its reverse.
  const to: number[] = [], cap: number[] = [], cost: number[] = [], head: number[] = Array(n).fill(-1), next: number[] = [];
  const add = (u: number, v: number, c: number, w: number): number => {
    const id = to.length;
    to.push(v); cap.push(c); cost.push(w); next.push(head[u]!); head[u] = id;
    to.push(u); cap.push(0); cost.push(-w); next.push(head[v]!); head[v] = id + 1;
    return id;
  };
  const arcIds = arcs.map((a) => {
    if (!Number.isInteger(a.capacity) || a.capacity < 0 || !Number.isInteger(a.cost)) throw new Error("arc capacity and cost must be non-negative integers");
    return add(a.from, a.to, a.capacity, a.cost);
  });
  let demand = 0;
  supply.forEach((s, i) => {
    if (!Number.isInteger(s)) throw new Error("supplies must be integers");
    if (s > 0) add(source, i, s, 0);
    if (s < 0) { add(i, sink, -s, 0); demand += -s; }
  });
  let routed = 0;
  let totalCost = 0;
  const dist: number[] = Array(n), parent: number[] = Array(n), inQueue: boolean[] = Array(n);
  while (routed < demand) {
    dist.fill(Infinity); parent.fill(-1); inQueue.fill(false);
    dist[source] = 0;
    const queue: number[] = [source];
    inQueue[source] = true;
    // SPFA: Bellman-Ford with a queue; the residual graph has no negative cycles because every
    // augmentation is along a shortest path.
    while (queue.length) {
      const u = queue.shift()!;
      inQueue[u] = false;
      for (let e = head[u]!; e !== -1; e = next[e]!) {
        if (cap[e]! > 0 && dist[u]! + cost[e]! < dist[to[e]!]!) {
          dist[to[e]!] = dist[u]! + cost[e]!;
          parent[to[e]!] = e;
          if (!inQueue[to[e]!]) { inQueue[to[e]!] = true; queue.push(to[e]!); }
        }
      }
    }
    if (dist[sink] === Infinity) throw new Error(`the arcs cannot carry every supply: ${demand - routed} unrouted`);
    let bottleneck = demand - routed;
    for (let v = sink; v !== source; v = to[parent[v]! ^ 1]!) bottleneck = Math.min(bottleneck, cap[parent[v]!]!);
    for (let v = sink; v !== source; v = to[parent[v]! ^ 1]!) {
      const e = parent[v]!;
      cap[e] = cap[e]! - bottleneck;
      cap[e ^ 1] = cap[e ^ 1]! + bottleneck;
    }
    routed += bottleneck;
    totalCost += bottleneck * dist[sink]!;
  }
  return { flows: arcIds.map((id, i) => arcs[i]!.capacity - cap[id]!), cost: totalCost, routed };
}
