// Directional channel state: the settlement object of class C. One aggregate channel per node
// pair, with ℓ_uv + ℓ_vu = χ held by construction. Ported from Spiral's src/spiral_ln/algebra.py
// (Channel, NetworkState): a route is feasible when every hop has the amount available, a payment
// moves the same amount on every hop, and a failed attempt changes nothing. Fees order the
// candidates; they are not deducted hop by hop.

import { canonical } from "../../harness/json.ts";
import { cmp, pairKey, sortedPair } from "../../harness/order.ts";
import type { BalanceModel, PlacementFixture } from "./generate.ts";

export interface Channel {
  u: string;
  v: string;
  capacity: number;
  balanceUv: number;
  baseFeeMsat: number;
  feePpm: number;
  cltvDelta: number;
}

export interface Policy { base_fee_msat: number; fee_ppm: number; cltv_delta: number; }

export class Network {
  private readonly channels = new Map<string, Channel>();

  static fromFixture(fixture: PlacementFixture, model: BalanceModel): Network {
    const net = new Network();
    fixture.edges.forEach((e, i) => {
      net.channels.set(pairKey(e.u, e.v), {
        u: e.u, v: e.v, capacity: fixture.capacity[i]!, balanceUv: fixture.balance_uv[model][i]!,
        baseFeeMsat: e.base_fee_msat, feePpm: e.fee_ppm, cltvDelta: e.cltv_delta,
      });
    });
    return net;
  }

  has(a: string, b: string): boolean {
    return this.channels.has(pairKey(a, b));
  }

  private channel(a: string, b: string): Channel {
    const c = this.channels.get(pairKey(a, b));
    if (!c) throw new Error(`no channel ${a}-${b}`);
    return c;
  }

  /** Spendable balance from a toward b. */
  available(a: string, b: string): number {
    const c = this.channel(a, b);
    return a === c.u ? c.balanceUv : c.capacity - c.balanceUv;
  }

  feasible(path: readonly string[], sats: number): boolean {
    if (path.length < 2) return false;
    for (let i = 0; i + 1 < path.length; i++) {
      if (this.available(path[i]!, path[i + 1]!) < sats) return false;
    }
    return true;
  }

  /** Public fee of a path for an amount: Σ over hops of base + ceil(sats × ppm / 1000), in msat. */
  costMsat(path: readonly string[], sats: number): number {
    let total = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const c = this.channel(path[i]!, path[i + 1]!);
      total += c.baseFeeMsat + Math.ceil((sats * c.feePpm) / 1000);
    }
    return total;
  }

  /** Apply a payment atomically. Feasibility is checked on every hop before any balance moves. */
  apply(path: readonly string[], sats: number): void {
    if (!Number.isInteger(sats) || sats <= 0) throw new Error("amount must be a positive integer");
    if (!this.feasible(path, sats)) throw new Error("route is infeasible");
    for (let i = 0; i + 1 < path.length; i++) {
      const c = this.channel(path[i]!, path[i + 1]!);
      c.balanceUv += path[i] === c.u ? -sats : sats;
    }
  }

  /**
   * Add directional capacity: `sats` of new capacity on the pair, all of it spendable from `from`
   * toward `to`. Creates the channel with `policy` if the pair has none.
   */
  addCapacity(from: string, to: string, sats: number, policy: Policy): void {
    if (!Number.isInteger(sats) || sats <= 0) throw new Error("amount must be a positive integer");
    if (from === to) throw new Error("a channel needs distinct endpoints");
    const key = pairKey(from, to);
    let c = this.channels.get(key);
    if (!c) {
      const [u, v] = sortedPair(from, to);
      c = { u, v, capacity: 0, balanceUv: 0, baseFeeMsat: policy.base_fee_msat, feePpm: policy.fee_ppm, cltvDelta: policy.cltv_delta };
      this.channels.set(key, c);
    }
    c.capacity += sats;
    if (from === c.u) c.balanceUv += sats;
  }

  totalCapacity(): number {
    let total = 0;
    for (const c of this.channels.values()) total += c.capacity;
    return total;
  }

  /** Sorted neighbor lists of the public graph. */
  adjacency(): Map<string, string[]> {
    const adj = new Map<string, string[]>();
    for (const key of [...this.channels.keys()].sort(cmp)) {
      const c = this.channels.get(key)!;
      if (!adj.has(c.u)) adj.set(c.u, []);
      if (!adj.has(c.v)) adj.set(c.v, []);
      adj.get(c.u)!.push(c.v);
      adj.get(c.v)!.push(c.u);
    }
    for (const list of adj.values()) list.sort(cmp);
    return adj;
  }

  assertInvariants(): void {
    for (const c of this.channels.values()) {
      if (!Number.isInteger(c.balanceUv) || c.balanceUv < 0 || c.balanceUv > c.capacity) {
        throw new Error(`balance escaped channel bounds on ${c.u}-${c.v}`);
      }
    }
  }

  clone(): Network {
    const net = new Network();
    for (const [key, c] of this.channels) net.channels.set(key, { ...c });
    return net;
  }

  snapshot(): string {
    return canonical(this.channels);
  }
}
