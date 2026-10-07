// Family 6 report: task specs, contrasts, gates, and the identity control (the ceiling through
// `act` equals the exact solver run on the fixture).

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import { valueOf, type NettingConfig } from "./env.ts";
import { evaluatePlan, instanceOf, settleOptimal } from "./plans.ts";
import { NETTING_BAND, nettingEpisodes, nettingFixture } from "./task.ts";

const taskOf = (cell: string): string => `netting/${cell}`;

export function nettingTaskSpecs(root: string, manifest: Manifest, config: NettingConfig): TaskSpec[] {
  return Object.keys(config.cells).sort().map((cell) => ({
    task: taskOf(cell),
    unit: "−ln of the plan's cost in sats; an episode with no accepted plan is scored at twice the floor's cost",
    band: NETTING_BAND,
    floor: "gross",
    ceiling: "min_cost_flow",
    reference: "bilateral_net",
    metrics: ["cost_sats", "transfers", "gross_volume_sats", "ghost_volume_sats"],
    episodes: (seed: number) => nettingEpisodes(root, manifest, config, cell, seed),
  }));
}

/** The four primary contrasts of prereg/v0.md Amendment 3. */
export const NETTING_CONTRASTS: ContrastSpec[] = [
  { id: "N1", label: "`bilateral_net` − `gross`, predicted positive", task: taskOf("bilateral_dense"), a: "bilateral_net", b: "gross", primary: true },
  { id: "N2", label: "`min_cost_flow` − `bilateral_net`, predicted positive", task: taskOf("multilateral_sparse"), a: "min_cost_flow", b: "bilateral_net", primary: true },
  { id: "N3", label: "`min_cost_flow` − `bilateral_net`, predicted positive", task: taskOf("tight_links"), a: "min_cost_flow", b: "bilateral_net", primary: true },
  { id: "N4", label: "`min_cost_flow` − `bilateral_net`, predicted positive", task: taskOf("bilateral_dense"), a: "min_cost_flow", b: "bilateral_net", primary: true },
];

export function nettingGates(_analysis: Analysis, record: RunRecord): Gate[] {
  const tasks = record.tasks.map((t) => t.task).filter((t) => t.startsWith("netting/"));
  const best = (agent: string, task: string): Map<string, number> => new Map(record.rows.filter((r) => r.task === task && r.agent === agent).map((r) => [`${r.seed}|${r.cell}`, r.value]));
  let compared = 0;
  const ceiling: string[] = [];
  const floor: string[] = [];
  for (const task of tasks) {
    const oracle = best("min_cost_flow", task);
    const gross = best("gross", task);
    for (const r of record.rows.filter((x) => x.task === task)) {
      compared += 1;
      if (r.agent !== "min_cost_flow" && r.value > oracle.get(`${r.seed}|${r.cell}`)! + 1e-12) ceiling.push(`${r.agent} ${task} seed ${r.seed}`);
      if (r.agent === "bilateral_net" && r.value + 1e-12 < gross.get(`${r.seed}|${r.cell}`)!) floor.push(`${task} seed ${r.seed}`);
    }
  }
  const identity = checkOf(record, "K12");
  return [
    { id: "K11", description: "`min_cost_flow` ≥ every other policy on every episode (exact at a zero base fee)", pass: ceiling.length === 0, detail: ceiling.length === 0 ? `${compared} comparisons, 0 violations` : `${ceiling.length} violations, first: ${ceiling[0]}` },
    { id: "K12", description: "identity: the ceiling through `act` equals the exact solver run on the fixture", pass: identity?.pass === true, detail: identity?.detail ?? "not run" },
    { id: "K13", description: "`bilateral_net` ≥ `gross` on every episode", pass: floor.length === 0, detail: floor.length === 0 ? "0 violations" : `${floor.length} violations, first: ${floor[0]}` },
  ];
}

export function nettingIdentityCheck(root: string, manifest: Manifest, _config: NettingConfig): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      if (!row.task.startsWith("netting/") || row.agent !== "min_cost_flow") continue;
      const fixture = nettingFixture(root, manifest, row.task.split("/")[1]!, row.seed);
      const instance = instanceOf(fixture);
      const direct = evaluatePlan(instance, settleOptimal(instance));
      compared += 1;
      if (direct.violations.length > 0 || valueOf(direct.cost) !== row.value) mismatches.push(`${row.task} seed ${row.seed}`);
    }
    return [{ id: "K12", pass: compared > 0 && mismatches.length === 0, detail: mismatches.length === 0 ? `${compared} episodes compared, 0 mismatches` : `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}` }];
  };
}

export const nettingReport: ReportSpec = {
  title: "Bitcoin DeFi Bench v0: family 6 (position netting toward a target settlement value), baselines",
  contrasts: NETTING_CONTRASTS,
  gates: nettingGates,
};
