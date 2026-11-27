// Supervised fine-tuning rows for every family with a teacher skill (scripts/sft_families.ts), from
// seed blocks that no table uses.
//
//   node --experimental-strip-types scripts/make_sft_data.ts --out <dir> --train 5000:400 --val 6000:16 [--eval 7000:4]
//     [--max-turns-per-episode 4] [--max-len 3400] [--families bonding,dlc]
//
// A row is the request the bare chat agent would send at one decision (the family's system prompt and
// the turns so far, rendered by the same PromptRenderer the agent runner uses, at its reply-token
// limit and context-turns window) and, as the target, the action of the family's teacher: the skill
// that computes it from the observations alone. The teacher is rolled out through the whole episode
// in memory, and the episode is kept only if the environment accepts every action, so every target
// belongs to a complete, valid episode. A one-action family gives one row per episode: the first
// request. A multi-turn family gives up to --max-turns-per-episode rows per episode, at turns chosen
// by a hash of family, cell, seed, and turn; the earlier turns of a row's messages carry the teacher's
// replies as the assistant turns, as the agent would have them. A multi-turn row has a `turn` field;
// `teacher_value` is the episode's value. The manifest reports rows, dropped episodes, and the length
// of prompt plus target (characters / 3.5) against --max-len tokens, per family.
//
// Seeds: training rows use 5000 and up, validation rows 6000 and up, evaluation rows 7000 and up.
// Development seeds 0 to 7, confirmatory seeds 1000 to 1031, the reserve blocks 1100 and 1200, and
// the exploratory block 2000 are refused. Fixtures are generated in memory by the families' own
// generators and never written.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../src/harness/json.ts";
import { messagesAt, playEpisode, sftFamilies } from "./sft_families.ts";

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
const splits: { [split: string]: number[] } = { train: block(arg("train", "5000:400")), val: block(arg("val", "6000:16")) };
if (arg("eval", "") !== "") splits.eval = block(arg("eval"));
const seen = new Map<number, string>();
for (const [split, seeds] of Object.entries(splits)) {
  for (const s of seeds) {
    if (seen.has(s)) throw new Error(`${seen.get(s)} and ${split} seeds overlap: ${s}`);
    seen.set(s, split);
  }
}
const maxTurns = Number(arg("max-turns-per-episode", "4"));
const maxLen = Number(arg("max-len", "3400"));
const only = arg("families", "");

const families = sftFamilies(root).filter((f) => only === "" || only.split(",").includes(f.id));

/** The turns of a long episode that become rows: ranked by a hash of family, cell, seed, and turn, so the choice is fixed. */
const pickTurns = (family: string, cell: string, seed: number, turns: number): number[] => {
  const all = Array.from({ length: turns }, (_, t) => t);
  if (turns <= maxTurns) return all;
  const rank = (t: number) => createHash("sha256").update(`${family}|${cell}|${seed}|${t}`).digest("hex");
  return all.sort((x, y) => (rank(x) < rank(y) ? -1 : 1)).slice(0, maxTurns).sort((x, y) => x - y);
};

mkdirSync(out, { recursive: true });
const manifest: { [k: string]: Json } = {};
for (const [split, seeds] of Object.entries(splits)) {
  const rows: string[] = [];
  const dropped: Array<{ family: string; cell: string; seed: number; why: string }> = [];
  const counts: { [family: string]: { rows: number; episodes: number; tokens: number[] } } = {};
  for (const fam of families) {
    counts[fam.id] = { rows: 0, episodes: 0, tokens: [] };
    for (const cell of fam.cells) {
      for (const seed of seeds) {
        const episode = playEpisode(fam, seed, cell);
        if (episode.value === null) {
          const why = fam.multi_turn ? `${episode.why} (turn ${episode.failedAt})` : episode.why;
          dropped.push({ family: fam.id, cell, seed, why });
          continue;
        }
        if (!fam.multi_turn && episode.actions.length !== 1) { dropped.push({ family: fam.id, cell, seed, why: "episode not done after one action" }); continue; }
        counts[fam.id]!.episodes += 1;
        const turns = fam.multi_turn ? pickTurns(fam.id, cell, seed, episode.actions.length) : [0];
        for (const turn of turns) {
          const messages = messagesAt(fam, cell, episode.observations, episode.actions, turn);
          const target = JSON.stringify(episode.actions[turn]);
          const prompt = fam.prompt(cell);
          rows.push(JSON.stringify({
            id: fam.multi_turn ? `${fam.id}/${cell}/${seed}/t${turn}` : `${fam.id}/${cell}/${seed}`, family: fam.id, cell, seed,
            ...(fam.multi_turn ? { turn } : {}), teacher: fam.teacher(cell).name,
            teacher_value: episode.value, prompt_sha256: prompt.sha256,
            messages, target,
          }));
          counts[fam.id]!.rows += 1;
          counts[fam.id]!.tokens.push(Math.ceil((messages.reduce((n, m) => n + m.content.length, 0) + target.length) / 3.5));
        }
      }
    }
  }
  const text = rows.join("\n") + "\n";
  writeFileSync(join(out, `${split}.jsonl`), text);
  const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;
  manifest[split] = {
    rows: rows.length, seeds: `${seeds[0]}..${seeds[seeds.length - 1]}`, dropped: dropped as unknown as Json,
    sha256: createHash("sha256").update(text).digest("hex"),
    by_family: Object.fromEntries(Object.entries(counts).map(([id, c]) => [id, {
      rows: c.rows, episodes: c.episodes,
      tokens_approx: { p50: pct(c.tokens, 0.5), p90: pct(c.tokens, 0.9), max: Math.max(0, ...c.tokens), over_max_len: c.tokens.filter((t) => t > maxLen).length },
    }])) as unknown as Json,
  };
  console.log(`${split}: ${rows.length} rows, ${dropped.length} dropped`);
}
manifest.max_turns_per_episode = maxTurns;
manifest.max_len_tokens = maxLen;
manifest.families = families.map((f) => ({
  id: f.id, multi_turn: f.multi_turn, context_turns: f.context_turns ?? null,
  cells: Object.fromEntries(f.cells.map((c) => [c, { teacher: f.teacher(c).name, teacher_sha256: f.teacher(c).sha256, prompt_sha256: f.prompt(c).sha256 }])),
})) as unknown as Json;
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
