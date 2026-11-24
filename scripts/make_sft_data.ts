// Supervised fine-tuning rows for families 5, 6, and 10, from a training seed block that no table uses.
//
//   node --experimental-strip-types scripts/make_sft_data.ts --out <dir> --train 5000:400 --val 6000:16
//
// Each row is the first request the bare chat agent would send for one episode (the family's system
// prompt and first turn, rendered by the same PromptRenderer the agent scripts use, with the same
// reply-token limits as the 27B runs) and, as the target, the action of the family's teacher: the
// skill that computes it from the observation alone (`bond_offer`, `min_cost_flow`, `dlc_design`).
// The teacher action is stepped through the environment; a row is kept only if the environment
// accepts it and the episode ends on that one action, so every target is a complete, valid episode.
//
// Seeds: training rows use 5000 and up, validation rows 6000 and up. Development seeds 0 to 7,
// confirmatory seeds 1000 to 1031, the reserve blocks 1100 and 1200, and the exploratory block 2000
// are refused. Fixtures are generated in memory by the families' own generators and never written.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../src/harness/json.ts";
import { observationOf } from "../src/harness/episode.ts";
import { sftFamilies } from "./sft_families.ts";

const root = join(import.meta.dirname, "..");
const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback === undefined) throw new Error(`missing --${name}`);
  return fallback;
};
const block = (spec: string): number[] => {
  const [start, count] = spec.split(":").map(Number);
  const seeds = Array.from({ length: count! }, (_, i) => start! + i);
  for (const s of seeds) if (s < 5000) throw new Error(`seed ${s}: training rows use seeds 5000 and up only`);
  return seeds;
};

const out = arg("out");
const splits = { train: block(arg("train", "5000:400")), val: block(arg("val", "6000:16")) };
const overlap = splits.train.filter((s) => splits.val.includes(s));
if (overlap.length) throw new Error(`train and val seeds overlap: ${overlap.join(",")}`);

const families = sftFamilies(root);

mkdirSync(out, { recursive: true });
const manifest: { [k: string]: Json } = {};
for (const [split, seeds] of Object.entries(splits)) {
  const rows: string[] = [];
  const dropped: Array<{ family: string; cell: string; seed: number; why: string }> = [];
  for (const fam of families) {
    for (const cell of fam.cells) {
      for (const seed of seeds) {
        const env = fam.env(seed, cell);
        const observation = JSON.parse(JSON.stringify(observationOf(env, 0, null))) as Json;
        const action = fam.teacher.run(observation, {}, [observation]);
        const step = env.step(action);
        if (!step.accepted) { dropped.push({ family: fam.id, cell, seed, why: `rejected: ${step.reason}` }); continue; }
        if (!env.done()) { dropped.push({ family: fam.id, cell, seed, why: "episode not done after one action" }); continue; }
        const outcome = env.finish();
        rows.push(JSON.stringify({
          id: `${fam.id}/${cell}/${seed}`, family: fam.id, cell, seed, teacher: fam.teacher.name,
          teacher_value: outcome.value, prompt_sha256: fam.prompt.sha256,
          messages: [
            { role: "system", content: fam.prompt.system(observation) },
            { role: "user", content: fam.prompt.turn(observation) },
          ],
          target: JSON.stringify(action),
        }));
      }
    }
  }
  const text = rows.join("\n") + "\n";
  writeFileSync(join(out, `${split}.jsonl`), text);
  manifest[split] = {
    rows: rows.length, seeds: `${seeds[0]}..${seeds[seeds.length - 1]}`, dropped: dropped as unknown as Json,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  console.log(`${split}: ${rows.length} rows, ${dropped.length} dropped`);
}
manifest.families = families.map((f) => ({ id: f.id, cells: f.cells, teacher: f.teacher.name, teacher_sha256: f.teacher.sha256, prompt_sha256: f.prompt.sha256 })) as unknown as Json;
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
