// The 2×2 of skill and complex for Bonsai 8B, one table per seed block, from the runs already written:
//
//   node --experimental-strip-types scripts/factorial_table.ts --block confirmatory
//
// The arms, for family 4 and each family 9 cell:
//   bare            the chat adapter alone                       v0-<cell>-bonsai-8b-nothink-<block>
//   skill as tool   the adapter carrying the cell's skill        v0-<cell>-bonsai-8b-nothink-<skill>-<block>
//   TRM complex     bare proposer, rules, repair, gate           v0-<cell>-bonsai-8b-nothink-trm-complex-<block>
//   combo           the complex with the skill-carrying proposer v0-<cell>-bonsai-8b-nothink-<skill>-trm-complex-<block>
// Every arm ran the same seeds on the same fixtures, so arms are compared seed by seed. Everything here
// is descriptive: each run's own primary contrast is in its own table. Writes results/v0-skill-trm-factorial-<block>.md.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord } from "../src/harness/run.ts";
import { clusterMeans, normalizedGain, pairedDifference, verdict, verdictLabel, type Interval } from "../src/harness/stats.ts";
import { NOSTR_CELL_SPECS } from "../src/tasks/nostr/report.ts";
import type { NostrCell } from "../src/tasks/nostr/task.ts";
import { SERVER_SIZING_BAND } from "../src/tasks/server_sizing/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--block");
const block = i >= 0 ? process.argv[i + 1]! : "confirmatory";
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");

const SKILL: { [cell in NostrCell]: string } = { custody: "custody_policy", custody_hot: "inbox_policy", publish: "outbox_plan", private: "nip17_plan", counterparty: "buyer_plan", mesh_outage: "mesh_router", mesh_partial: "mesh_router" };
const ARMS = ["bare", "skill as tool", "TRM complex", "combo"] as const;
type Arm = (typeof ARMS)[number];

interface Row { label: string; task: string; prefix: string; skill: string; floor: string; ceiling: string; reference: string; band: number; unit: string }
const sizing = { floor: "static_pilot", ceiling: "oracle", reference: "buffer_rule", band: SERVER_SIZING_BAND };
const ROWS: Row[] = [
  ...["balanced", "correlated", "drift"].map((c): Row => ({ label: `family 4, \`${c}\``, task: `server_sizing/${c}`, prefix: "v0-server-sizing", skill: "capacity_plan", floor: sizing.floor, ceiling: sizing.ceiling, reference: sizing.reference, band: sizing.band, unit: "ln cost" })),
  ...(Object.keys(SKILL) as NostrCell[]).map((c): Row => ({ label: `\`${c}\``, task: `nostr/${c}`, prefix: `v0-nostr-${c.replace(/_/g, "-")}`, skill: SKILL[c], floor: "idle", ceiling: NOSTR_CELL_SPECS[c].ceiling, reference: NOSTR_CELL_SPECS[c].reference, band: NOSTR_CELL_SPECS[c].band, unit: "sats" })),
];

const stem = (r: Row, arm: Arm): string => `${r.prefix}-bonsai-8b-nothink${arm === "skill as tool" || arm === "combo" ? `-${r.skill}` : ""}${arm === "TRM complex" || arm === "combo" ? "-trm-complex" : ""}-${block}`;

interface Run { record: RunRecord; agent: string; transcript: Array<{ episode: { task: string }; skill?: unknown }>; records: Array<{ episode: { task: string }; stage: string; choice: string }> | null }
const cache = new Map<string, Run | "not completed" | "not run">();
function load(r: Row, arm: Arm): Run | "not completed" | "not run" {
  const s = stem(r, arm);
  if (cache.has(s)) return cache.get(s)!;
  let out: Run | "not completed" | "not run";
  const json = join(root, "results", `${s}.json`);
  if (!existsSync(json)) {
    out = existsSync(join(root, "results", `${r.prefix}-bonsai-8b-nothink-${r.skill}.not-completed.md`)) && arm === "skill as tool" ? "not completed" : "not run";
  } else {
    const record = JSON.parse(readFileSync(json, "utf8")) as RunRecord;
    const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)) : null);
    const spec = record.tasks.find((x) => x.task === r.task)!;
    if (spec.floor !== r.floor || spec.ceiling !== r.ceiling || spec.reference !== r.reference || spec.band !== r.band) throw new Error(`${s}: ${r.task}'s floor, ceiling, reference, or band differs from this table's`);
    out = { record, agent: record.agents.find((a) => !a.baseline)!.id, transcript: lines(join(root, "results", `${s}.transcript.jsonl`)) ?? [], records: lines(join(root, "results", `${s}.records.jsonl`)) };
  }
  cache.set(s, out);
  return out;
}

const means = (run: Run, task: string, agent: string) => clusterMeans(run.record.rows.filter((x) => x.task === task && x.agent === agent));
const num = (x: number, unit: string): string => {
  const d = unit === "ln cost" ? 2 : 0;
  const r = Number(x.toFixed(d));
  const s = Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return r === 0 ? s : `${r < 0 ? "−" : "+"}${s}`;
};
const interval = (v: Interval, unit: string): string => (v.lo === v.hi ? `exactly ${num(v.mean, unit)}` : `${num(v.mean, unit)} (${num(v.lo, unit)} to ${num(v.hi, unit)})`);
const gain = (run: Run, r: Row): string => {
  const g = normalizedGain(means(run, r.task, run.agent), means(run, r.task, r.floor), means(run, r.task, r.ceiling));
  const f = (x: number): string => (Number(x.toFixed(2)) < 0 ? `−${Math.abs(x).toFixed(2)}` : x.toFixed(2));
  return g.defined ? `${f(g.gain)} (${f(g.lo)} to ${f(g.hi)})${g.clipped ? ", clipped" : ""}` : "undefined";
};
const cellOf = (r: Row, arm: Arm, f: (run: Run) => string): string => { const run = load(r, arm); return typeof run === "string" ? run : f(run); };

