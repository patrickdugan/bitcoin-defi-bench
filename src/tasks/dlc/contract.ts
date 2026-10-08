// Family 10's contract (docs/tasks.md §11): a single-oracle numeric DLC on the BTC/USD price in
// which the offerer holds a fixed number of dollars. The offerer's payout at price x is
// notional × 10^8 / x sats, the hyperbola piece of PayoutCurve.md with a = 1, b = c = 0, no
// translation, and d = notional × 10^8; it is rounded by the rounding intervals and clamped to
// [0, total collateral] as NumericOutcome.md specifies, and outcome 0 pays the total collateral.
// The operator chooses the total collateral and the rounding intervals. Both choices are scored in
// sats by their expected cost under a stated price forecast.
//
// Everything here is exact integer arithmetic on the curve (the specification's validation
// tolerates a rounding of one modulus either way, which exact evaluation never needs) and runs in
// time proportional to the number of constant-payout runs, not the number of outcomes, except the
// expected tracking error, which is a sum over outcomes with forecast mass.

import { binaryPrefixCount } from "./digits.ts";

export interface Forecast {
  spot_usd: number;
  annual_volatility: number;
  days: number;
}

export interface Contract {
  num_digits: number;
  notional_usd: number;
  forecast: Forecast;
  capital_rate_annual: number;
  sats_per_cet: number;
}

export interface RoundingInterval { begin_interval: number; rounding_mod: number; }

export interface Design { collateral_sats: number; rounding_intervals: RoundingInterval[]; }

export interface Costs {
  cets: number;
  capital_sats: number;
  shortfall_sats: number;
  tracking_sats: number;
  signing_sats: number;
  total_sats: number;
}

const SATS_PER_BTC = 100_000_000;

/** floor(a / b) for non-negative integers whose quotient times b stays below 2^53. */
export function floorDiv(a: number, b: number): number {
  let f = Math.floor(a / b);
  if (f * b > a) f -= 1;
  else if ((f + 1) * b <= a) f += 1;
  return f;
}

/**
 * The model: the forecast's probability of each outcome, and prefix sums for the shortfall. The
 * price at maturity is lognormal with zero drift: ln X ~ N(ln spot − s²/2, s²), s = σ √(days/365).
 * Each integer outcome x ≥ 1 gets the density at x, normalized over the oracle's domain; outcome 0
 * gets none. The generator keeps the oracle's maximum at least 5.5 standard deviations above the
 * spot, so the mass the oracle would attest as its maximum is below 10⁻⁷ and is renormalized away.
 */
export class Model {
  readonly contract: Contract;
  readonly maxOutcome: number;
  readonly d: number;
  readonly p: Float64Array;
  /** Outcomes with non-zero mass lie in [lo, hi]. */
  readonly lo: number;
  readonly hi: number;
  private readonly cumP: Float64Array;
  private readonly cumPayout: Float64Array;

  constructor(contract: Contract) {
    this.contract = contract;
    this.maxOutcome = 2 ** contract.num_digits - 1;
    this.d = contract.notional_usd * SATS_PER_BTC;
    if (!Number.isInteger(this.d) || 2 * this.d >= 2 ** 52) throw new Error("notional out of the exact range");
    const s = contract.forecast.annual_volatility * Math.sqrt(contract.forecast.days / 365);
    const mu = Math.log(contract.forecast.spot_usd) - (s * s) / 2;
    const p = new Float64Array(this.maxOutcome + 1);
    let total = 0;
    let lo = this.maxOutcome + 1;
    let hi = 0;
    for (let x = 1; x <= this.maxOutcome; x++) {
      const z = (Math.log(x) - mu) / s;
      const w = Math.exp(-0.5 * z * z) / x;
      p[x] = w;
      total += w;
      if (w > 0) { if (x < lo) lo = x; hi = x; }
    }
    for (let x = 1; x <= this.maxOutcome; x++) p[x] = p[x]! / total;
    this.p = p;
    this.lo = lo;
    this.hi = hi;
    this.cumP = new Float64Array(this.maxOutcome + 1);
    this.cumPayout = new Float64Array(this.maxOutcome + 1);
    for (let x = 1; x <= this.maxOutcome; x++) {
      this.cumP[x] = this.cumP[x - 1]! + p[x]!;
      this.cumPayout[x] = this.cumPayout[x - 1]! + p[x]! * (this.d / x);
    }
  }

  /** P(X ≤ x). */
  cdf(x: number): number { return x <= 0 ? 0 : this.cumP[Math.min(x, this.maxOutcome)]!; }

