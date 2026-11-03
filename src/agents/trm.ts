// The TRM gate: a tiny recursive policy network and its trainer. The shape is the TinyRecursivePolicy
// of Dugan, "MeTTa-Scaffolded Repair Curricula for TRM-Infused Hermes Skills" (2026): an input
// projection, one recurrent update on the input projection and the state applied `steps` times, and an
// action head. Plain TypeScript with exact backprop through the recurrence and full-batch AdamW; the
// initial weights are a function of an integer seed alone. A trained model serializes to plain JSON,
// and the sha256 of its canonical form is what binds the weights into an agent id.

import { canonical, isObject, sha256 } from "../harness/json.ts";
import { stream } from "../harness/prng.ts";

export interface TrmConfig {
  /** Input features. */
  nIn: number;
  /** Actions. */
  k: number;
  /** State width. */
  state: number;
  /** Recurrent updates per forward pass. */
  steps: number;
}

/** A labeled row; `w` is its loss weight (default 1). */
export interface TrmRow {
  x: readonly number[];
  y: number;
  w?: number;
}

export interface TrmJson {
  kind: "trm";
  config: { n_in: number; k: number; state: number; steps: number };
  standardization: { mean: number[]; std: number[] };
  weights: { w_in: number[]; b_in: number[]; w_u: number[]; b_u: number[]; w_a: number[]; b_a: number[] };
}

export interface TrmTrainOptions {
  seed?: number;
  /** Action count; default one more than the largest label in the rows. */
  k?: number;
  state?: number;
  steps?: number;
  lr?: number;
  betas?: readonly [number, number];
  eps?: number;
  /** Decoupled decay on weight matrices; biases are exempt. */
  weightDecay?: number;
  /** Step counts at which the model is scored on the validation rows; the best is kept. */
  checkpoints?: readonly number[];
}

export interface TrmHistory {
  step: number;
  trainLoss: number;
  valAccuracy: number;
}

export interface TrmFit {
  /** The checkpoint with the best validation accuracy (earliest on a tie). */
  model: Trm;
  step: number;
  valAccuracy: number;
  history: TrmHistory[];
}

export const STATE_WIDTH = 64;
export const RECURRENT_STEPS = 4;
const STD_FLOOR = 1e-6;

/** Offsets of each block in the flat parameter vector, in storage order. */
function layout(c: TrmConfig) {
  const d = c.state;
  const wIn = 0;
  const bIn = wIn + d * c.nIn;
  const wU = bIn + d;
  const bU = wU + d * 2 * d;
  const wA = bU + d;
  const bA = wA + c.k * d;
  return { wIn, bIn, wU, bU, wA, bA, total: bA + c.k };
}

/** n_in*d + d + 2d*d + d + k*d + k. */
export function paramCount(config: TrmConfig): number {
  return layout(config).total;
}

function checkConfig(c: TrmConfig): void {
  for (const key of ["nIn", "k", "state", "steps"] as const) {
    if (!Number.isInteger(c[key]) || c[key] < 1) throw new Error(`trm: ${key} must be a positive integer`);
  }
}

/** z = (x - mean) / std into `z`. */
function standardize(model: Trm, x: readonly number[], z: Float64Array): void {
  const n = model.config.nIn;
  if (x.length !== n) throw new Error(`trm: expected ${n} features, got ${x.length}`);
  for (let j = 0; j < n; j++) {
    const v = x[j]!;
    if (!Number.isFinite(v)) throw new Error("trm: non-finite feature");
    z[j] = (v - model.mean[j]!) / model.std[j]!;
  }
}

/** h and the states s_0..s_steps (row t of `S`), then the logits. */
function forward(c: TrmConfig, p: Float64Array, z: Float64Array, h: Float64Array, S: Float64Array, logits: Float64Array): void {
  const { nIn, k, state: d, steps } = c;
  const L = layout(c);
  for (let i = 0; i < d; i++) {
    let a = p[L.bIn + i]!;
    const o = L.wIn + i * nIn;
    for (let j = 0; j < nIn; j++) a += p[o + j]! * z[j]!;
    h[i] = Math.tanh(a);
  }
  S.fill(0, 0, d);
  for (let t = 1; t <= steps; t++) {
    const prev = (t - 1) * d;
    const cur = t * d;
    for (let i = 0; i < d; i++) {
      let a = p[L.bU + i]!;
      const o = L.wU + i * 2 * d;
      for (let j = 0; j < d; j++) a += p[o + j]! * h[j]!;
      for (let j = 0; j < d; j++) a += p[o + d + j]! * S[prev + j]!;
      S[cur + i] = Math.tanh(a);
    }
  }
  const last = steps * d;
  for (let a = 0; a < k; a++) {
    let v = p[L.bA + a]!;
    const o = L.wA + a * d;
    for (let j = 0; j < d; j++) v += p[o + j]! * S[last + j]!;
    logits[a] = v;
  }
}

