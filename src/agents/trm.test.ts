// The TRM gate: the parameter count of the paper's configuration, exact gradients against central
// differences, a nonlinear toy it must fit, and the determinism and serialization that let its weights
// be bound into an agent id.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stream } from "../harness/prng.ts";
import { Trm, paramCount, train, type TrmRow } from "./trm.ts";

/** XOR of the signs of the first two features; the remaining `noise` features carry no signal. */
function xorRows(n: number, noise: number, label: string): TrmRow[] {
  const rng = stream("trm-test", label);
  const rows: TrmRow[] = [];
  for (let i = 0; i < n; i++) {
    const a = rng.next() < 0.5 ? -1 : 1;
    const b = rng.next() < 0.5 ? -1 : 1;
    const x = [a * (0.5 + rng.next()), b * (0.5 + rng.next())];
    for (let j = 0; j < noise; j++) x.push(rng.normal());
    rows.push({ x, y: a * b > 0 ? 1 : 0 });
  }
  return rows;
}

const fit = (seed: number) => train(xorRows(64, 4, "train"), xorRows(32, 4, "val"), { seed, state: 16, steps: 3, checkpoints: [100, 200, 300] });

test("the paper's configuration has 9,604 parameters", () => {
  assert.equal(paramCount({ nIn: 16, k: 4, state: 64, steps: 4 }), 9604);
  const model = Trm.init({ nIn: 16, k: 4 }, 0);
  assert.equal(model.params.length, 9604);
  assert.deepEqual(model.config, { nIn: 16, k: 4, state: 64, steps: 4 });
});

test("init is Glorot-uniform with zero biases, from the seed alone", () => {
  const a = Trm.init({ nIn: 16, k: 4 }, 7);
  assert.deepEqual(a.params, Trm.init({ nIn: 16, k: 4 }, 7).params);
  assert.notDeepEqual(a.params, Trm.init({ nIn: 16, k: 4 }, 8).params);
  const w = a.toJson().weights;
  assert.ok(w.b_in.every((v) => v === 0) && w.b_u.every((v) => v === 0) && w.b_a.every((v) => v === 0));
  assert.ok(w.w_in.every((v) => Math.abs(v) <= Math.sqrt(6 / (16 + 64))));
  assert.ok(w.w_u.every((v) => Math.abs(v) <= Math.sqrt(6 / (128 + 64))));
  assert.ok(w.w_a.every((v) => Math.abs(v) <= Math.sqrt(6 / (64 + 4))));
  assert.ok(w.w_u.some((v) => v !== 0));
});

test("the analytic gradient matches central differences within 1e-5 relative", () => {
  const rng = stream("trm-test", "gradcheck");
  const base = Trm.init({ nIn: 3, k: 2, state: 5, steps: 3 }, 1);
  // Random weights and biases (the zero-bias init would leave the bias gradients unprobed) and a non-trivial standardization.
  const model = new Trm(base.config, Float64Array.from(base.params, () => 0.7 * rng.normal()), [0.3, -0.2, 0.5], [1.5, 0.8, 2]);
  const rows: TrmRow[] = Array.from({ length: 6 }, (_, i) => ({
    x: [rng.normal(), rng.normal(), rng.normal()], y: i % 2, w: 0.5 + rng.next(),
  }));
  const { loss, grad } = model.lossAndGrad(rows);
  assert.equal(loss, model.loss(rows));
  const h = 1e-5;
  for (let i = 0; i < model.params.length; i++) {
    const saved = model.params[i]!;
    model.params[i] = saved + h;
    const up = model.loss(rows);
    model.params[i] = saved - h;
    const down = model.loss(rows);
    model.params[i] = saved;
    const numeric = (up - down) / (2 * h);
    assert.ok(Math.abs(grad[i]! - numeric) <= 1e-5 * Math.max(Math.abs(grad[i]!), Math.abs(numeric)) + 1e-9,
      `parameter ${i}: analytic ${grad[i]}, numeric ${numeric}`);
  }
});

