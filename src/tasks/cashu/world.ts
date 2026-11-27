// The desk's world for family 14 (docs/tasks.md §17): fee rules, what each decision is worth, the
// host's defaults, and the exact ceiling. Deterministic and pure in the fixture.
//
// Value, in sats, is the desk's profit and loss over the horizon:
//   + the desk's fee on a deposit it admits, minus whatever the payment fails to deliver;
//   + its margin on a sale paid by a good token, minus the goods' cost when the token is bad;
//   − withdrawal, refresh, exit, and move-out fees;
//   − the Cashu float held at the mint when the mint halts.
// Principal that only changes form (a refreshed VTXO, an exited coin, float moved into Ark) scores 0.
//
// The host's defaults, which also run whenever the agent stops acting: a deposit or token not decided
// in its arrival block is refused; the outbox dispatches a withdrawal at its deadline; the watcher
// exits a VTXO at the last block its exit runway allows, bidding `armed_multiplier` times the rate.

import type { CashuConfig, CashuFixture, DepositEvent, FeeSchedule, TokenEvent, Vtxo } from "./generate.ts";

/** Proof Grove's refresh_fee (proof-grove/proofdesk/ark.py), ported: one base fee per request, the ppm sum rounded up once. */
export function refreshFee(schedule: FeeSchedule, vtxos: ReadonlyArray<Pick<Vtxo, "amount_sats" | "expiry_height">>, height: number): number {
  let numerator = 0;
  for (const v of vtxos) {
    const remaining = Math.max(0, v.expiry_height - height);
    let rate = 0;
    for (const entry of schedule.ppm_expiry_table) if (remaining >= entry.expiry_blocks_threshold) rate = entry.ppm;
    numerator += v.amount_sats * rate;
  }
  return schedule.base_fee_sat + Math.floor((numerator + 999_999) / 1_000_000);
}

export const moveOutFee = (config: CashuConfig, amount: number): number => config.move_out_fee.base_fee_sat + Math.ceil(amount * config.move_out_fee.ppm / 1_000_000);
export const withdrawalFee = (amount: number, quotePpm: number): number => Math.ceil(amount * quotePpm / 1_000_000);
export const exitRunway = (config: CashuConfig): number => config.exit.exit_delta_blocks + 6 * config.exit.waves + 6;
/** The last block in which a VTXO can still start its exit (more than the runway left); the watcher fires at its end. */
export const lastExitBlock = (config: CashuConfig, v: Pick<Vtxo, "expiry_height">): number => v.expiry_height - exitRunway(config) - 1;

export const at = (f: Pick<CashuFixture, "start_height">, path: readonly number[], height: number): number => {
  const i = height - f.start_height;
  if (i < 0 || i >= path.length) throw new Error(`no value for height ${height}`);
  return path[i]!;
};
export const exitCost = (config: CashuConfig, f: CashuFixture, height: number, multiplier = 1): number => config.exit.vbytes * multiplier * at(f, f.fees, height);
export const online = (f: CashuFixture, height: number): boolean => f.outage === null || height < f.outage.start || height >= f.outage.end;
export const deskFee = (config: CashuConfig, amount: number): number => Math.round(amount * config.desk_fee_ppm / 1_000_000);
export const tokenMargin = (config: CashuConfig, amount: number): number => Math.round(amount * config.token_margin_ppm / 1_000_000);

/** An admitted deposit: the desk issues the intent's amount less its fee and receives what the payment delivers. */
export const admitValue = (config: CashuConfig, d: DepositEvent): number => d.received_sats - (d.intent.amount_sats - deskFee(config, d.intent.amount_sats));

/** A token is good if it is genuine under a keyset the mint lists, unspent, and the mint is running when it is accepted. */
export const tokenGood = (f: CashuFixture, t: TokenEvent, height: number): boolean =>
  (t.type === "genuine" || t.type === "inactive_keyset") && !t.spent && (f.mint.failure_height === null || height < f.mint.failure_height);