/** Softmax of `logits` into `probs`; returns log-sum-exp. */
function softmax(logits: Float64Array, probs: Float64Array): number {
  let m = -Infinity;
  for (let a = 0; a < logits.length; a++) if (logits[a]! > m) m = logits[a]!;
  let sum = 0;
  for (let a = 0; a < logits.length; a++) {
    probs[a] = Math.exp(logits[a]! - m);
    sum += probs[a]!;
  }
  for (let a = 0; a < logits.length; a++) probs[a] = probs[a]! / sum;
  return m + Math.log(sum);
}

/**
 * Weighted mean cross-entropy over `rows`. When `grad` is given it is zeroed and filled with the exact
 * gradient of that loss by backprop through the recurrent steps.
 */
function lossGrad(model: Trm, rows: readonly TrmRow[], grad: Float64Array | null): number {
  const c = model.config;
  const { nIn, k, state: d, steps } = c;
  const L = layout(c);
  const p = model.params;
  const z = new Float64Array(nIn);
  const h = new Float64Array(d);
  const S = new Float64Array((steps + 1) * d);
  const logits = new Float64Array(k);
  const probs = new Float64Array(k);
  let ds = new Float64Array(d);
  let dsPrev = new Float64Array(d);
  const dh = new Float64Array(d);
  const da = new Float64Array(d);
  let totalWeight = 0;
  for (const r of rows) {
    const w = r.w ?? 1;
    if (!Number.isFinite(w) || w < 0) throw new Error("trm: row weight must be finite and non-negative");
    totalWeight += w;
  }
  if (!(totalWeight > 0)) throw new Error("trm: rows carry no weight");
  if (grad) grad.fill(0);
  let loss = 0;
  for (const r of rows) {
    if (!Number.isInteger(r.y) || r.y < 0 || r.y >= k) throw new Error(`trm: label ${r.y} outside [0, ${k})`);
    const w = r.w ?? 1;
    standardize(model, r.x, z);
    forward(c, p, z, h, S, logits);
    const lse = softmax(logits, probs);
    loss += w * (lse - logits[r.y]!);
    if (!grad || w === 0) continue;
    const scale = w / totalWeight;
    const last = steps * d;
    ds.fill(0);
    for (let a = 0; a < k; a++) {
      const dl = (probs[a]! - (a === r.y ? 1 : 0)) * scale;
      grad[L.bA + a]! += dl;
      const o = L.wA + a * d;
      for (let j = 0; j < d; j++) {
        grad[o + j]! += dl * S[last + j]!;
        ds[j]! += p[o + j]! * dl;
      }
    }
    dh.fill(0);
    for (let t = steps; t >= 1; t--) {
      const cur = t * d;
      const prev = (t - 1) * d;
      for (let i = 0; i < d; i++) da[i] = ds[i]! * (1 - S[cur + i]! * S[cur + i]!);
      dsPrev.fill(0);
      for (let i = 0; i < d; i++) {
        const g = da[i]!;
        grad[L.bU + i]! += g;
        const o = L.wU + i * 2 * d;
        for (let j = 0; j < d; j++) {
          grad[o + j]! += g * h[j]!;
          dh[j]! += p[o + j]! * g;
          grad[o + d + j]! += g * S[prev + j]!;
          dsPrev[j]! += p[o + d + j]! * g;
        }
      }
      const swap = ds;
      ds = dsPrev;
      dsPrev = swap;
    }
    for (let i = 0; i < d; i++) {
      const g = dh[i]! * (1 - h[i]! * h[i]!);
      grad[L.bIn + i]! += g;
      const o = L.wIn + i * nIn;
      for (let j = 0; j < nIn; j++) grad[o + j]! += g * z[j]!;
    }
  }
  return loss / totalWeight;
}

export class Trm {
  readonly config: TrmConfig;
  /** Per-feature standardization, applied to every input. */
  readonly mean: Float64Array;
  readonly std: Float64Array;
  /** Flat parameters: W_in, b_in, W_u, b_u, W_a, b_a, each row-major. */
  readonly params: Float64Array;

  constructor(config: TrmConfig, params: Float64Array, mean?: ArrayLike<number>, std?: ArrayLike<number>) {
    checkConfig(config);
    if (params.length !== paramCount(config)) throw new Error(`trm: expected ${paramCount(config)} parameters, got ${params.length}`);
    this.config = { nIn: config.nIn, k: config.k, state: config.state, steps: config.steps };
    this.params = params;
    this.mean = Float64Array.from(mean ?? new Float64Array(config.nIn));
    this.std = Float64Array.from(std ?? new Float64Array(config.nIn).fill(1));
    if (this.mean.length !== config.nIn || this.std.length !== config.nIn) throw new Error("trm: standardization length is not n_in");
    for (const s of this.std) if (!(s > 0)) throw new Error("trm: std must be positive");
  }

