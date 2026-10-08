// Family 10 report: task specs, contrasts, gates, and the identity control. The primary contrasts
// are D1 to D6 of prereg/v0.md Amendment 4.

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import { evaluateDesign, optimize } from "./contract.ts";
import { menuOf, modelFor } from "./designs.ts";
import { valueOf, viewOf } from "./env.ts";
import type { DlcConfig } from "./generate.ts";
import { DLC_BAND, dlcEpisodes, dlcFixture } from "./task.ts";

const taskOf = (cell: string): string => `dlc/${cell}`;

export function dlcTaskSpecs(root: string, manifest: Manifest, config: DlcConfig): TaskSpec[] {
  return Object.keys(config.cells).sort().map((cell) => ({
    task: taskOf(cell),
    unit: "−ln of the design's expected cost in sats (counterparty capital, shortfall, tracking error, signing); an episode with no design offered is scored at twice the floor's cost",
    band: DLC_BAND,
    floor: "spec_default",
    ceiling: "exact",
    reference: "uniform_tuned",
    metrics: ["cost_sats", "cets", "capital_sats", "shortfall_sats", "tracking_sats", "signing_sats"],
    episodes: (seed: number) => dlcEpisodes(root, manifest, config, cell, seed),
  }));
}

/** The six primary contrasts of prereg/v0.md Amendment 4, and its declared secondary ones. */
export function dlcContrasts(config: DlcConfig): ContrastSpec[] {
  const cells = Object.keys(config.cells).sort();
  const primary: ContrastSpec[] = [
    { id: "D1", label: "`uniform_tuned` − `spec_default`, predicted positive", task: taskOf("mobile_signer"), a: "uniform_tuned", b: "spec_default", primary: true },
    { id: "D2", label: "`uniform_tuned` − `spec_default`, predicted positive", task: taskOf("stable_30d"), a: "uniform_tuned", b: "spec_default", primary: true },
    { id: "D3", label: "`uniform_tuned` − `spec_default`, predicted positive", task: taskOf("stable_90d"), a: "uniform_tuned", b: "spec_default", primary: true },
    { id: "D4", label: "`exact` − `uniform_tuned`, predicted positive", task: taskOf("mobile_signer"), a: "exact", b: "uniform_tuned", primary: true },
    { id: "D5", label: "`exact` − `uniform_tuned`, predicted positive", task: taskOf("stable_30d"), a: "exact", b: "uniform_tuned", primary: true },
    { id: "D6", label: "`exact` − `uniform_tuned`, predicted equivalent", task: taskOf("stable_90d"), a: "exact", b: "uniform_tuned", primary: true },
  ];
  const secondary = cells.map((cell, i) => ({ id: `S${i + 1}`, label: "`two_band` − `uniform_tuned`, descriptive: how much of the gap flat tails close", task: taskOf(cell), a: "two_band", b: "uniform_tuned", primary: false }));
  return [...primary, ...secondary];
}

export function dlcGates(_analysis: Analysis, record: RunRecord): Gate[] {
  const tasks = record.tasks.map((t) => t.task).filter((t) => t.startsWith("dlc/"));
  const values = (agent: string, task: string): Map<string, number> => new Map(record.rows.filter((r) => r.task === task && r.agent === agent).map((r) => [`${r.seed}|${r.cell}`, r.value]));
  let compared = 0;
  const ceiling: string[] = [];
  const reference: string[] = [];
  for (const task of tasks) {
    const exact = values("exact", task);
    const floor = values("spec_default", task);
    for (const r of record.rows.filter((x) => x.task === task)) {
      compared += 1;
      if (r.agent !== "exact" && r.value > exact.get(`${r.seed}|${r.cell}`)! + 1e-9) ceiling.push(`${r.agent} ${task} seed ${r.seed}`);
      if (r.agent === "uniform_tuned" && r.value + 1e-9 < floor.get(`${r.seed}|${r.cell}`)!) reference.push(`${task} seed ${r.seed}`);
    }
  }
  const identity = checkOf(record, "K15");
  return [
    { id: "K14", description: "`exact` ≥ every other policy on every episode (exact over the menu)", pass: ceiling.length === 0, detail: ceiling.length === 0 ? `${compared} comparisons, 0 violations` : `${ceiling.length} violations, first: ${ceiling[0]}` },
    { id: "K15", description: "identity: the ceiling through `act` equals the optimizer run on the fixture, whose own accounting agrees with the evaluator", pass: identity?.pass === true, detail: identity?.detail ?? "not run" },
    { id: "K16", description: "`uniform_tuned` ≥ `spec_default` on every episode", pass: reference.length === 0, detail: reference.length === 0 ? "0 violations" : `${reference.length} violations, first: ${reference[0]}` },
  ];
}

export function dlcIdentityCheck(root: string, manifest: Manifest, _config: DlcConfig): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      if (!row.task.startsWith("dlc/") || row.agent !== "exact") continue;
      const fixture = dlcFixture(root, manifest, row.task.split("/")[1]!, row.seed);
      const view = viewOf(fixture);
      const model = modelFor(fixture.contract);
      const direct = optimize(model, menuOf(view));
      const again = evaluateDesign(model, direct.design);
      compared += 1;
      const agrees = direct.costs.cets === again.cets && Math.abs(direct.costs.total_sats - again.total_sats) <= 1e-9 * again.total_sats;
      if (!agrees || valueOf(again.total_sats) !== row.value) mismatches.push(`${row.task} seed ${row.seed}`);
    }
    return [{ id: "K15", pass: compared > 0 && mismatches.length === 0, detail: mismatches.length === 0 ? `${compared} episodes compared, 0 mismatches` : `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}` }];
  };
}

export const dlcReport = (config: DlcConfig): ReportSpec => ({
  title: "Bitcoin DeFi Bench v0: family 10 (designing a numeric DLC), baselines",
  contrasts: dlcContrasts(config),
  gates: dlcGates,
});
