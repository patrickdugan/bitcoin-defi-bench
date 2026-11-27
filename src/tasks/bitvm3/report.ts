// Family 12 report: task specs, contrasts, gates, and the identity control (docs/tasks.md §15). The
// family is built on development seeds only; the contrasts are descriptive until an amendment fixes
// them.

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import type { Bitvm3Config } from "./generate.ts";
import { BITVM3_BAND, bitvm3Cells, bitvm3Episodes, bitvm3Fixture } from "./task.ts";
import { ceilingOf } from "./world.ts";

export const bitvm3Task = (cell: string): string => `bitvm3/${cell}`;

export const BITVM3_METRICS = ["fraud", "disproved", "fraud_paid", "fees_sats", "evaluations", "honest_evaluations"];

export function bitvm3TaskSpecs(root: string, manifest: Manifest, config: Bitvm3Config): TaskSpec[] {
  return bitvm3Cells(config).map((cell) => ({
    task: bitvm3Task(cell),
    unit: "sats the watcher returns to the vault: each disproved claim's output less its disprove fee, less the cost of every evaluation started; letting every claim pay out scores 0",
    band: BITVM3_BAND,
    floor: "idle",
    ceiling: "oracle",
    reference: "largest_first",
    metrics: BITVM3_METRICS,
    episodes: (seed: number) => bitvm3Episodes(root, manifest, config, cell, seed),
  }));
}

export function bitvm3Contrasts(config: Bitvm3Config): ContrastSpec[] {
  const out: ContrastSpec[] = [];
  for (const cell of bitvm3Cells(config)) {
    const task = bitvm3Task(cell);
    out.push(
      { id: `V1-${cell}`, label: "`largest_first` − `cheap_only`, descriptive: what evaluating claims that pass the native check is worth", task, a: "largest_first", b: "cheap_only", primary: false },
      { id: `V2-${cell}`, label: "`largest_first` − `evaluate_all`, descriptive: what the check and the ordering by expected recovery are worth", task, a: "largest_first", b: "evaluate_all", primary: false },
      { id: `V3-${cell}`, label: "`oracle` − `largest_first`, descriptive: the headroom left above the reference", task, a: "oracle", b: "largest_first", primary: false },
    );
  }
  return out;
}

export function bitvm3Gates(_analysis: Analysis, record: RunRecord): Gate[] {
  const rows = record.rows.filter((r) => r.task.startsWith("bitvm3/"));
  const idle = rows.filter((r) => r.agent === "idle");
  const idleNonzero = idle.filter((r) => r.value !== 0);
  const best = new Map(rows.filter((r) => r.agent === "oracle").map((r) => [`${r.task}|${r.seed}`, r.value]));
  const over = rows.filter((r) => r.agent !== "oracle" && best.has(`${r.task}|${r.seed}`) && r.value > best.get(`${r.task}|${r.seed}`)!);
  const identity = checkOf(record, "K122");
  // The reference must leave headroom: on every cell it earns less than the ceiling in total.
  const tasks = [...new Set(rows.map((r) => r.task))].sort();
  const total = (t: string, a: string): number => rows.filter((r) => r.task === t && r.agent === a).reduce((x, r) => x + r.value, 0);
  const share = tasks.map((t) => ({ t, share: total(t, "largest_first") / total(t, "oracle") }));
  const reached = share.filter((s) => !(s.share < 1)).map((s) => s.t);
  return [
    { id: "K121", description: "`idle` earns exactly 0 on every episode (letting every claim pay out returns nothing and costs nothing)", pass: idle.length > 0 && idleNonzero.length === 0, detail: idleNonzero.length === 0 ? `${idle.length} episodes` : `${idleNonzero.length} nonzero, first seed ${idleNonzero[0]!.seed}` },
    { id: "K122", description: "identity: `oracle` through the host earns exactly the ceiling computed from the fixture", pass: identity?.pass === true, detail: identity?.detail ?? "not run" },
    { id: "K123", description: "`oracle` ≥ every other policy on every episode (exact ceiling)", pass: over.length === 0, detail: over.length === 0 ? `${rows.length} episodes, 0 violations` : `${over.length} violations, first: ${over[0]!.agent} ${over[0]!.task} seed ${over[0]!.seed}` },
    { id: "K124", description: "the reference leaves headroom: on every cell `largest_first` earns less than `oracle` over all seeds", pass: tasks.length > 0 && reached.length === 0, detail: reached.length === 0 ? share.map((s) => `${s.t.split("/")[1]} ${s.share.toFixed(2)} of the ceiling`).join(", ") : `at the ceiling on ${reached.join(", ")}` },
  ];
}

