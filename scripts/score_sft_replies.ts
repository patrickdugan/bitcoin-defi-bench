// Score model replies to SFT rows (scripts/make_sft_data.ts).
//
//   node --experimental-strip-types scripts/score_sft_replies.ts --rows eval.jsonl --replies replies.jsonl [--out per-item.jsonl]
//
// replies.jsonl lines are {"id", "reply"}. Each reply goes through the bare chat agent's own extraction
// (first JSON object), is stepped through a fresh episode for the row's family/cell/seed, and is scored
// against the teacher's value on that episode:
//   score 1    the action is accepted, ends the episode, and its value is within 1% (relative) of the teacher's
//   score 0.25 accepted and ends the episode, but worse than that
//   score 0    no JSON object, rejected, or the episode does not end on this action
// A row of a multi-turn family has a `turn`: the episode is rebuilt, the teacher is re-run for the turns
// before it, the reply is stepped at that turn, and the teacher finishes the episode. Score 1 if the reply
// is accepted and the final value is within 1% of the row's teacher_value (the episode's value under the
// teacher), 0.25 if accepted but worse, 0 if it has no JSON object, is rejected, or the teacher cannot finish.
// This is a per-item signal for adapter routing, not the bench's reported metric (the agent scripts are).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractAction } from "../src/agents/chat.ts";
import { observationOf } from "../src/harness/episode.ts";
import { playEpisode, sftFamilies } from "./sft_families.ts";

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
    let action;
    try { action = extractAction(reply); } catch (e) { why = `extract: ${(e as Error).message}`; }
    if (action !== undefined) {
      if (!fam.multi_turn) {
        const env = fam.env(row.seed, row.cell);
        observationOf(env, 0, null);
        const step = env.step(action);
        if (!step.accepted) why = `rejected: ${step.reason}`;
        else if (!env.done()) why = "episode not done after one action";
        else value = env.finish().value;
      } else {
        const episode = playEpisode(fam, row.seed, row.cell, { turn: row.turn, action });
        if (episode.value !== null) value = episode.value;
        else why = episode.failedAt === row.turn ? episode.why : `accepted, then the teacher could not finish: ${episode.why}`;
      }
      if (value !== null) {
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