test("a zero-weight row changes neither the loss nor the gradient", () => {
  const model = Trm.init({ nIn: 3, k: 3, state: 4, steps: 2 }, 3);
  const rows: TrmRow[] = [{ x: [1, 2, 3], y: 0 }, { x: [-1, 0, 2], y: 2, w: 2 }];
  const a = model.lossAndGrad(rows);
  const b = model.lossAndGrad([...rows, { x: [5, 5, 5], y: 1, w: 0 }]);
  assert.equal(a.loss, b.loss);
  assert.deepEqual(a.grad, b.grad);
});

test("it fits XOR with noise features to 100% train accuracy", () => {
  const rows = xorRows(64, 4, "train");
  const result = fit(0);
  assert.equal(result.model.accuracy(rows), 1);
  assert.equal(result.valAccuracy, result.model.accuracy(xorRows(32, 4, "val")));
  assert.deepEqual(result.history.map((h) => h.step), [100, 200, 300]);
  assert.ok(result.history[2]!.trainLoss < result.history[0]!.trainLoss);
  // The checkpoint kept is the first one with the best validation accuracy.
  const top = Math.max(...result.history.map((h) => h.valAccuracy));
  assert.equal(result.step, result.history.find((h) => h.valAccuracy === top)!.step);
});

test("standardization is fitted on the training rows and a constant feature stays finite", () => {
  const rows: TrmRow[] = [{ x: [1, 4], y: 0 }, { x: [3, 4], y: 1 }];
  const model = Trm.init({ nIn: 2, k: 2, state: 4, steps: 2 }, 0).withStandardization(rows);
  assert.deepEqual(Array.from(model.mean), [2, 4]);
  assert.deepEqual(Array.from(model.std), [1, 1e-6]);
  assert.ok(model.logits([2, 4]).every(Number.isFinite));
  assert.throws(() => model.predict([1]), /expected 2 features/);
  assert.throws(() => model.predict([1, NaN]), /non-finite/);
});

test("probabilities sum to 1 and predict is their argmax, ties to the lowest index", () => {
  const model = Trm.init({ nIn: 2, k: 3, state: 4, steps: 2 }, 5);
  const x = [0.4, -1.2];
  const probs = model.probabilities(x);
  assert.ok(Math.abs(probs.reduce((s, v) => s + v, 0) - 1) < 1e-12);
  assert.equal(model.predict(x), probs.indexOf(Math.max(...probs)));
  const flat = new Trm(model.config, new Float64Array(model.params.length));
  assert.equal(flat.predict(x), 0);
  assert.deepEqual(flat.probabilities(x), [1 / 3, 1 / 3, 1 / 3]);
});

test("the same seed and data give byte-identical JSON; another seed does not", () => {
  const a = fit(11);
  const b = fit(11);
  assert.equal(JSON.stringify(a.model.toJson()), JSON.stringify(b.model.toJson()));
  assert.equal(a.model.digest(), b.model.digest());
  assert.match(a.model.digest(), /^[0-9a-f]{64}$/);
  assert.notEqual(a.model.digest(), fit(12).model.digest());
});

test("JSON round trip predicts identically and keeps the digest", () => {
  const model = fit(2).model;
  const back = Trm.fromJson(JSON.parse(JSON.stringify(model.toJson())));
  assert.equal(back.digest(), model.digest());
  for (const r of xorRows(40, 4, "probe")) {
    assert.equal(back.predict(r.x), model.predict(r.x));
    assert.deepEqual(back.probabilities(r.x), model.probabilities(r.x));
  }
  const bad = model.toJson();
  bad.weights.w_a.pop();
  assert.throws(() => Trm.fromJson(bad), /w_a/);
  assert.throws(() => Trm.fromJson({ kind: "other" }), /not a TRM model/);
});
