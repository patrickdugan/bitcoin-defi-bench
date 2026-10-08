// Family 5 report: task specs, contrasts, gates, and the identity control. Not yet preregistered.

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import { gridOptimum, valueOf } from "./env.ts";
import type { BondingConfig } from "./generate.ts";
import { BONDING_BAND, bondingEpisodes, bondingFixture } from "./task.ts";

const taskOf = (cell: string): string => `bonding/${cell}`;

export function bondingTaskSpecs(root: string, manifest: Manifest, config: BondingConfig): TaskSpec[] {
  return Object.keys(config.cells).sort().map((cell) => ({
    task: taskOf(cell),
    unit: "−ln of the bond's expected cost in sats (Assert fee, capital locked, bond slashed); a bond the counterparty would not admit, or none, is scored at twice the worst admissible grid cost",
    band: BONDING_BAND,
    floor: "random",
    ceiling: "oracle",
    reference: "plug_in",
    metrics: ["cost_sats", "admitted", "delta_blocks", "capital_sats", "assert_fee_sats", "slashed_sats"],
    episodes: (seed: number) => bondingEpisodes(root, manifest, config, cell, seed),
  }));
}

export function bondingContrasts(config: BondingConfig): ContrastSpec[] {
  const cells = Object.keys(config.cells).sort();
  return [
    ...cells.map((cell, i) => ({ id: `F${i + 1}`, label: "`plug_in` − `random`, predicted positive", task: taskOf(cell), a: "plug_in", b: "random", primary: false })),
    ...cells.map((cell, i) => ({ id: `F${cells.length + i + 1}`, label: "`oracle` − `plug_in`, predicted positive: what not knowing the response rate costs", task: taskOf(cell), a: "oracle", b: "plug_in", primary: false })),
    ...cells.map((cell, i) => ({ id: `F${2 * cells.length + i + 1}`, label: "`half_rate` − `plug_in`, descriptive: a margin against a small sample", task: taskOf(cell), a: "half_rate", b: "plug_in", primary: false })),
  ];
}

export function bondingGates(_analysis: Analysis, record: RunRecord): Gate[] {
  const tasks = record.tasks.map((t) => t.task).filter((t) => t.startsWith("bonding/"));
  let compared = 0;
  const above: string[] = [];
  for (const task of tasks) {
    const oracle = new Map(record.rows.filter((r) => r.task === task && r.agent === "oracle").map((r) => [r.seed, r.value]));
    for (const r of record.rows.filter((x) => x.task === task)) {
      compared += 1;
      if (r.agent !== "oracle" && r.value > oracle.get(r.seed)! + 1e-9) above.push(`${r.agent} ${task} seed ${r.seed}`);
    }
  }
  const identity = checkOf(record, "K52");
  return [
    { id: "K51", description: "`oracle` ≥ every other policy on every episode (exact over the grid, knowing the response rate)", pass: above.length === 0, detail: above.length === 0 ? `${compared} comparisons, 0 violations` : `${above.length} violations, first: ${above[0]}` },
    { id: "K52", description: "identity: the oracle through `act` equals the grid optimum computed directly from the fixture, driving the pinned Escrow", pass: identity?.pass === true, detail: identity?.detail ?? "not run" },
  ];
}

export function bondingIdentityCheck(root: string, manifest: Manifest, config: BondingConfig): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      if (!row.task.startsWith("bonding/") || row.agent !== "oracle") continue;
      const direct = gridOptimum(bondingFixture(root, manifest, row.task.split("/")[1]!, row.seed), config.infeasible_penalty_factor);
      compared += 1;
      if (valueOf(direct.cost) !== row.value) mismatches.push(`${row.task} seed ${row.seed}`);
    }
    return [{ id: "K52", pass: compared > 0 && mismatches.length === 0, detail: mismatches.length === 0 ? `${compared} episodes compared, 0 mismatches` : `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}` }];
  };
}

export const bondingReport = (config: BondingConfig): ReportSpec => ({
  title: "Bitcoin DeFi Bench v0: family 5 (service bonding), baselines",
  contrasts: bondingContrasts(config),
  gates: bondingGates,
});
