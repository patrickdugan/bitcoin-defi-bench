// Merge measurements of the R_cap program into the one family 7 adopts (docs/tasks.md §8.5).
//
//   node --experimental-strip-types cairo/rcap/adopt.ts --out cairo/rcap/measurements/adopted-<date>.json \
//     cairo/rcap/measurements/<a>.json cairo/rcap/measurements/<b>.json …
//
// Every source must measure the same program (by SHA-256) with the same toolchain, and every proof
// in it must have verified. For each batch size the merged seconds are the minimum over every run
// in every source, the statistic least disturbed by other work on the machine; peak memory is the
// maximum; steps must agree. Each source is named with the SHA-256 of its LF-normalized text.

import { readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "../../src/harness/json.ts";

interface Run { batch: number; steps: number; prove_seconds: number; prove_seconds_all?: number[]; peak_rss_mib: number; proof_bytes: number; verified: boolean; exit: number }
interface Measurement { program: string; program_sha256: string; toolchain: string; machine: string; started: string; statistic?: string; load_average_at_start?: string; runs: Run[] }

const argv = process.argv.slice(2);
const outAt = argv.indexOf("--out");
if (outAt < 0 || !argv[outAt + 1]) throw new Error("--out is required");
const out = argv[outAt + 1]!;
const files = argv.filter((_, i) => i !== outAt && i !== outAt + 1);
if (files.length === 0) throw new Error("name at least one measurement file");

const sources = files.map((file) => {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return { file, sha256: sha256(text), m: JSON.parse(text) as Measurement };
});
const first = sources[0]!.m;
for (const s of sources) {
  if (s.m.program_sha256 !== first.program_sha256) throw new Error(`${s.file}: a different program`);
  if (s.m.toolchain !== first.toolchain) throw new Error(`${s.file}: a different toolchain`);
  for (const r of s.m.runs) if (!r.verified || r.exit !== 0) throw new Error(`${s.file}: batch ${r.batch} did not prove and verify`);
}
const sizes = [...new Set(sources.flatMap((s) => s.m.runs.map((r) => r.batch)))].sort((a, b) => a - b);
const runs = sizes.map((batch) => {
  const rs = sources.flatMap((s) => s.m.runs.filter((r) => r.batch === batch));
  const steps = new Set(rs.map((r) => r.steps));
  if (steps.size !== 1) throw new Error(`batch ${batch}: sources disagree on steps`);
  const all = rs.flatMap((r) => r.prove_seconds_all ?? [r.prove_seconds]);
  return { batch, steps: rs[0]!.steps, prove_seconds: Math.min(...all), prove_seconds_all: all, peak_rss_mib: Math.max(...rs.map((r) => r.peak_rss_mib)), proof_bytes: Math.max(...rs.map((r) => r.proof_bytes)), verified: true, exit: 0 };
});
const merged = {
  program: first.program,
  program_sha256: first.program_sha256,
  toolchain: first.toolchain,
  machine: first.machine,
  statistic: `minimum wall seconds over every run in ${sources.length} measurements of this program on this machine; maximum peak memory`,
  sources: sources.map((s) => ({ file: s.file.replace(/\\/g, "/").replace(/^.*?(cairo\/rcap\/)/, "$1"), sha256: s.sha256, started: s.m.started, statistic: s.m.statistic ?? "one run per size", load_average_at_start: s.m.load_average_at_start ?? null })),
  runs,
};
writeFileSync(out, `${JSON.stringify(merged, null, 1)}\n`);
console.log(`wrote ${out}: ${runs.length} sizes from ${sources.length} measurements`);
