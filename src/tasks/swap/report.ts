// Family 11 report: task specs, contrasts, gates, and the identity control (docs/tasks.md §14). The
// family is built on development seeds only; the contrasts are descriptive until an amendment fixes
// them.

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import type { SwapConfig } from "./generate.ts";
import { SWAP_BAND, swapCells, swapEpisodes, swapFixture } from "./task.ts";
import { ceilingOf } from "./world.ts";

export const swapTask = (cell: string): string => `swap/${cell}`;

export const SWAP_METRICS = ["funded", "completed", "refunded", "lost", "fees_sats", "revealed"];

export function swapTaskSpecs(root: string, manifest: Manifest, config: SwapConfig): TaskSpec[] {
  return swapCells(config).map((cell) => ({
    task: swapTask(cell),
    unit: "sats: the customer's wallet change at the horizon, plus the swap's value if it completed; doing nothing scores 0",
    band: SWAP_BAND,
    floor: "idle",
    ceiling: "oracle",
    reference: "workflow",
    metrics: SWAP_METRICS,
    episodes: (seed: number) => swapEpisodes(root, manifest, config, cell, seed),
  }));
}

export function swapContrasts(config: SwapConfig): ContrastSpec[] {
  const out: ContrastSpec[] = [];
  for (const cell of swapCells(config)) {
    const task = swapTask(cell);
    out.push(
      { id: `W1-${cell}`, label: "`workflow` − `trusting`, descriptive: what the workflow's checks are worth", task, a: "workflow", b: "trusting", primary: false },
      { id: `W2-${cell}`, label: "`workflow` − `no_depth`, descriptive: what waiting for three confirmations is worth", task, a: "workflow", b: "no_depth", primary: false },
      { id: `W3-${cell}`, label: "`workflow` − `estimate_fee`, descriptive: what fee headroom and re-bidding are worth", task, a: "workflow", b: "estimate_fee", primary: false },
      { id: `W4-${cell}`, label: "`oracle` − `workflow`, descriptive: the headroom left above the reference", task, a: "oracle", b: "workflow", primary: false },
    );
  }
  return out;
}

export function swapGates(_analysis: Analysis, record: RunRecord): Gate[] {
  const rows = record.rows.filter((r) => r.task.startsWith("swap/"));
  const idle = rows.filter((r) => r.agent === "idle");
  const idleNonzero = idle.filter((r) => r.value !== 0);
  const best = new Map(rows.filter((r) => r.agent === "oracle").map((r) => [`${r.task}|${r.seed}`, r.value]));
  const over = rows.filter((r) => r.agent !== "oracle" && best.has(`${r.task}|${r.seed}`) && r.value > best.get(`${r.task}|${r.seed}`)!);
  const identity = checkOf(record, "K112");
  return [
    { id: "K111", description: "`idle` earns exactly 0 on every episode (never funding is safe and earns nothing)", pass: idle.length > 0 && idleNonzero.length === 0, detail: idleNonzero.length === 0 ? `${idle.length} episodes` : `${idleNonzero.length} nonzero, first seed ${idleNonzero[0]!.seed}` },
    { id: "K112", description: "identity: `oracle` through the DAG earns exactly the ceiling computed from the fixture", pass: identity?.pass === true, detail: identity?.detail ?? "not run" },
    { id: "K113", description: "`oracle` ≥ every other policy on every episode (exact ceiling)", pass: over.length === 0, detail: over.length === 0 ? `${rows.length} episodes, 0 violations` : `${over.length} violations, first: ${over[0]!.agent} ${over[0]!.task} seed ${over[0]!.seed}` },
  ];
}

export function swapIdentityCheck(root: string, manifest: Manifest): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      if (!row.task.startsWith("swap/") || row.agent !== "oracle") continue;
      compared += 1;
      const direct = ceilingOf(swapFixture(root, manifest, row.task.split("/")[1]!, row.seed)).value;
      if (direct !== row.value) mismatches.push(`${row.task} seed ${row.seed}: ${row.value} through act, ${direct} direct`);
    }
    return [{ id: "K112", pass: compared > 0 && mismatches.length === 0, detail: mismatches.length === 0 ? `${compared} episodes compared, 0 mismatches` : `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}` }];
  };
}

/** Outcomes by desk behaviour, so a reader sees where each policy wins and loses. */
function byDesk(root: string, manifest: Manifest) {
  return (_analysis: Analysis, record: RunRecord): string[] => {
    const rows = record.rows.filter((r) => r.task.startsWith("swap/"));
    const agents = [...new Set(rows.map((r) => r.agent))];
    const desks = new Map<string, string>();
    for (const r of rows) desks.set(`${r.task}|${r.seed}`, swapFixture(root, manifest, r.task.split("/")[1]!, r.seed).desk.type);
    const types = [...new Set(desks.values())].sort();
    const out = ["## Mean value by desk behaviour (sats)", "", `| Policy | ${types.map((t) => `${t} (n)`).join(" | ")} |`, `|---|${types.map(() => "---:").join("|")}|`];
    for (const a of agents) {
      const cells = types.map((t) => {
        const xs = rows.filter((r) => r.agent === a && desks.get(`${r.task}|${r.seed}`) === t).map((r) => r.value);
        return xs.length ? `${Math.round(xs.reduce((s, x) => s + x, 0) / xs.length)} (${xs.length})` : "—";
      });
      out.push(`| \`${a}\` | ${cells.join(" | ")} |`);
    }
    out.push("", "Desk behaviour is hidden from every policy except `oracle`. Both cells pooled.", "");
    return out;
  };
}

export const swapReport = (config: SwapConfig, root: string, manifest: Manifest): ReportSpec => ({
  title: "Bitcoin DeFi Bench v0: family 11 (swap with a payout desk through HTLCs, as a BitAgent DAG workflow), baselines",
  contrasts: swapContrasts(config),
  gates: swapGates,
  extra: byDesk(root, manifest),
});
