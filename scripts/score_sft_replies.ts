// Score model replies to SFT rows (scripts/make_sft_data.ts) as one-action episodes.
//
//   node --experimental-strip-types scripts/score_sft_replies.ts --rows eval.jsonl --replies replies.jsonl [--out per-item.jsonl]
//
// replies.jsonl lines are {"id", "reply"}. Each reply goes through the bare chat agent's own extraction
// (first JSON object), is stepped through a fresh episode for the row's family/cell/seed, and is scored
// against the teacher's value on that episode:
//   score 1    the action is accepted, ends the episode, and its value is within 1% (relative) of the teacher's
//   score 0.25 accepted and ends the episode, but worse than that
//   score 0    no JSON object, rejected, or the episode does not end on this action
// This is a per-item signal for adapter routing, not the bench's reported metric (the agent scripts are).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractAction } from "../src/agents/chat.ts";
import { observationOf } from "../src/harness/episode.ts";
import { sftFamilies } from "./sft_families.ts";

const root = join(import.meta.dirname, "..");
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const families = new Map(sftFamilies(root).map((f) => [f.id, f]));
const replies = new Map<string, string>(lines(arg("replies")!).map((r) => [r.id, r.reply]));
const out: string[] = [];
const byFamily = new Map<string, number[]>();
for (const row of lines(arg("rows")!)) {
  const fam = families.get(row.family)!;
  const reply = replies.get(row.id);
  let score = 0, value: number | null = null, why = "";
  if (reply === undefined) why = "no reply";
  else {
    const env = fam.env(row.seed, row.cell);
    observationOf(env, 0, null);
    let action;
    try { action = extractAction(reply); } catch (e) { why = `extract: ${(e as Error).message}`; }
    if (action !== undefined) {
      const step = env.step(action);
      if (!step.accepted) why = `rejected: ${step.reason}`;
      else if (!env.done()) why = "episode not done after one action";
      else {
        value = env.finish().value;
        const tol = 0.01 * Math.abs(row.teacher_value) + 1e-9;
        score = value >= row.teacher_value - tol ? 1 : 0.25;
        why = score === 1 ? "teacher-level" : "accepted, below teacher";
      }
    }
  }
  (byFamily.get(row.family) ?? byFamily.set(row.family, []).get(row.family)!).push(score);
  out.push(JSON.stringify({ id: row.id, family: row.family, cell: row.cell, seed: row.seed, score, value, teacher_value: row.teacher_value, why }));
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const all = [...byFamily.values()].flat();
console.log(JSON.stringify({ n: all.length, mean: mean(all), by_family: Object.fromEntries([...byFamily].map(([k, v]) => [k, { n: v.length, mean: mean(v) }])) }));
const o = arg("out");
if (o) writeFileSync(o, out.join("\n") + "\n");