  /** Glorot-uniform weights and zero biases from the stream ("trm", seed); identity standardization. */
  static init(config: Pick<TrmConfig, "nIn" | "k"> & Partial<TrmConfig>, seed: number): Trm {
    const c: TrmConfig = { nIn: config.nIn, k: config.k, state: config.state ?? STATE_WIDTH, steps: config.steps ?? RECURRENT_STEPS };
    checkConfig(c);
    if (!Number.isInteger(seed)) throw new Error("trm: seed must be an integer");
    const rng = stream("trm", seed);
    const L = layout(c);
    const params = new Float64Array(L.total);
    const glorot = (from: number, to: number, fanIn: number, fanOut: number): void => {
      const limit = Math.sqrt(6 / (fanIn + fanOut));
      for (let i = from; i < to; i++) params[i] = (2 * rng.next() - 1) * limit;
    };
    glorot(L.wIn, L.bIn, c.nIn, c.state);
    glorot(L.wU, L.bU, 2 * c.state, c.state);
    glorot(L.wA, L.bA, c.state, c.k);
    return new Trm(c, params);
  }

  /** Copy of this model with the standardization fitted to `rows` (population std, floored at 1e-6). */
  withStandardization(rows: readonly TrmRow[]): Trm {
    if (rows.length === 0) throw new Error("trm: no rows to standardize on");
    const n = this.config.nIn;
    const mean = new Float64Array(n);
    const std = new Float64Array(n);
    for (const r of rows) {
      if (r.x.length !== n) throw new Error(`trm: expected ${n} features, got ${r.x.length}`);
      for (let j = 0; j < n; j++) mean[j]! += r.x[j]!;
    }
    for (let j = 0; j < n; j++) mean[j] = mean[j]! / rows.length;
    for (const r of rows) for (let j = 0; j < n; j++) std[j]! += (r.x[j]! - mean[j]!) ** 2;
    for (let j = 0; j < n; j++) std[j] = Math.max(Math.sqrt(std[j]! / rows.length), STD_FLOOR);
    return new Trm(this.config, this.params.slice(), mean, std);
  }

  clone(): Trm {
    return new Trm(this.config, this.params.slice(), this.mean, this.std);
  }

  logits(x: readonly number[]): number[] {
    const { nIn, k, state: d, steps } = this.config;
    const z = new Float64Array(nIn);
    const logits = new Float64Array(k);
    standardize(this, x, z);
    forward(this.config, this.params, z, new Float64Array(d), new Float64Array((steps + 1) * d), logits);
    return Array.from(logits);
  }

  probabilities(x: readonly number[]): number[] {
    const logits = Float64Array.from(this.logits(x));
    const probs = new Float64Array(logits.length);
    softmax(logits, probs);
    return Array.from(probs);
  }

  /** Argmax of the logits; ties go to the lowest index. */
  predict(x: readonly number[]): number {
    const logits = this.logits(x);
    let best = 0;
    for (let a = 1; a < logits.length; a++) if (logits[a]! > logits[best]!) best = a;
    return best;
  }

  accuracy(rows: readonly TrmRow[]): number {
    if (rows.length === 0) throw new Error("trm: no rows to score");
    let right = 0;
    for (const r of rows) if (this.predict(r.x) === r.y) right++;
    return right / rows.length;
  }

  /** Weighted mean softmax cross-entropy. */
  loss(rows: readonly TrmRow[]): number {
    return lossGrad(this, rows, null);
  }

  /** The loss and its exact gradient with respect to `params`. */
  lossAndGrad(rows: readonly TrmRow[]): { loss: number; grad: Float64Array } {
    const grad = new Float64Array(this.params.length);
    return { loss: lossGrad(this, rows, grad), grad };
  }

  toJson(): TrmJson {
    const c = this.config;
    const L = layout(c);
    const block = (from: number, to: number): number[] => Array.from(this.params.subarray(from, to));
    return {
      kind: "trm",
      config: { n_in: c.nIn, k: c.k, state: c.state, steps: c.steps },
      standardization: { mean: Array.from(this.mean), std: Array.from(this.std) },
      weights: {
        w_in: block(L.wIn, L.bIn), b_in: block(L.bIn, L.wU),
        w_u: block(L.wU, L.bU), b_u: block(L.bU, L.wA),
        w_a: block(L.wA, L.bA), b_a: block(L.bA, L.total),
      },
    };
  }

