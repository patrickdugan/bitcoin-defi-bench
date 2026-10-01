// Scoring with intervals. The inference unit is the seed cluster, as in Spiral's
// public_topology_analysis.py: two-sided Student-t intervals over cluster means. The audit
// (paper/liquidity_on_trial.md §7) found analysis functions that silently overwrote duplicate
// pairing keys, dropped unmatched pairs, and returned zero-width intervals from a single cluster.
// Each of those is an error here.

export interface Interval {
  n: number;
  mean: number;
  lo: number;
  hi: number;
  critical: number;
}

function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const v of c) s += v / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}

function betacf(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}

function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

export function tCdf(t: number, df: number): number {
  const p = 0.5 * incompleteBeta(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? 1 - p : p;
}

/** Student-t quantile by bisection on the CDF. */
export function tQuantile(p: number, df: number): number {
  if (!(p > 0.5 && p < 1) || !(df >= 1)) throw new Error("tQuantile: need 0.5 < p < 1 and df >= 1");
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Two-sided critical value at family-wise level alpha over `comparisons` Bonferroni comparisons. */
export function critical(clusters: number, alpha = 0.05, comparisons = 1): number {
  if (clusters < 2) throw new Error("an interval needs at least two clusters");
  return tQuantile(1 - alpha / (2 * comparisons), clusters - 1);
}

const mean = (xs: readonly number[]): number => xs.reduce((a, x) => a + x, 0) / xs.length;

/** Student-t interval over cluster means. */
export function clusterInterval(values: readonly number[], alpha = 0.05, comparisons = 1): Interval {
  const n = values.length;
  const crit = critical(n, alpha, comparisons);
  const m = mean(values);
  const variance = values.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1);
  const half = crit * Math.sqrt(variance / n);
  return { n, mean: m, lo: m - half, hi: m + half, critical: crit };
}

export interface ValueRow { seed: number; cell: string; value: number; }

/** Cluster means: the mean of an agent's episode values within each seed. Duplicate (seed, cell) keys throw. */
export function clusterMeans(rows: readonly ValueRow[]): Map<number, number> {
  const seen = new Set<string>();
  const bySeed = new Map<number, number[]>();
  for (const r of rows) {
    const key = `${r.seed}|${r.cell}`;
    if (seen.has(key)) throw new Error(`duplicate episode key ${key}`);
    seen.add(key);
    if (!bySeed.has(r.seed)) bySeed.set(r.seed, []);
    bySeed.get(r.seed)!.push(r.value);
  }
  const out = new Map<number, number>();
  for (const seed of [...bySeed.keys()].sort((a, b) => a - b)) out.set(seed, mean(bySeed.get(seed)!));
  return out;
}

function aligned(a: Map<number, number>, b: Map<number, number>): number[] {
  const seeds = [...a.keys()].sort((x, y) => x - y);
  const other = [...b.keys()].sort((x, y) => x - y);
  if (seeds.length !== other.length || seeds.some((s, i) => s !== other[i])) {
    throw new Error("paired contrast: the two policies were not run on the same seeds");
  }
  return seeds;
}

/** Paired difference a − b over seed clusters. Unmatched seeds throw. */
export function pairedDifference(a: Map<number, number>, b: Map<number, number>, alpha = 0.05, comparisons = 1): Interval {
  const seeds = aligned(a, b);
  return clusterInterval(seeds.map((s) => a.get(s)! - b.get(s)!), alpha, comparisons);
}

export const CLIP: readonly [number, number] = [-1, 1.5];
const clip = (x: number): number => Math.min(CLIP[1], Math.max(CLIP[0], x));

export interface NormalizedGain {
  /** False when oracle − random does not exclude zero: no measurable headroom, gain not reported. */
  defined: boolean;
  gain: number;
  lo: number;
  hi: number;
  /** True when the point estimate or an endpoint was clipped to [−1, 1.5]. */
  clipped: boolean;
  headroom: Interval;
}

/**
 * Normalized gain G = Σ_s (A_s − R_s) / Σ_s (O_s − R_s), clipped to [−1, 1.5]. A ratio of sums,
 * not a mean of per-seed ratios, because one seed's denominator can be zero or negative. The
 * interval is a delete-one-cluster jackknife with the Student-t critical value.
 */
export function normalizedGain(agent: Map<number, number>, random: Map<number, number>, oracle: Map<number, number>, alpha = 0.05): NormalizedGain {
  const seeds = aligned(agent, random);
  aligned(agent, oracle);
  const num = seeds.map((s) => agent.get(s)! - random.get(s)!);
  const den = seeds.map((s) => oracle.get(s)! - random.get(s)!);
  const headroom = clusterInterval(den, alpha);
  if (!(headroom.lo > 0)) return { defined: false, gain: NaN, lo: NaN, hi: NaN, clipped: false, headroom };
  const n = seeds.length;
  const sumNum = num.reduce((a, x) => a + x, 0);
  const sumDen = den.reduce((a, x) => a + x, 0);
  const g = sumNum / sumDen;
  const loo = seeds.map((_, i) => (sumNum - num[i]!) / (sumDen - den[i]!));
  const looMean = mean(loo);
  const se = Math.sqrt(((n - 1) / n) * loo.reduce((a, x) => a + (x - looMean) ** 2, 0));
  const half = critical(n, alpha) * se;
  const raw = [g, g - half, g + half];
  const out = raw.map(clip);
  return { defined: true, gain: out[0]!, lo: out[1]!, hi: out[2]!, clipped: out.some((v, i) => v !== raw[i]), headroom };
}

export interface Verdict { equivalent: boolean; positive: boolean; negative: boolean; }

/** Equivalence needs the whole interval inside the band, on both sides (audit §7). */
export function verdict(interval: Interval, band: number): Verdict {
  return {
    equivalent: interval.lo > -band && interval.hi < band,
    positive: interval.lo > 0,
    negative: interval.hi < 0,
  };
}

export function verdictLabel(v: Verdict): string {
  const parts: string[] = [];
  if (v.positive) parts.push("positive");
  if (v.negative) parts.push("negative");
  if (v.equivalent) parts.push("equivalent");
  return parts.length ? parts.join(", ") : "inconclusive";
}
