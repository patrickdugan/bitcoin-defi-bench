// Family 13 (docs/tasks.md §16): the holder's client on the SatsHedgeZero venue. The agent sees the
// mark packet its relay shows, its account, and the venue's terms, and acts through six tools:
// refresh (read the relay's next 200 ms slot), deposit and withdraw margin over Lightning, take
// against the maker's ladder on a latency tier, wait for the next step, and commit (hold whatever it
// has to maturity). The host checks arguments
// and the venue's rules, never whether a move is wise: it admits a take on a forged packet, and the
// packet's server decides whether to fill it.
//
// Budget: every admitted refresh, deposit, withdrawal, or take costs one probe; a wait costs one block (a
// step); every rejection costs one attempt. At most one margin transfer and one take per step. The
// phase ends at maturity, at commit, or when attempts or probes run out; the rest of the horizon then
// runs with no moves.

import { accept, reject, type Budget, type Environment, type Outcome, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, type Json } from "../../harness/json.ts";
import { TIERS, type ShzConfig, type ShzFixture, type Tier } from "./generate.ts";
import { capitalFee, initialMargin, liquidationMark, lnFee, settle, takeOutcome, tradeable, type Settlement } from "./world.ts";

export const TOOLS = ["refresh", "deposit", "withdraw", "take", "wait", "commit"] as const;

interface Costs { tracking: number; execution: number; taker_fees: number; lightning: number; capital: number; penalties: number; }
const zero = (): Costs => ({ tracking: 0, execution: 0, taker_fees: 0, lightning: 0, capital: 0, penalties: 0 });

interface State {
  t: number;
  slot: number;
  lots: number;
  units: number;
  pset: number;
  took: boolean;
  moved: boolean;
  costs: Costs;
  counts: { takes: number; premium_takes: number; rogue_fills: number; unfilled_takes: number; margin_moves: number; liquidations: number; bankruptcies: number };
  last: (Omit<Settlement, "lots_after"> & { step: number }) | null;
}