  /**
   * The offerer funds its dollars at spot, ceil(d / spot) sats, whatever the design; the accepter
   * funds the rest of the total collateral. That rest is the capital the design adds, and it is
   * priced at the cell's rate for the contract's life. The offerer's part is locked by every design
   * alike and is left out, so that it does not dilute the comparison.
   */
  get offererCollateral(): number { return Math.ceil(this.d / this.contract.forecast.spot_usd); }

  capital(collateral: number): number {
    return Math.max(0, collateral - this.offererCollateral) * this.contract.capital_rate_annual * this.contract.forecast.days / 365;
  }

  /** Expected payout the offerer is owed above the collateral: E[(d/X − C)⁺]. */
  shortfall(collateral: number): number {
    // d/x > C exactly when x < d/C, so for x ≤ floor((d − 1)/C).
    const xc = Math.min(this.maxOutcome, floorDiv(this.d - 1, collateral));
    if (xc < 1) return 0;
    return Math.max(0, this.cumPayout[xc]! - collateral * this.cumP[xc]!);
  }

  /** The modified payout at x with modulus m: round(d/x) to the nearest multiple of m, ties up, clamped. */
  value(x: number, m: number, collateral: number): number {
    if (x === 0) return collateral;
    const q = floorDiv(2 * this.d + m * x, 2 * m * x);
    return Math.min(q * m, collateral);
  }

  /** The last outcome at or after x with the same modified payout, assuming one modulus throughout. */
  runEnd(x: number, m: number, collateral: number, v: number): number {
    if (v >= collateral) {
      // Clamped: round(d/x') ≥ C while q(x') ≥ ceil(C/m), i.e. x' ≤ 2d / ((2·ceil(C/m) − 1)·m).
      const qc = Math.ceil(collateral / m);
      return floorDiv(2 * this.d, (2 * qc - 1) * m);
    }
    const q0 = v / m;
    if (q0 === 0) return this.maxOutcome;
    return floorDiv(2 * this.d, (2 * q0 - 1) * m);
  }
}

export interface Run { start: number; end: number; payout: number; }

/** One segment with one modulus: its first and last runs, the CETs of the runs between them, and its expected tracking error. */
export interface Summary {
  first: Run;
  last: Run;
  single: boolean;
  interior: number;
  tracking: number;
}

export function summarize(model: Model, x0: number, x1: number, m: number, collateral: number): Summary {
  const n = model.contract.num_digits;
  let first: Run | null = null;
  let prev: Run | null = null;
  let interior = 0;
  let runs = 0;
  for (let x = x0; x <= x1;) {
    const v = model.value(x, m, collateral);
    const end = Math.min(x1, Math.max(x, x === 0 && v >= collateral ? model.runEnd(1, m, collateral, v) : model.runEnd(x, m, collateral, v)));
    const run = { start: x, end, payout: v };
    if (first === null) first = run;
    else if (prev !== null && prev !== first) interior += binaryPrefixCount(prev.start, prev.end, n);
    prev = run;
    runs += 1;
    x = end + 1;
  }
  // Tracking error: |modified payout − min(d/x, C)|, weighted by the forecast.
  let tracking = 0;
  const lo = Math.max(x0, model.lo, 1);
  const hi = Math.min(x1, model.hi);
  for (let x = lo; x <= hi; x++) {
    const px = model.p[x]!;
    if (px === 0) continue;
    const exact = Math.min(model.d / x, collateral);
    tracking += px * Math.abs(model.value(x, m, collateral) - exact);
  }
  return { first: first!, last: prev!, single: runs === 1, interior, tracking };
}

/** The CETs of one closed run; a contract whose whole domain is one run is not a DLC. */
function closeRun(model: Model, start: number, end: number): number {
  if (start === 0 && end === model.maxOutcome) return Number.POSITIVE_INFINITY;
  return binaryPrefixCount(start, end, model.contract.num_digits);
}

interface Open { payout: number; start: number; }

/** Fold one segment into the open run; returns the CETs closed and the new open run. */
function advance(model: Model, open: Open | null, x0: number, s: Summary): { cets: number; open: Open } {
  let cets = 0;
  let start = s.first.start;
  if (open !== null && open.payout === s.first.payout) start = open.start;
  else if (open !== null) cets += closeRun(model, open.start, x0 - 1);
  if (s.single) return { cets, open: { payout: s.first.payout, start } };
  cets += closeRun(model, start, s.first.end) + s.interior;
  return { cets, open: { payout: s.last.payout, start: s.last.start } };
}