/** An accepted token: the margin if good; the goods' cost (amount less the margin) if not. */
export const acceptValue = (config: CashuConfig, f: CashuFixture, t: TokenEvent, height: number): number =>
  tokenGood(f, t, height) ? tokenMargin(config, t.amount_sats) : -(t.amount_sats - tokenMargin(config, t.amount_sats));

/** The latest round report published at or before `height`, or null. */
export function reportAt(f: CashuFixture, height: number): CashuFixture["mint"]["reports"][number] | null {
  let out = null;
  for (const r of f.mint.reports) if (r.height <= height) out = r;
  return out;
}

export interface VtxoPlan { cost: number; refresh: Array<{ height: number; ids: string[] }>; exits: Array<{ height: number; id: string }> }

/**
 * The cheapest way to carry every VTXO through the horizon, exactly. Each VTXO is refreshed in some
 * block where the server is online and the watcher has not fired, or exited by the desk at the
 * cheapest block of its runway window (the watcher's own exit costs more at every block). Refreshes
 * in one block share one base fee, so the plan is a dynamic program over blocks and the set of VTXOs
 * not yet refreshed. A VTXO that expires after the horizon needs nothing.
 */
export function vtxoPlan(config: CashuConfig, f: CashuFixture): VtxoPlan {
  const vs = f.vtxos.filter((v) => lastExitBlock(config, v) < f.horizon_height);
  const n = vs.length;
  if (n === 0) return { cost: 0, refresh: [], exits: [] };
  const lastBlock = vs.map((v) => lastExitBlock(config, v));
  const minExit = vs.map((v, i) => {
    let best = { cost: Infinity, height: f.start_height };
    for (let h = f.start_height; h <= lastBlock[i]!; h++) {
      const c = exitCost(config, f, h);
      if (c < best.cost) best = { cost: c, height: h };
    }
    return best;
  });
  const full = (1 << n) - 1;
  const end = Math.max(...lastBlock);
  // dp[t - start][S]: the least cost from block t on, with S the set not yet refreshed or resolved.
  const T = end - f.start_height + 2;
  const dp: number[][] = Array.from({ length: T }, () => new Array<number>(1 << n).fill(Infinity));
  const choice: Array<Array<{ batch: number; next: number } | null>> = Array.from({ length: T }, () => new Array(1 << n).fill(null));
  for (let S = 0; S <= full; S++) {
    // Past the last block, anything left was exited at its cheapest block.
    let c = 0;
    for (let i = 0; i < n; i++) if (S & (1 << i)) c += minExit[i]!.cost;
    dp[T - 1]![S] = c;
  }
  for (let t = end; t >= f.start_height; t--) {
    const k = t - f.start_height;
    const up = online(f, t);
    for (let S = 0; S <= full; S++) {
      let best = Infinity;
      let pick: { batch: number; next: number } | null = null;
      // Enumerate the batch B ⊆ S refreshed at t (only VTXOs whose watcher has not fired).
      for (let B = S; ; B = (B - 1) & S) {
        let ok = up || B === 0;
        for (let i = 0; i < n && ok; i++) if ((B & (1 << i)) && t > lastBlock[i]!) ok = false;
        if (ok) {
          let cost = B === 0 ? 0 : refreshFee(config.refresh_fee, vs.filter((_, i) => B & (1 << i)), t);
          let next = S & ~B;
          // A VTXO whose last block is t and is not refreshed now falls back to its exit.
          for (let i = 0; i < n; i++) if ((next & (1 << i)) && lastBlock[i] === t) { cost += minExit[i]!.cost; next &= ~(1 << i); }
          const total = cost + dp[k + 1]![next]!;
          if (total < best) { best = total; pick = { batch: B, next }; }
        }
        if (B === 0) break;
      }
      dp[k]![S] = best;
      choice[k]![S] = pick;
    }
  }
  const plan: VtxoPlan = { cost: dp[0]![full]!, refresh: [], exits: [] };
  let S = full;
  for (let t = f.start_height; t <= end; t++) {
    const c = choice[t - f.start_height]![S]!;
    if (c.batch !== 0) plan.refresh.push({ height: t, ids: vs.filter((_, i) => c.batch & (1 << i)).map((v) => v.id) });
    S = c.next;
  }
  // Everything not refreshed is exited at its cheapest block.
  const refreshed = new Set(plan.refresh.flatMap((r) => r.ids));
  vs.forEach((v, i) => { if (!refreshed.has(v.id)) plan.exits.push({ height: minExit[i]!.height, id: v.id }); });
  plan.exits.sort((a, b) => a.height - b.height || (a.id < b.id ? -1 : 1));
  return plan;
}