export class ShzEnv implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell = "single";
  private readonly f: ShzFixture;
  private readonly config: ShzConfig;
  private readonly s: State;
  private attempts: number;
  private probes: number;
  private closed = false;
  private readonly log: string[] = [];

  constructor(fixture: ShzFixture, config: ShzConfig) {
    this.f = fixture;
    this.config = config;
    this.task = `shz/${fixture.cell}`;
    this.seed = fixture.seed;
    this.s = {
      t: 0, slot: 0, lots: 0, units: 0, pset: fixture.marks[0]!, took: false, moved: false, costs: zero(),
      counts: { takes: 0, premium_takes: 0, rogue_fills: 0, unfilled_takes: 0, margin_moves: 0, liquidations: 0, bankruptcies: 0 },
      last: null,
    };
    this.attempts = config.budget.attempts;
    this.probes = config.budget.probes;
  }

  budget(): Budget { return { attempts: this.attempts, probes: this.probes, blocks: this.f.steps - this.s.t, sats: 0 }; }
  tools(): string[] { return this.closed ? [] : [...TOOLS]; }
  done(): boolean { return this.closed; }

  private get margin(): number { return this.s.units * this.f.margin_unit_sats; }

  view(): Json {
    const f = this.f;
    const c = this.config;
    const s = this.s;
    const t = Math.min(s.t, f.steps - 1);
    const boundary = f.origin_ms + s.t * f.step_ms + s.slot * c.slot_ms;
    const lots = f.target_lots[t]!;
    return {
      step: s.t, steps: f.steps, step_hours: f.step_ms / 3_600_000, slot: s.slot, slots_per_step: c.slots_per_step, slot_ms: c.slot_ms,
      clock: { now_ms: boundary + c.receive_delay_ms },
      packet: s.t < f.steps ? (f.packets[s.t]![s.slot]!.packet as unknown as Json) : null,
      federation: { members: [...f.members], quorum: c.federation.quorum, max_packet_age_ms: c.federation.max_packet_age_ms, max_source_age_ms: c.federation.max_source_age_ms, max_future_ms: c.federation.max_future_ms, max_source_skew_ms: c.federation.max_source_skew_ms, max_dispersion_bps: c.federation.max_dispersion_bps },
      target: { lots, usd: lots * f.lot_usd, lot_usd: f.lot_usd, balance_sats: f.balance_sats[t]! },
      account: {
        short_lots: s.lots, margin_sats: this.margin, margin_unit_sats: f.margin_unit_sats, max_margin_units: c.max_margin_units,
        liquidation_mark_usd: liquidationMark(f, c, s.lots, this.margin, s.pset),
        last_settlement: s.last as unknown as Json,
      },
      this_step: { took: s.took, moved_margin: s.moved },
      venue: {
        max_lots: c.max_lots, max_leverage: c.max_leverage, maintenance_bps: c.maintenance_bps, liquidation_discount_bps: c.liquidation_discount_bps,
        ladder: { ...c.ladder }, tiers: { standard: { ...c.tiers.standard }, premium: { ...c.tiers.premium } },
      },
      lightning: { ...c.lightning },
      capital_ppm_per_step: c.capital_ppm_per_step,
      costs_so_far: { ...s.costs },
    } as unknown as Json;
  }

  private rejectWith(reason: Parameters<typeof reject>[0], detail: string): StepResult {
    this.attempts -= 1;
    if (this.attempts <= 0) this.close();
    return reject(reason, { detail });
  }

  private close(): void { this.closed = true; }

  /** The step's capital charge, then the next step's settlement (and at maturity the margin's return). */
  private advance(): Json {
    const f = this.f;
    const c = this.config;
    const s = this.s;
    s.costs.capital += capitalFee(c, this.margin);
    s.t += 1;
    s.slot = 0;
    s.took = false;
    s.moved = false;
    const t = s.t;
    if (t < f.steps && f.hold[t] === 1) return { step: t, settled: false, reason: "the federation holds: no verified mark" };
    const st = settle(f, c, s.lots, this.margin, s.pset, f.marks[t]!, f.target_lots[t - 1]!);
    s.costs.tracking += st.tracking;
    s.costs.penalties += st.penalty;
    s.costs.lightning += st.lightning;
    if (st.liquidated) s.counts.liquidations += 1;
    if (st.bankrupt) s.counts.bankruptcies += 1;
    s.lots = st.lots_after;
    s.pset = f.marks[t]!;
    const { lots_after: _lotsAfter, ...rest } = st;
    s.last = { step: t, ...rest };
    if (t === f.steps) {
      s.costs.lightning += lnFee(c, this.margin);
      this.close();
    }
    return { step: t, settled: true, ...rest } as unknown as Json;
  }

  private transfer(dir: "deposit" | "withdraw", args: Record<string, unknown>): StepResult {
    const u = this.f.margin_unit_sats;
    const n = args.sats;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return this.rejectWith("not_integer", "sats must be a whole number of at least 1");
    if (n % u !== 0) return this.rejectWith("out_of_grid", `margin moves in whole multiples of ${u} sats`);
    if (this.s.moved) return this.rejectWith("duplicate", "one margin transfer per step");
    const units = n / u;
    if (dir === "deposit" && this.s.units + units > this.config.max_margin_units) return this.rejectWith("out_of_grid", `margin is at most ${this.config.max_margin_units * u} sats`);
    if (dir === "withdraw") {
      if (units > this.s.units) return this.rejectWith("over_budget", `only ${this.margin} sats of margin are posted`);
      const im = initialMargin(this.f, this.config, this.s.lots, this.s.pset);
      if ((this.s.units - units) * u < im) return this.rejectWith("below_minimum", `the short needs ${im} sats of initial margin at the last settled mark`);
    }
    this.s.units += dir === "deposit" ? units : -units;
    const fee = lnFee(this.config, n);
    this.s.costs.lightning += fee;
    this.s.moved = true;
    this.s.counts.margin_moves += 1;
    this.log.push(`${this.s.t} ${dir} ${n}`);
    return accept({ [dir]: n, margin_sats: this.margin, lightning_fee_sats: fee });
  }

  private refresh(): StepResult {
    const s = this.s;
    if (s.slot + 1 >= this.config.slots_per_step) return this.rejectWith("phase_closed", `only ${this.config.slots_per_step} slots a step; wait for the next step`);
    s.slot += 1;
    this.log.push(`${s.t}.${s.slot} refresh`);
    return accept({ slot: s.slot, packet: this.f.packets[s.t]![s.slot]!.packet as unknown as Json });
  }

  private take(args: Record<string, unknown>): StepResult {
    const f = this.f;
    const c = this.config;
    const s = this.s;
    const side = args.side;
    const tier = args.tier === undefined ? "standard" : args.tier;
    const lots = args.lots;
    if (side !== "sell" && side !== "buy") return this.rejectWith("malformed", "side must be sell (add to the short) or buy (reduce it)");
    if (typeof tier !== "string" || !(TIERS as readonly string[]).includes(tier)) return this.rejectWith("malformed", `tier must be one of ${TIERS.join(", ")}`);
    if (typeof lots !== "number" || !Number.isInteger(lots) || lots < 1) return this.rejectWith("not_integer", "lots must be a whole number of at least 1");
    if (s.took) return this.rejectWith("duplicate", "one take per step");
    const kind = f.packets[s.t]![s.slot]!.kind;
    if (!tradeable(kind)) return this.rejectWith("phase_closed", kind === "hold" ? "the mark is HOLD: the venue refuses takes" : "no packet this step: the venue refuses takes");
    const after = side === "sell" ? s.lots + lots : s.lots - lots;
    if (after < 0 || after > c.max_lots) return this.rejectWith("out_of_grid", `the short must stay between 0 and ${c.max_lots} lots`);
    if (side === "sell") {
      const im = initialMargin(f, c, after, s.pset);
      if (this.margin < im) return this.rejectWith("below_minimum", `a short of ${after} lots needs ${im} sats of initial margin`);
    }
    const o = takeOutcome(f, c, s.t, s.slot, side, lots, tier as Tier);
    if (o === null) return this.rejectWith("over_budget", "the ladder is not that deep");
    s.took = true;
    s.counts.takes += 1;
    if (!o.filled) {
      s.counts.unfilled_takes += 1;
      this.log.push(`${s.t}.${s.slot} take ${side} ${lots} ${tier} unfilled`);
      return accept({ filled: false, detail: "no counterparty filled the order" });
    }
    s.lots = after;
    s.costs.execution += o.execution;
    s.costs.taker_fees += o.taker_fee;
    s.costs.lightning += o.lightning;
    if (tier === "premium") s.counts.premium_takes += 1;
    if (o.rogue) s.counts.rogue_fills += 1;
    this.log.push(`${s.t}.${s.slot} take ${side} ${lots} ${tier}`);
    return accept({ filled: true, side, lots, tier, fills: o.fills as unknown as Json, execution_cost_sats: o.execution, taker_fee_sats: o.taker_fee, lightning_fee_sats: o.lightning, short_lots: s.lots });
  }

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (!isObject(action) || typeof action.tool !== "string") return this.rejectWith("malformed", 'an action is {"tool": name, "args": {...}}');
    const args = action.args === undefined ? {} : action.args;
    if (!isObject(args)) return this.rejectWith("malformed", "args must be an object");
    if (!(TOOLS as readonly string[]).includes(action.tool)) return this.rejectWith("unknown_tool", `tools are: ${TOOLS.join(", ")}`);
    let result: StepResult;
    switch (action.tool) {
      case "deposit": case "withdraw": result = this.transfer(action.tool, args); break;
      case "take": result = this.take(args); break;
      case "refresh": result = this.refresh(); break;
      case "wait": return accept(this.advance());
      default: this.close(); return accept({ committed_at_step: this.s.t, short_lots: this.s.lots, margin_sats: this.margin });
    }
    if (!result.accepted) return result;
    this.probes -= 1;
    if (this.probes <= 0) this.close();
    return result;
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    while (this.s.t < this.f.steps) this.advance();
    const c = this.s.costs;
    const total = c.tracking + c.execution + c.taker_fees + c.lightning + c.capital + c.penalties;
    return {
      value: -total,
      metrics: {
        tracking_sats: c.tracking, execution_sats: c.execution, taker_fee_sats: c.taker_fees, lightning_fee_sats: c.lightning,
        capital_sats: c.capital, penalty_sats: c.penalties, ...this.s.counts,
        final_short_lots: this.s.lots, final_margin_sats: this.margin,
      },
    };
  }

  snapshot(): string { return canonical({ s: this.s, closed: this.closed, log: this.log }); }

  privileged(): Json { return this.f as unknown as Json; }
}