/** Segments of a design: [0, first begin) at modulus 1 if the first interval begins above 0. */
export function segmentsOf(model: Model, intervals: readonly RoundingInterval[]): Array<{ x0: number; x1: number; m: number }> {
  const segs: Array<{ x0: number; x1: number; m: number }> = [];
  if (intervals.length === 0 || intervals[0]!.begin_interval > 0) segs.push({ x0: 0, x1: intervals.length === 0 ? model.maxOutcome : intervals[0]!.begin_interval - 1, m: 1 });
  intervals.forEach((r, i) => {
    const x1 = i + 1 < intervals.length ? intervals[i + 1]!.begin_interval - 1 : model.maxOutcome;
    if (r.begin_interval <= model.maxOutcome) segs.push({ x0: r.begin_interval, x1: Math.min(x1, model.maxOutcome), m: r.rounding_mod });
  });
  return segs;
}

/** Expected costs of a design, exactly as the CET calculation of NumericOutcome.md would build it. */
export function evaluateDesign(model: Model, design: Design): Costs {
  const C = design.collateral_sats;
  let open: Open | null = null;
  let cets = 0;
  let tracking = 0;
  for (const seg of segmentsOf(model, design.rounding_intervals)) {
    const s = summarize(model, seg.x0, seg.x1, seg.m, C);
    const step = advance(model, open, seg.x0, s);
    cets += step.cets;
    open = step.open;
    tracking += s.tracking;
  }
  cets += closeRun(model, open!.start, model.maxOutcome);
  return costsOf(model, C, cets, tracking);
}

export function costsOf(model: Model, collateral: number, cets: number, tracking: number): Costs {
  const capital = model.capital(collateral);
  const shortfall = model.shortfall(collateral);
  const signing = cets * model.contract.sats_per_cet;
  return { cets, capital_sats: capital, shortfall_sats: shortfall, tracking_sats: tracking, signing_sats: signing, total_sats: capital + shortfall + tracking + signing };
}

/** The menus an agent chooses from: interval beginnings, moduli, and collateral levels. */
export interface Menu {
  /** Allowed `begin_interval` values, ascending, starting at 0. */
  breakpoints: number[];
  rounding_mods: number[];
  collateral_options: number[];
}

/**
 * The exact optimum over the menu. For each collateral level, a dynamic program over the regions
 * between breakpoints, one modulus each, whose state is the run left open at the region's end
 * (its payout and where it began): the only thing a later region's CET count depends on. Exact
 * because the cost is a sum over regions given that state. Returns the design with the
 * intervals merged where neighbouring regions share a modulus.
 */
export function optimize(model: Model, menu: Menu): { design: Design; costs: Costs } {
  const regions = menu.breakpoints.map((b, i) => ({ x0: b, x1: i + 1 < menu.breakpoints.length ? menu.breakpoints[i + 1]! - 1 : model.maxOutcome }));
  // A region's summary depends on the collateral only if the curve reaches the collateral in it.
  const free = new Map<string, Summary>();
  const summaryFor = (r: number, m: number, C: number): Summary => {
    const { x0, x1 } = regions[r]!;
    const first = x0 === 0 ? Number.POSITIVE_INFINITY : model.d / x0;
    if (first < C - m) {
      const key = `${r}|${m}`;
      let s = free.get(key);
      if (!s) { s = summarize(model, x0, x1, m, Number.MAX_SAFE_INTEGER); free.set(key, s); }
      return s;
    }
    return summarize(model, x0, x1, m, C);
  };
  let best: { design: Design; costs: Costs } | null = null;
  for (const C of menu.collateral_options) {
    type State = { cost: number; cets: number; tracking: number; open: Open | null; mods: number[] };
    let states = new Map<string, State>([["", { cost: 0, cets: 0, tracking: 0, open: null, mods: [] }]]);
    for (let r = 0; r < regions.length; r++) {
      const next = new Map<string, State>();
      for (const st of states.values()) {
        for (const m of menu.rounding_mods) {
          const s = summaryFor(r, m, C);
          const step = advance(model, st.open, regions[r]!.x0, s);
          const cets = st.cets + step.cets;
          const tracking = st.tracking + s.tracking;
          const cost = cets * model.contract.sats_per_cet + tracking;
          const key = `${step.open.payout}|${step.open.start}`;
          const have = next.get(key);
          if (!have || cost < have.cost) next.set(key, { cost, cets, tracking, open: step.open, mods: [...st.mods, m] });
        }
      }
      states = next;
    }
    for (const st of states.values()) {
      const cets = st.cets + closeRun(model, st.open!.start, model.maxOutcome);
      const costs = costsOf(model, C, cets, st.tracking);
      if (best === null || costs.total_sats < best.costs.total_sats) {
        const intervals: RoundingInterval[] = [];
        st.mods.forEach((m, r) => { if (intervals.length === 0 || intervals[intervals.length - 1]!.rounding_mod !== m) intervals.push({ begin_interval: regions[r]!.x0, rounding_mod: m }); });
        best = { design: { collateral_sats: C, rounding_intervals: intervals }, costs };
      }
    }
  }
  return best!;
}
