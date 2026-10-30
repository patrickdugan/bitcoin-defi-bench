// Family 7 report: task specs, contrasts, gates, and the identity control. Not yet preregistered:
// every contrast is declared and descriptive until an amendment freezes the family.

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import { costModelOf, valueOf } from "./env.ts";
import type { ProofBudgetConfig } from "./generate.ts";
import { optimalSchedule, scheduleCost } from "./plan.ts";
import { PROOF_BAND, proofEpisodes, proofFixture } from "./task.ts";

const taskOf = (cell: string): string => `proof_budget/${cell}`;

export function proofTaskSpecs(root: string, manifest: Manifest, config: ProofBudgetConfig): TaskSpec[] {
  return Object.keys(config.cells).sort().map((cell) => ({
    task: taskOf(cell),
    unit: "−ln of the horizon's cost in sats: the prover's price for each proof, staleness while claims wait, and the value of every claim not proven",
    band: PROOF_BAND,
    floor: "every_arrival",
    ceiling: "optimal_batching",
    reference: "fixed_interval",
    metrics: ["cost_sats", "prover_sats", "staleness_sats", "forfeit_sats", "proofs", "mean_batch"],
    episodes: (seed: number) => proofEpisodes(root, manifest, cell, seed),
  }));
}

/** The five primary contrasts of prereg/v0.md Amendment 8, P1 to P5, and its declared secondary ones. */
export function proofContrasts(_config: ProofBudgetConfig): ContrastSpec[] {
  const ceiling = "`optimal_batching` − `fixed_interval`, predicted positive: knowing arrivals pays";
  return [
    { id: "P1", label: ceiling, task: taskOf("steady"), a: "optimal_batching", b: "fixed_interval", primary: true },
    { id: "P2", label: ceiling, task: taskOf("bursty"), a: "optimal_batching", b: "fixed_interval", primary: true },
    { id: "P3", label: ceiling, task: taskOf("few_proofs"), a: "optimal_batching", b: "fixed_interval", primary: true },
    { id: "P4", label: "`threshold` − `fixed_interval`, predicted positive: an adaptive rule pays when the rate moves", task: taskOf("bursty"), a: "threshold", b: "fixed_interval", primary: true },
    { id: "P5", label: "`threshold` − `fixed_interval`, predicted negative: a rule blind to the budget forfeits", task: taskOf("few_proofs"), a: "threshold", b: "fixed_interval", primary: true },
    ...["bursty", "few_proofs", "steady"].map((cell, i) => ({ id: `S${i + 1}`, label: "`fixed_interval` − `every_arrival`, predicted positive", task: taskOf(cell), a: "fixed_interval", b: "every_arrival", primary: false })),
    { id: "S4", label: "`threshold` − `fixed_interval`, descriptive: an adaptive rule against a fixed one", task: taskOf("steady"), a: "threshold", b: "fixed_interval", primary: false },
  ];
}

export function proofGates(_analysis: Analysis, record: RunRecord): Gate[] {
  const tasks = record.tasks.map((t) => t.task).filter((t) => t.startsWith("proof_budget/"));
  const values = (agent: string, task: string): Map<string, number> => new Map(record.rows.filter((r) => r.task === task && r.agent === agent).map((r) => [`${r.seed}|${r.cell}`, r.value]));
  let compared = 0;
  const ceiling: string[] = [];
  const forfeits: string[] = [];
  for (const task of tasks) {
    const best = values("optimal_batching", task);
    for (const r of record.rows.filter((x) => x.task === task)) {
      compared += 1;
      if (r.agent !== "optimal_batching" && r.value > best.get(`${r.seed}|${r.cell}`)! + 1e-9) ceiling.push(`${r.agent} ${task} seed ${r.seed}`);
      if (r.agent === "fixed_interval" && (r.metrics.forfeited ?? 0) > 0) forfeits.push(`${task} seed ${r.seed}`);
    }
  }
  const identity = checkOf(record, "K72");
  return [
    { id: "K71", description: "`optimal_batching` ≥ every other policy on every episode (exact over the action space, knowing the arrivals)", pass: ceiling.length === 0, detail: ceiling.length === 0 ? `${compared} comparisons, 0 violations` : `${ceiling.length} violations, first: ${ceiling[0]}` },
    { id: "K72", description: "identity: the ceiling through `act` equals its schedule's cost computed directly from the fixture", pass: identity?.pass === true, detail: identity?.detail ?? "not run" },
    { id: "K73", description: "`fixed_interval` proves every claim on every episode: the reference never forfeits", pass: forfeits.length === 0, detail: forfeits.length === 0 ? "0 forfeits" : `${forfeits.length} episodes with forfeits, first: ${forfeits[0]}` },
  ];
}

export function proofIdentityCheck(root: string, manifest: Manifest): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      if (!row.task.startsWith("proof_budget/") || row.agent !== "optimal_batching") continue;
      const fixture = proofFixture(root, manifest, row.task.split("/")[1]!, row.seed);
      const cost = costModelOf(fixture);
      const schedule = optimalSchedule(fixture.claims, cost, fixture.params.staleness_ppm_per_block, fixture.params.max_proofs);
      const direct = scheduleCost(fixture.claims, schedule, cost, fixture.params.staleness_ppm_per_block);
      compared += 1;
      if (typeof direct === "string" || Math.abs(valueOf(direct.total_sats) - row.value) > 1e-9) mismatches.push(`${row.task} seed ${row.seed}`);
    }
    return [{ id: "K72", pass: compared > 0 && mismatches.length === 0, detail: mismatches.length === 0 ? `${compared} episodes compared, 0 mismatches` : `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}` }];
  };
}

export const proofReport = (config: ProofBudgetConfig): ReportSpec => ({
  title: "Bitcoin DeFi Bench v0: family 7 (proving claims within a budget), baselines",
  contrasts: proofContrasts(config),
  gates: proofGates,
});
