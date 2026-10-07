import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, gitBlobId, sha256 } from "./json.ts";
import { ManifestError, loadFixture, modelBlobs, readManifest, verifyFixture, verifyManifest, type Manifest } from "./manifest.ts";
import { cmpSeq, nodeId, pairKey, sortByKeys } from "./order.ts";
import { stream } from "./prng.ts";
import { clusterInterval, clusterMeans, critical, normalizedGain, pairedDifference, tQuantile, verdict } from "./stats.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("canonical serialization does not depend on key or insertion order", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  const m1 = new Map([["x", 1], ["y", 2]]);
  const m2 = new Map([["y", 2], ["x", 1]]);
  assert.equal(canonical(m1), canonical(m2));
  assert.equal(canonical(new Set(["b", "a"])), canonical(new Set(["a", "b"])));
  assert.throws(() => canonical({ x: NaN }), /non-finite/);
});

test("canonical order: endpoints are canonicalized before a key is formed, and a tied sort key is an error", () => {
  assert.equal(pairKey("N010", "N002"), pairKey("N002", "N010"));
  assert.equal(nodeId(7), "N007");
  assert.ok(nodeId(2) < nodeId(10)); // zero-padding keeps lexicographic and numeric order aligned
  assert.ok(cmpSeq(["a", "b"], ["a", "b", "c"]) < 0);
  assert.deepEqual(sortByKeys([{ k: "b", n: 1 }, { k: "a", n: 2 }], (x) => [x.k]).map((x) => x.n), [2, 1]);
  assert.throws(() => sortByKeys([{ k: "a" }, { k: "a" }], (x) => [x.k]), /total order/);
});

test("named streams are deterministic and independent: a draw in one stream cannot shift another", () => {
  const a1 = stream("demand", 7);
  const a2 = stream("demand", 7);
  const b = stream("capacity", 7);
  const first = [a1.next(), a1.next(), a1.next()];
  b.next(); b.next(); // drawing from another stream
  assert.deepEqual([a2.next(), a2.next(), a2.next()], first);
  assert.notEqual(stream("demand", 8).next(), first[0]);
  const xs = Array.from({ length: 2000 }, () => a1.next());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(Math.abs(xs.reduce((s, x) => s + x, 0) / xs.length - 0.5) < 0.03);
});

test("git blob id is independent of the platform's line endings", () => {
  assert.equal(gitBlobId(Buffer.from("a\r\nb\r\n")), gitBlobId(Buffer.from("a\nb\n")));
  // `printf 'a\nb\n' | git hash-object --stdin`
  assert.equal(gitBlobId(Buffer.from("a\nb\n")), "422c2b7ab3b3c668038da977e4e93a5fc623169c");
});

test("Student-t critical values match the published table", () => {
  assert.ok(Math.abs(tQuantile(0.975, 27) - 2.052) < 5e-4); // T_975[27] in Spiral's public_topology_analysis.py
  assert.ok(Math.abs(tQuantile(0.975, 31) - 2.0395) < 5e-4);
  assert.ok(Math.abs(critical(32, 0.05, 4) - 2.6519) < 5e-4); // Bonferroni over four primary contrasts
});

test("intervals refuse the three defects the audit found: single cluster, duplicate keys, unmatched pairs", () => {
  assert.throws(() => clusterInterval([1]), /at least two clusters/);
  assert.throws(() => clusterMeans([{ seed: 1, cell: "a", value: 1 }, { seed: 1, cell: "a", value: 2 }]), /duplicate/);
  const a = new Map([[1, 1], [2, 2]]);
  const b = new Map([[1, 1], [3, 2]]);
  assert.throws(() => pairedDifference(a, b), /same seeds/);
});

test("cluster interval and paired difference on a worked case", () => {
  const i = clusterInterval([1, 2, 3, 4]);
  assert.equal(i.mean, 2.5);
  // sd = sqrt(5/3); half-width = t(0.975, 3) × sd / 2 = 3.1824 × 1.29099 / 2
  assert.ok(Math.abs((i.hi - i.lo) / 2 - 2.0543) < 1e-3);
  const d = pairedDifference(new Map([[1, 5], [2, 7], [3, 9]]), new Map([[1, 4], [2, 5], [3, 6]]));
  assert.equal(d.mean, 2);
});

