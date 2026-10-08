// Family 2 baselines (docs/tasks.md §3). `one_shot` and `retry_wallet` read only the observation.
// The two oracles are handed the hidden capacities and balances at the start of the episode and
// keep their own copy of the network, applying each payment they deliver; since only the agent's
// own payments move balances, their copy stays equal to the environment's.

import type { Agent, EpisodeInfo } from "../../harness/agent.ts";
import { isObject, type Json } from "../../harness/json.ts";
import type { PlacementFixture } from "../placement/generate.ts";
import { Network } from "../placement/network.ts";
import { publicOrder, type RoutingView } from "./env.ts";

const viewOf = (o: Json): RoutingView => (o as unknown as { view: RoutingView }).view;
const attempt = (candidate: number): Json => ({ tool: "attempt", args: { candidate } });
const SKIP: Json = { tool: "skip" };

/** Floor: the cheapest public path, once. */
export class OneShot implements Agent {
  readonly id = "one_shot";
  act(o: Json): Json {
    const v = viewOf(o);
    if (v.tried.length > 0 || v.candidates.length === 0) return SKIP;
    return attempt(publicOrder(v.candidates)[0]!.index);
  }
}

/** Reference: the first three candidates in public-fee order, in turn. */
export class RetryWallet implements Agent {
  readonly id = "retry_wallet";
  act(o: Json): Json {
    const v = viewOf(o);
    const next = publicOrder(v.candidates)[v.tried.length];
    return next ? attempt(next.index) : SKIP;
  }
}

abstract class HiddenStateOracle implements Agent {
  abstract readonly id: string;
  readonly privileged = true;
  protected abstract readonly prefix: number;
  /** The public edges and fees of a seed's topology; the hidden state comes from `privileged`. */
  private readonly fixtureOf: (seed: number) => PlacementFixture;
  private net: Network | null = null;
  constructor(fixtureOf: (seed: number) => PlacementFixture) { this.fixtureOf = fixtureOf; }
  reset(episode: EpisodeInfo, privileged?: Json): void {
    if (!isObject(privileged)) throw new Error(`${this.id} was not given privileged information`);
    const p = privileged as unknown as { capacity: number[]; balance_uv: number[] };
    const base = this.fixtureOf(episode.seed);
    // Rebuild the episode's starting network from the public edges and the hidden state handed over.
    this.net = Network.fromFixture({ ...base, capacity: p.capacity, balance_uv: { balanced_band: p.balance_uv, uniform: p.balance_uv, polarized: p.balance_uv } }, "uniform");
  }
  act(o: Json): Json {
    const v = viewOf(o);
    const pick = publicOrder(v.candidates).slice(0, this.prefix).find((c) => this.net!.feasible(c.path, v.demand.sats));
    if (!pick) return SKIP;
    this.net!.apply(pick.path, v.demand.sats);
    return attempt(pick.index);
  }
}

/** Ceiling: the first feasible candidate in the whole eight-path catalog, in public-fee order. */
export class FullOracle extends HiddenStateOracle {
  readonly id = "hidden_state_oracle";
  protected readonly prefix = Number.POSITIVE_INFINITY;
}

/** Control: the first feasible among the first three. Must deliver exactly what `retry_wallet` delivers. */
export class PrefixOracle3 extends HiddenStateOracle {
  readonly id = "prefix_oracle_3";
  protected readonly prefix = 3;
}

export const routingBaselines = (fixture: (seed: number) => PlacementFixture): Agent[] =>
  [new OneShot(), new RetryWallet(), new PrefixOracle3(fixture), new FullOracle(fixture)];