export function bitvm3IdentityCheck(root: string, manifest: Manifest): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      if (!row.task.startsWith("bitvm3/") || row.agent !== "oracle") continue;
      compared += 1;
      const direct = ceilingOf(bitvm3Fixture(root, manifest, row.task.split("/")[1]!, row.seed)).value;
      if (direct !== row.value) mismatches.push(`${row.task} seed ${row.seed}: ${row.value} through act, ${direct} direct`);
    }
    return [{ id: "K122", pass: compared > 0 && mismatches.length === 0, detail: mismatches.length === 0 ? `${compared} episodes compared, 0 mismatches` : `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}` }];
  };
}

/** What each policy caught, by fraud class, so a reader sees where each one wins and loses. */
function byClass(root: string, manifest: Manifest) {
  return (_analysis: Analysis, record: RunRecord): string[] => {
    const rows = record.rows.filter((r) => r.task.startsWith("bitvm3/"));
    const agents = [...new Set(rows.map((r) => r.agent))];
    const tasks = [...new Set(rows.map((r) => r.task))].sort();
    const out = ["## Fraud claims by class, pooled over seeds", "",
      "Claims of each class across the cell's seeds, and how many of them each policy disproved. A disproved claim's output returns to the vault; every other fraud claim paid out to P′.", ""];
    for (const task of tasks) {
      const cell = task.split("/")[1]!;
      const seeds = [...new Set(rows.filter((r) => r.task === task).map((r) => r.seed))].sort((a, b) => a - b);
      const fixtures = new Map(seeds.map((s) => [s, bitvm3Fixture(root, manifest, cell, s)]));
      const count = (cls: string): number => seeds.reduce((a, s) => a + fixtures.get(s)!.claims.filter((c) => c.class === cls).length, 0);
      const sats = (cls: string): number => seeds.reduce((a, s) => a + fixtures.get(s)!.claims.filter((c) => c.class === cls).reduce((x, c) => x + c.k_sats, 0), 0);
      const reorgs = seeds.reduce((a, s) => a + fixtures.get(s)!.reorgs.length, 0);
      const spikes = seeds.reduce((a, s) => a + fixtures.get(s)!.spikes.length, 0);
      out.push(`### \`${task}\``, "",
        `${count("honest")} honest, ${count("wrong_statement")} wrong-statement and ${count("invalid_proof")} invalid-proof claims; the fraud claims held ${sats("wrong_statement") + sats("invalid_proof")} sats of claim outputs. ${reorgs} reorganizations and ${spikes} fee spikes over ${seeds.length} seeds.`, "",
        "| Policy | Disproved (of all fraud) | Fraud paid out | Evaluations | Of them honest | Disprove fees (sats) |", "|---|---:|---:|---:|---:|---:|");
      for (const a of agents) {
        const mine = rows.filter((r) => r.task === task && r.agent === a);
        const sum = (m: string): number => mine.reduce((x, r) => x + r.metrics[m]!, 0);
        out.push(`| \`${a}\` | ${sum("disproved")} of ${sum("fraud")} | ${sum("fraud_paid")} | ${sum("evaluations")} | ${sum("honest_evaluations")} | ${sum("fees_sats")} |`);
      }
      out.push("");
    }
    out.push("Claim classes, reorganizations, and fee paths are hidden from every policy except `oracle`.", "");
    return out;
  };
}

export const bitvm3Report = (config: Bitvm3Config, root: string, manifest: Manifest): ReportSpec => ({
  title: "Bitcoin DeFi Bench v0: family 12 (the BitVM3 claim graph over a Nova payment proof), baselines",
  contrasts: bitvm3Contrasts(config),
  gates: bitvm3Gates,
  extra: byClass(root, manifest),
});
