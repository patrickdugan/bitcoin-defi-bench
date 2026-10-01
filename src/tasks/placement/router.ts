// The retry wallet: order the public catalog by fee and attempt the first few candidates until one
// is feasible. This is the routing policy the earlier campaigns measured at +5.14 points over
// one-shot routing, and it is the fixed router for placement episodes. A failed attempt is the
// identity on channel state.

import { cmpSeq } from "../../harness/order.ts";
import type { Demand } from "./generate.ts";
import type { Network } from "./network.ts";
import type { PathCatalog } from "./paths.ts";

export interface RouteResult {
  delivered: boolean;
  failedAttempts: number;
  feeMsat: number;
}

/** Candidates in the order a public wallet would try them: (fee, hop count, node sequence). */
export function byPublicCost(net: Network, paths: readonly string[][], sats: number): string[][] {
  return paths
    .map((path) => ({ path, cost: net.costMsat(path, sats) }))
    .sort((a, b) => a.cost - b.cost || a.path.length - b.path.length || cmpSeq(a.path, b.path))
    .map((x) => x.path);
}

export function retryWallet(net: Network, catalog: PathCatalog, demand: Demand, maxAttempts: number): RouteResult {
  const [source, target, sats] = demand;
  const attempts = byPublicCost(net, catalog.paths(source, target), sats).slice(0, maxAttempts);
  let failedAttempts = 0;
  for (const path of attempts) {
    if (!net.feasible(path, sats)) { failedAttempts += 1; continue; }
    const feeMsat = net.costMsat(path, sats);
    net.apply(path, sats);
    return { delivered: true, failedAttempts, feeMsat };
  }
  return { delivered: false, failedAttempts, feeMsat: 0 };
}