test("normalized gain is a ratio of sums, is clipped to [−1, 1.5], and is withheld without headroom", () => {
  const seeds = [1, 2, 3, 4, 5, 6];
  const mk = (f: (s: number) => number) => new Map(seeds.map((s) => [s, f(s)]));
  const random = mk((s) => 80 + s);
  const oracle = mk((s) => 90 + s + (s % 2));            // headroom 10 or 11
  const agent = mk((s) => 85 + s + (s % 2) / 2);          // half the headroom
  const g = normalizedGain(agent, random, oracle);
  assert.ok(g.defined);
  assert.ok(Math.abs(g.gain - 0.5) < 1e-9);
  assert.ok(g.lo <= g.gain && g.gain <= g.hi);
  // One seed with a zero denominator would break a mean of per-seed ratios; the ratio of sums is unaffected.
  const oracleZero = new Map(oracle); oracleZero.set(1, random.get(1)!);
  assert.ok(Number.isFinite(normalizedGain(agent, random, oracleZero).gain));
  // An agent far above the oracle is clipped at 1.5, far below random at −1.
  assert.equal(normalizedGain(mk((s) => 200 + s), random, oracle).gain, 1.5);
  assert.equal(normalizedGain(mk((s) => 0 + s), random, oracle).gain, -1);
  assert.ok(normalizedGain(mk((s) => 200 + s), random, oracle).clipped);
  // Oracle indistinguishable from random: no headroom, no gain reported.
  const flat = normalizedGain(agent, random, mk((s) => 80 + s + (s % 2 ? 0.1 : -0.1)));
  assert.equal(flat.defined, false);
});

test("equivalence needs both sides of the band: a large negative effect is not equivalent", () => {
  assert.deepEqual(verdict({ n: 10, mean: 0.35, lo: 0.15, hi: 0.55, critical: 2 }, 1), { equivalent: true, positive: true, negative: false });
  assert.equal(verdict({ n: 10, mean: -5, lo: -6, hi: -4, critical: 2 }, 1).equivalent, false);
  assert.equal(verdict({ n: 10, mean: 0.4, lo: -0.2, hi: 1.09, critical: 2 }, 1).equivalent, false); // Spiral's shift result
});

test("the manifest binds the pinned Spiral commit, the imported model files, the configs, and every fixture", () => {
  const manifest = readManifest(root);
  verifyManifest(root, manifest);
  assert.equal(manifest.spiral.commit, "9824c30ad402cc9bca768eca27d176e0e8788db5");
  // Blob ids of the imported model files as `git ls-tree` reports them at the pin.
  assert.deepEqual(modelBlobs(root), {
    "model/escrow.ts": "0df94f915b3bf556b522c9bf7a5adf94f8d2e2d9",
    "model/ledger.ts": "4ebe1eefda83d76dec862aa81df4d0584068bdb4",
    "model/registry.ts": "2f283706e0fd590d750019b638c1ab1f73229ed2",
    "model/server.ts": "88630399773353fed5123b97c8eedc13d87adc18",
  });
});

test("a tampered fixture is refused by name; an unlisted fixture is refused; a wrong pin is refused", () => {
  const manifest = readManifest(root);
  const entry = manifest.fixtures.find((f) => f.family === "placement")!;
  const tmp = mkdtempSync(join(tmpdir(), "bdb-manifest-"));
  mkdirSync(dirname(join(tmp, entry.path)), { recursive: true });
  const original = readFileSync(join(root, entry.path), "utf8");
  writeFileSync(join(tmp, entry.path), original);
  verifyFixture(tmp, entry); // untouched copy passes
  assert.ok(loadFixture<{ seed: number }>(tmp, manifest, entry.path).seed === entry.seed);

  // Change one hidden capacity by one satoshi.
  const tampered = original.replace(/"capacity":\[(\d+)/, (_m, first: string) => `"capacity":[${Number(first) + 1}`);
  assert.notEqual(tampered, original);
  writeFileSync(join(tmp, entry.path), tampered);
  assert.throws(() => verifyFixture(tmp, entry), (e: unknown) => e instanceof ManifestError && e.file === entry.path && /hash mismatch/.test(e.message));
  assert.throws(() => loadFixture(tmp, manifest, entry.path), ManifestError);
  assert.throws(() => loadFixture(tmp, manifest, "fixtures/placement/seed-9999.json"), /not listed/);

  const wrongPin: Manifest = { ...manifest, spiral: { ...manifest.spiral, commit: "0".repeat(40) } };
  assert.throws(() => verifyManifest(root, wrongPin), (e: unknown) => e instanceof ManifestError && /pins/.test(e.message));
  const wrongBlob: Manifest = { ...manifest, spiral: { ...manifest.spiral, model_blobs: { ...manifest.spiral.model_blobs, "model/server.ts": sha256("x").slice(0, 40) } } };
  assert.throws(() => verifyManifest(root, wrongBlob), /model file differs/);
});