/** The cheapest block for each withdrawal between its arrival and its deadline (the earliest on a tie). */
export function withdrawalPlan(f: CashuFixture): Map<string, { height: number; fee: number }> {
  const out = new Map<string, { height: number; fee: number }>();
  for (const w of f.withdrawals) {
    let best = { height: w.arrival, fee: Infinity };
    for (let h = w.arrival; h <= w.deadline; h++) {
      const fee = withdrawalFee(w.amount_sats, at(f, f.quotes, h));
      if (fee < best.fee) best = { height: h, fee };
    }
    out.set(w.id, best);
  }
  return out;
}

export interface Ceiling {
  value: number;
  admit: string[];
  accept: string[];
  withdrawals: Map<string, { height: number; fee: number }>;
  vtxos: VtxoPlan;
  /** The block in which the whole float moves out of the mint, if it halts. */
  move_out_height: number | null;
}

/**
 * The exact ceiling, from the hidden truth. Each part is separable: a deposit is admitted iff it
 * pays; a token is accepted iff it is good (its margin exceeds what it adds to a move-out); each
 * withdrawal goes at its cheapest quote; the VTXOs follow `vtxoPlan`; and if the mint halts, the
 * float moves out once, in the block before, which is the only move a halt needs.
 */
export function ceilingOf(config: CashuConfig, f: CashuFixture): Ceiling {
  let value = 0;
  const admit: string[] = [];
  for (const d of f.deposits) if (admitValue(config, d) > 0) { admit.push(d.id); value += admitValue(config, d); }
  const accept: string[] = [];
  let floatAtHalt = f.float_sats;
  for (const t of f.tokens) {
    if (!tokenGood(f, t, t.arrival)) continue;
    accept.push(t.id);
    value += tokenMargin(config, t.amount_sats);
    if (f.mint.failure_height !== null && t.arrival < f.mint.failure_height) floatAtHalt += t.amount_sats;
  }
  const withdrawals = withdrawalPlan(f);
  for (const w of withdrawals.values()) value -= w.fee;
  for (const w of f.withdrawals) if (f.mint.failure_height !== null && w.arrival < f.mint.failure_height) throw new Error("withdrawals and a mint halt in one episode are not modelled");
  const vtxos = vtxoPlan(config, f);
  value -= vtxos.cost;
  let moveOut: number | null = null;
  if (f.mint.failure_height !== null) {
    moveOut = f.mint.failure_height - 1;
    value -= Math.min(moveOutFee(config, floatAtHalt), floatAtHalt);
  }
  return { value, admit, accept, withdrawals, vtxos, move_out_height: moveOut };
}

/** What the host's defaults alone earn: nothing admitted or accepted, withdrawals at their deadlines, every VTXO exited by the watcher, the float held. */
export function defaultValue(config: CashuConfig, f: CashuFixture): number {
  let value = 0;
  for (const w of f.withdrawals) value -= withdrawalFee(w.amount_sats, at(f, f.quotes, w.deadline));
  for (const v of f.vtxos) {
    const last = lastExitBlock(config, v);
    if (last < f.horizon_height) value -= exitCost(config, f, last, config.exit.armed_multiplier);
  }
  if (f.mint.failure_height !== null) value -= f.float_sats;
  return value;
}
