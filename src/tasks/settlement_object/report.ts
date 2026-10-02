// Family 3 report: task specs, the contrasts and gates fixed in prereg/v0.md §11 (Amendment 2),
// and the liquidity-duration ratio the paper's §7 item 2 asks for, with a cluster-robust interval
// over seeds.

import type { Manifest } from "../../harness/manifest.ts";
import type { RunRecord, TaskSpec } from "../../harness/run.ts";
import type { Analysis, ContrastSpec, Gate, ReportSpec } from "../../harness/table.ts";
import type { SettlementConfig } from "./env.ts";
import { SETTLEMENT_BAND, settlementEpisodes } from "./task.ts";

const taskOf = (cell: string): string => `settlement_object/${cell}`;

/** The constant baseline expected to do better in each cell, at the baseline settings. */
const REFERENCE: { [cell: string]: string } = {
  many_bursty_long: "always_channel",
  many_bursty_balanced: "always_vtxo",
  many_bursty_balanced_correlated: "always_channel",
  few_steady_recycling: "always_channel",
};

export function settlementTaskSpecs(root: string, manifest: Manifest, config: SettlementConfig): TaskSpec[] {
  return Object.keys(config.cells).sort().map((cell) => ({
    task: taskOf(cell),
    unit: "−ln 𝒟, with 𝒟 the liquidity duration in blocks; an infeasible choice is scored at twice the largest feasible grid 𝒟",
    band: SETTLEMENT_BAND,
    floor: "random",
    ceiling: "grid_search",
    reference: REFERENCE[cell] ?? "always_channel",
    metrics: ["scored_duration", "feasible", "vtxo", "server_tier_locked", "peak_locked"],
    episodes: (seed: number) => settlementEpisodes(root, manifest, config, cell, seed),
  }));
}

const RATIO = "`always_vtxo` − `always_channel` (= ln 𝒟_C/𝒟_V)";

/** Every hypothesis is the same contrast on a different cell; the predicted sign is in the label. */
export const SETTLEMENT_CONTRASTS: ContrastSpec[] = [
  { id: "H3", label: `${RATIO}, predicted positive`, task: taskOf("many_bursty_balanced"), a: "always_vtxo", b: "always_channel", primary: true },
  { id: "H4", label: `${RATIO}, predicted negative`, task: taskOf("few_steady_recycling"), a: "always_vtxo", b: "always_channel", primary: true },
  { id: "H5", label: `${RATIO}, predicted not positive`, task: taskOf("many_bursty_long"), a: "always_vtxo", b: "always_channel", primary: true },
  { id: "H6", label: `${RATIO}, predicted negative`, task: taskOf("many_bursty_balanced_correlated"), a: "always_vtxo", b: "always_channel", primary: true },
];

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
    ...headroom.map((h): Gate => ({ id: "K8", description: `\`grid_search\` − \`random\` interval above zero on \`${h.task.split("/")[1]}\``, pass: h.d.lo > 0, detail: `${fmt(h.d.mean)} (${fmt(h.d.lo)} to ${fmt(h.d.hi)})`, scope: "cell" })),
    { id: "K9", description: "the server tier fails no payment at a margin of zero or more", pass: true, detail: "enforced by the simulator, which throws otherwise" },
  ];
}

/** The liquidity-duration ratio at the baseline settings, as a geometric mean over seeds, and what the oracle chose. */
function ratioSection(analysis: Analysis, record: RunRecord): string[] {
  const out = ["## Liquidity-duration ratio", ""];
  out.push("𝒟_C / 𝒟_V at the baseline settings (`always_channel` at margin 0.25 against `always_vtxo` at refresh lead 288 and server margin 0.25): the geometric mean over seeds, with the 95% interval of the mean log ratio, unadjusted. A ratio above one favors the VTXO object. The server-tier term is charged. The last column is how often the grid optimum was a VTXO choice.", "");
  out.push("| Cell | Clusters | 𝒟_C / 𝒟_V | 95% interval | Both feasible | Oracle chose VTXO |", "|---|---:|---:|---|---:|---:|");
  for (const task of record.tasks.map((t) => t.task).filter((t) => t.startsWith("settlement_object/"))) {
    const d = analysis.difference(task, "always_vtxo", "always_channel");
    const rows = record.rows.filter((r) => r.task === task && (r.agent === "always_vtxo" || r.agent === "always_channel"));
    const feasible = rows.filter((r) => r.metrics.feasible === 1).length;
    const oracle = record.rows.filter((r) => r.task === task && r.agent === "grid_search");
    const g = (x: number): string => (Math.exp(x) >= 10 ? Math.exp(x).toFixed(1) : Math.exp(x).toPrecision(3));
    out.push(`| \`${task.split("/")[1]}\` | ${d.n} | ${g(d.mean)} | ${g(d.lo)} to ${g(d.hi)} | ${feasible} of ${rows.length} | ${oracle.filter((r) => r.metrics.vtxo === 1).length} of ${oracle.length} |`);
  }
  out.push("");
  return out;
}

export const settlementReport: ReportSpec = {
  title: "Bitcoin DeFi Bench v0: family 3 (settlement-object selection), baselines",
  contrasts: SETTLEMENT_CONTRASTS,
  gates: settlementGates,
  extra: ratioSection,
};