  static fromJson(value: unknown): Trm {
    if (!isObject(value) || value.kind !== "trm" || !isObject(value.config) || !isObject(value.standardization) || !isObject(value.weights)) {
      throw new Error("trm: not a TRM model");
    }
    const cj = value.config;
    const config: TrmConfig = { nIn: cj.n_in as number, k: cj.k as number, state: cj.state as number, steps: cj.steps as number };
    checkConfig(config);
    const L = layout(config);
    const numbers = (v: unknown, n: number, label: string): number[] => {
      if (!Array.isArray(v) || v.length !== n || !v.every((e) => typeof e === "number" && Number.isFinite(e))) {
        throw new Error(`trm: ${label} must be ${n} finite numbers`);
      }
      return v as number[];
    };
    const params = new Float64Array(L.total);
    const w = value.weights;
    params.set(numbers(w.w_in, L.bIn - L.wIn, "w_in"), L.wIn);
    params.set(numbers(w.b_in, L.wU - L.bIn, "b_in"), L.bIn);
    params.set(numbers(w.w_u, L.bU - L.wU, "w_u"), L.wU);
    params.set(numbers(w.b_u, L.wA - L.bU, "b_u"), L.bU);
    params.set(numbers(w.w_a, L.bA - L.wA, "w_a"), L.wA);
    params.set(numbers(w.b_a, L.total - L.bA, "b_a"), L.bA);
    const s = value.standardization;
    return new Trm(config, params, numbers(s.mean, config.nIn, "mean"), numbers(s.std, config.nIn, "std"));
  }

  /** sha256 of the canonical JSON: config, standardization and weights. */
  digest(): string {
    return sha256(canonical(this.toJson()));
  }
}

/**
 * Full-batch AdamW on the training rows from a seeded init, standardization fitted on those rows. The
 * model is scored on the validation rows at each checkpoint step count and the best is returned; the
 * first checkpoint wins a tie.
 */
export function train(trainRows: readonly TrmRow[], valRows: readonly TrmRow[], options: TrmTrainOptions = {}): TrmFit {
  if (trainRows.length === 0) throw new Error("trm: no training rows");
  if (valRows.length === 0) throw new Error("trm: no validation rows");
  const lr = options.lr ?? 5e-3;
  const [beta1, beta2] = options.betas ?? [0.9, 0.999];
  const eps = options.eps ?? 1e-8;
  const weightDecay = options.weightDecay ?? 0.01;
  const checkpoints = [...new Set(options.checkpoints ?? [50, 100, 200, 400])].sort((a, b) => a - b);
  if (checkpoints.length === 0 || checkpoints.some((s) => !Number.isInteger(s) || s < 1)) throw new Error("trm: checkpoints must be positive integers");
  let maxLabel = 0;
  for (const r of [...trainRows, ...valRows]) maxLabel = Math.max(maxLabel, r.y);
  const config = { nIn: trainRows[0]!.x.length, k: options.k ?? maxLabel + 1, state: options.state, steps: options.steps };
  const model = Trm.init(config, options.seed ?? 0).withStandardization(trainRows);
  const L = layout(model.config);
  const p = model.params;
  const m = new Float64Array(p.length);
  const v = new Float64Array(p.length);
  const decays = new Uint8Array(p.length);
  for (const [from, to] of [[L.wIn, L.bIn], [L.wU, L.bU], [L.wA, L.bA]] as const) decays.fill(1, from, to);
  const history: TrmHistory[] = [];
  let best: { model: Trm; step: number; valAccuracy: number } | null = null;
  let corr1 = 1;
  let corr2 = 1;
  const last = checkpoints[checkpoints.length - 1]!;
  let next = 0;
  for (let step = 1; step <= last; step++) {
    const { grad } = model.lossAndGrad(trainRows);
    corr1 *= beta1;
    corr2 *= beta2;
    for (let i = 0; i < p.length; i++) {
      const g = grad[i]!;
      m[i] = beta1 * m[i]! + (1 - beta1) * g;
      v[i] = beta2 * v[i]! + (1 - beta2) * g * g;
      const adam = (m[i]! / (1 - corr1)) / (Math.sqrt(v[i]! / (1 - corr2)) + eps);
      p[i]! -= lr * (adam + (decays[i] ? weightDecay * p[i]! : 0));
    }
    if (step !== checkpoints[next]) continue;
    next++;
    const valAccuracy = model.accuracy(valRows);
    history.push({ step, trainLoss: model.loss(trainRows), valAccuracy });
    if (!best || valAccuracy > best.valAccuracy) best = { model: model.clone(), step, valAccuracy };
  }
  return { model: best!.model, step: best!.step, valAccuracy: best!.valAccuracy, history };
}
