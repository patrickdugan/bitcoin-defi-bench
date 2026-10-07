// Argument files for the R_cap program: one batch of b claims with Merkle paths of depth d, as
// the flat Serde encoding `scarb execute` and `scarb prove --execute --arguments-file` read (a
// JSON array of hex field elements). Witnesses are seeded random; nothing is hashed here, since
// the program computes the statements itself.
//
//   node --experimental-strip-types cairo/rcap/gen_args.ts --out cairo/rcap/args --sizes 1,2,4,8,16,32,64,128 --depth 20
//
// Serde layout of Batch { claims: Array<Witness> }:
//   [n, (s, k, id, value, claimed, d, sibling_1..sibling_d, d, direction_1..direction_d) × n]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stream } from "../../src/harness/prng.ts";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const out = arg("out", "cairo/rcap/args");
const sizes = arg("sizes", "1,2,4,8,16,32,64,128").split(",").map((s) => Number(s.trim()));
const depth = Number(arg("depth", "20"));
const seed = Number(arg("seed", "1"));

// A field element below the Stark prime, as 31 random bytes.
const felt = (rng: { next(): number }): string => {
  let hex = "";
  for (let i = 0; i < 31; i++) hex += Math.floor(rng.next() * 256).toString(16).padStart(2, "0");
  return `0x${hex.replace(/^0+/, "") || "0"}`;
};
const hex = (n: number): string => `0x${n.toString(16)}`;

mkdirSync(out, { recursive: true });
for (const b of sizes) {
  const rng = stream("rcap/args", seed, b, depth);
  const words: string[] = [hex(b)];
  for (let i = 0; i < b; i++) {
    const value = 1_000_000 + Math.floor(rng.next() * 1_000_000);
    const claimed = Math.floor(value * (0.5 + 0.5 * rng.next()));
    words.push(felt(rng), felt(rng), felt(rng), hex(value), hex(claimed), hex(depth));
    for (let j = 0; j < depth; j++) words.push(felt(rng));
    words.push(hex(depth));
    for (let j = 0; j < depth; j++) words.push(hex(rng.next() < 0.5 ? 0 : 1));
  }
  writeFileSync(join(out, `batch-${String(b).padStart(4, "0")}.json`), `${JSON.stringify(words)}\n`);
  console.log(`batch ${b}: ${words.length} words`);
}