const out: string[] = [];
out.push(`# Skill as a tool × TRM complex, Bonsai 8B, ${block} seeds`, "");
out.push("Four arms per cell, each run once on the same seeds and fixtures. The rows of each arm's own table give its primary contrast. This table puts the arms side by side, and its contrasts are descriptive: 95% intervals over seed clusters, not adjusted.", "");
out.push("- **Bare**: the chat adapter alone.", "- **Skill as a tool**: the adapter carrying the cell's skill, which the model may call before it acts.", "- **TRM complex**: the bare agent proposes, the package's rules check the proposal, the skill repairs it, and the gate decides the rest (docs/trm_complex.md).", "- **Combo**: the complex, with the skill-carrying agent as its proposer and a gate trained on that agent's development runs.", "");
out.push("## Normalized gain", "", `0 is the floor, 1 the ceiling. Family 4's floor is \`${sizing.floor}\`, and family 9's is \`idle\`.`, "");
out.push(`| Cell | ${ARMS.join(" | ")} |`, `|---|${ARMS.map(() => "---").join("|")}|`);
for (const r of ROWS) out.push(`| ${r.label} | ${ARMS.map((a) => cellOf(r, a, (run) => gain(run, r))).join(" | ")} |`);
out.push("", "## Agent − reference", "", "Each arm's agent less the cell's reference heuristic, in the family's unit: ln cost in family 4, sats in family 9.", "");
out.push(`| Cell | Reference | ${ARMS.join(" | ")} |`, `|---|---|${ARMS.map(() => "---").join("|")}|`);
for (const r of ROWS) out.push(`| ${r.label} | \`${r.reference}\` | ${ARMS.map((a) => cellOf(r, a, (run) => { const v = pairedDifference(means(run, r.task, run.agent), means(run, r.task, r.reference)); return `${interval(v, r.unit)}, ${verdictLabel(verdict(v, r.band))}`; })).join(" | ")} |`);

const EFFECTS: Array<[string, Arm, Arm]> = [["complex − bare", "TRM complex", "bare"], ["combo − skill as tool", "combo", "skill as tool"], ["skill as tool − bare", "skill as tool", "bare"], ["combo − complex", "combo", "TRM complex"]];
out.push("", "## The two factors", "", "Paired by seed across runs. The first two columns are the complex's effect without and with the skill as a tool. The last two are the tool's effect without and with the complex. Units as above.", "");
out.push(`| Cell | ${EFFECTS.map((e) => e[0]).join(" | ")} |`, `|---|${EFFECTS.map(() => "---").join("|")}|`);
for (const r of ROWS) {
  out.push(`| ${r.label} | ${EFFECTS.map(([, a, b]) => {
    const x = load(r, a); const y = load(r, b);
    if (typeof x === "string" || typeof y === "string") return "—";
    const v = pairedDifference(means(x, r.task, x.agent), means(y, r.task, y.agent));
    return `${interval(v, r.unit)}, ${verdictLabel(verdict(v, r.band))}`;
  }).join(" | ")} |`);
}

out.push("", "## What the model did", "", "- **Model calls per action**: requests to the model server per action sent, including skill calls.", "- **Skill calls**: the share of actions preceded by a skill call.", "- **Proposal sent**: in a complex, the share of actions that were the model's own proposal, because it agreed with the skill or the gate chose it.", "");
out.push(`| Cell | ${ARMS.map((a) => `${a}: model calls per action, skill calls`).join(" | ")} | complex: proposal sent | combo: proposal sent |`, `|---|${ARMS.map(() => "---").join("|")}|---|---|`);
for (const r of ROWS) {
  const calls = (a: Arm) => cellOf(r, a, (run) => {
    const actions = run.record.rows.filter((x) => x.task === r.task && x.agent === run.agent).reduce((s, x) => s + x.turns, 0);
    const lines = run.transcript.filter((x) => x.episode.task === r.task);
    const skill = lines.filter((x) => x.skill).length;
    return `${(lines.length / Math.max(1, actions)).toFixed(2)}, ${a === "bare" || a === "TRM complex" ? "—" : `${((100 * skill) / Math.max(1, actions)).toFixed(0)}%`}`;
  });
  const sent = (a: Arm) => cellOf(r, a, (run) => {
    const rs = (run.records ?? []).filter((x) => x.episode.task === r.task);
    return `${((100 * rs.filter((x) => x.stage === "agree" || (x.stage === "gate" && x.choice === "commit")).length) / Math.max(1, rs.length)).toFixed(1)}% of ${rs.length}`;
  });
  out.push(`| ${r.label} | ${ARMS.map(calls).join(" | ")} | ${sent("TRM complex")} | ${sent("combo")} |`);
}
out.push("", "## Runs", "");
const listed = new Set<string>();
for (const r of ROWS) for (const a of ARMS) {
  if (listed.has(stem(r, a))) continue;
  listed.add(stem(r, a));
  const run = load(r, a);
  out.push(`- ${r.task.startsWith("server_sizing") ? "family 4" : r.label}, ${a}: ${typeof run === "string" ? run : `\`${run.agent}\`, [${stem(r, a)}.md](${stem(r, a)}.md)`}`);
}
const file = join(root, "results", `v0-skill-trm-factorial-${block}.md`);
writeFileSync(file, `${out.join("\n")}\n`);
console.log(`wrote ${file}`);
