// Family 3 report, pin-supported variant. Its preregistration sections are not frozen, so nothing
// here is a primary contrast: the direction contrasts and the liquidity-duration ratio are reported
// as exploratory. The ratio is the quantity the paper's §7 item 2 asks for, with a cluster-robust
// interval over seeds.

import type { Manifest } from "../../harness/manifest.ts";
import type { RunRecord, TaskSpec } from "../../harness/run.ts";
import type { Analysis, ContrastSpec, Gate, ReportSpec } from "../../harness/table.ts";
import type { SettlementConfig } from "./env.ts";
import { SETTLEMENT_BAND, settlementEpisodes } from "./task.ts";

const taskOf = (cell: string): string => `settlement_object/${cell}`;

/** The constant baseline expected to win in each cell (the paper's §3.3 direction). */
const REFERENCE: { [cell: string]: string } = {
  many_bursty_long: "always_vtxo",
  few_steady_recycling: "always_channel",
  many_bursty_correlated: "always_vtxo",
};

export function settlementTaskSpecs(root: string, manifest: Manifest, config: SettlementConfig): TaskSpec[] {
  return Object.keys(config.cells).sort().map((cell) => ({
    task: taskOf(cell),
    unit: "−ln 𝒟, with 𝒟 the liquidity duration in blocks; an infeasible choice is scored at twice the largest feasible grid 𝒟",
    band: SETTLEMENT_BAND,
    floor: "random",
    ceiling: "grid_search",
    reference: REFERENCE[cell] ?? "always_vtxo",
    metrics: ["scored_duration", "feasible", "failure_rate", "peak_locked"],
    episodes: (seed: number) => settlementEpisodes(root, manifest, config, cell, seed),
  }));
}

export const SETTLEMENT_CONTRASTS: ContrastSpec[] = Object.keys(REFERENCE).map((cell, i) => ({
  id: `X${i + 1}`, label: "`always_vtxo` − `always_channel` (= ln 𝒟_C/𝒟_V)", task: taskOf(cell), a: "always_vtxo", b: "always_channel", primary: false,
}));

const fmt = (x: number): string => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;

export function settlementGates(analysis: Analysis, record: RunRecord): Gate[] {
  const tasks = record.tasks.map((t) => t.task).filter((t) => t.startsWith("settlement_object/"));
  // K6: the oracle is at least as good as every other policy on every episode. Every baseline's
  // choice is on the grid, so a violation is a harness defect.
  let episodes = 0;
  const violations: string[] = [];
  for (const task of tasks) {
    const oracle = new Map(record.rows.filter((r) => r.task === task && r.agent === "grid_search").map((r) => [`${r.seed}|${r.cell}`, r.value]));
    for (const r of record.rows.filter((x) => x.task === task && x.agent !== "grid_search")) {
      episodes += 1;
      if (r.value > oracle.get(`${r.seed}|${r.cell}`)! + 1e-12) violations.push(`${r.agent} ${task} seed ${r.seed}`);
    }
  }
  const headroom = tasks.map((task) => ({ task, d: analysis.difference(task, "grid_search", "random") }));
  return [
    { id: "K6", description: "`grid_search` ≥ every other policy on every episode", pass: violations.length === 0, detail: violations.length === 0 ? `${episodes} comparisons, 0 violations` : `${violations.length} violations, first: ${violations[0]}` },
    { id: "K8", description: "`grid_search` − `random` interval above zero in each cell", pass: headroom.every((h) => h.d.lo > 0), detail: headroom.map((h) => `${h.task.split("/")[1]} ${fmt(h.d.mean)} (${fmt(h.d.lo)} to ${fmt(h.d.hi)})`).join("; ") },
  ];
}

/** The liquidity-duration ratio at the pinned settings (margin 0.25, refresh lead 288), as a geometric mean over seeds. */
function ratioSection(analysis: Analysis, record: RunRecord): string[] {
  const out = ["## Liquidity-duration ratio", ""];
  out.push("𝒟_C / 𝒟_V at the pinned corner settings (`always_channel` against `always_vtxo`): the geometric mean over seeds, with the 95% interval of the mean log ratio. The paper's §3.3 claim is falsified if the ratio does not exceed one on `many_bursty_long` or does not fall below one on `few_steady_recycling`. Exploratory here: the family's preregistration sections are not frozen, and no server-tier term is charged.", "");
  out.push("| Cell | Clusters | 𝒟_C / 𝒟_V | 95% interval | Both policies feasible |", "|---|---:|---:|---|---:|");
  for (const task of record.tasks.map((t) => t.task).filter((t) => t.startsWith("settlement_object/"))) {
    const d = analysis.difference(task, "always_vtxo", "always_channel");
    const rows = record.rows.filter((r) => r.task === task && (r.agent === "always_vtxo" || r.agent === "always_channel"));
    const feasible = rows.filter((r) => r.metrics.feasible === 1).length;
    const g = (x: number): string => (Math.exp(x) >= 10 ? Math.exp(x).toFixed(1) : Math.exp(x).toPrecision(3));
    out.push(`| \`${task.split("/")[1]}\` | ${d.n} | ${g(d.mean)} | ${g(d.lo)} to ${g(d.hi)} | ${feasible} of ${rows.length} |`);
  }
  out.push("");
  return out;
}

export const settlementReport: ReportSpec = {
  title: "Bitcoin DeFi Bench v0: family 3 (settlement-object selection), pin-supported variant, baselines",
  contrasts: SETTLEMENT_CONTRASTS,
  gates: settlementGates,
  extra: ratioSection,
};
