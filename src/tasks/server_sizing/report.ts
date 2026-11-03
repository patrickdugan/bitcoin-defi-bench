// Family 4 report: task specs, contrasts, gates, and the identity control. Frozen by Amendment 10 of
// prereg/v0.md: the six baseline contrasts are its hypotheses, and an agent has one primary contrast
// per cell against `buffer_rule`.

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import { valueOf } from "./env.ts";
import { optimalSchedule } from "./plan.ts";
import { SERVER_SIZING_BAND, serverSizingEpisodes, sizingInput, type ServerSizingConfig } from "./task.ts";

const taskOf = (cell: string): string => `server_sizing/${cell}`;

export function serverSizingTaskSpecs(root: string, manifest: Manifest, config: ServerSizingConfig): TaskSpec[] {
  return Object.keys(config.cells).sort().map((cell) => ({
    task: taskOf(cell),
    unit: "−ln of the horizon's cost in sats: inbound capital, resizing, and failed receipts (total floored at one sat)",
    band: SERVER_SIZING_BAND,
    floor: "static_pilot",
    ceiling: "oracle",
    reference: "buffer_rule",
    metrics: ["cost_sats", "capital_sats", "resize_sats", "failure_sats", "failures", "resizes", "mean_capacity"],
    episodes: (seed: number) => serverSizingEpisodes(root, manifest, config, cell, seed),
  }));
}

/** Amendment 10's hypotheses S1 to S6: two per cell, both predicted positive, adjusted over the six. */
export function serverSizingContrasts(config: ServerSizingConfig): ContrastSpec[] {
  return Object.keys(config.cells).sort().flatMap((cell, i) => [
    { id: `S${2 * i + 1}`, label: "`buffer_rule` − `static_pilot`, predicted positive: resizing against a fixed margin", task: taskOf(cell), a: "buffer_rule", b: "static_pilot", primary: true },
    { id: `S${2 * i + 2}`, label: "`oracle` − `buffer_rule`, predicted positive: knowing the stream against a buffer rule", task: taskOf(cell), a: "oracle", b: "buffer_rule", primary: true },
  ]);
}

/** An agent's primary contrasts: agent − `buffer_rule` per cell, adjusted over the three. Its report shows the baseline contrasts as secondary. */
export function serverSizingAgentContrasts(config: ServerSizingConfig, agent: string): ContrastSpec[] {
  return Object.keys(config.cells).sort().map((cell, i) => ({ id: `A${i + 1}`, label: `\`${agent}\` − \`buffer_rule\``, task: taskOf(cell), a: agent, b: "buffer_rule", primary: true }));
}

export function serverSizingGates(_analysis: Analysis, record: RunRecord): Gate[] {
  const rows = record.rows.filter((r) => r.task.startsWith("server_sizing/"));
  const key = (r: EpisodeRow): string => `${r.task}|${r.seed}|${r.cell}`;
  const oracles = new Map(rows.filter((r) => r.agent === "oracle").map((r) => [key(r), r]));
  const violations = rows.filter((r) => {
    const ceiling = oracles.get(key(r));
    return !ceiling || r.value > ceiling.value + 1e-9;
  });
  const failing = [...oracles.values()].filter((r) => r.metrics.failures !== 0);
  const identity = checkOf(record, "K42");
  return [
    { id: "K41", description: "`oracle` ≥ every other policy on every episode (exact over never-failing schedules)", pass: rows.length > 0 && violations.length === 0, detail: `${rows.length} comparisons, ${violations.length} violations` },
    { id: "K42", description: "identity: the oracle through `act` equals its DP value computed directly from the fixture", pass: identity?.pass === true, detail: identity?.detail ?? "not run" },
    { id: "K43", description: "the oracle never fails a payment", pass: oracles.size > 0 && failing.length === 0, detail: `${oracles.size} oracle episodes, ${failing.length} with failures` },
  ];
}

export function serverSizingIdentityCheck(root: string, manifest: Manifest, config: ServerSizingConfig): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      if (!row.task.startsWith("server_sizing/") || row.agent !== "oracle") continue;
      const input = sizingInput(root, manifest, config, row.task.split("/")[1]!, row.seed);
      const direct = optimalSchedule(input.evaluationPath!, input.params, input.max_inbound_pilot_multiple * input.pilotPath!.peak).cost_sats;
      compared += 1;
      if (Math.abs(valueOf(direct) - row.value) > 1e-9 || Math.abs(direct - row.metrics.cost_sats!) > 1e-9 * Math.max(1, direct)) {
        mismatches.push(`${row.task} seed ${row.seed}`);
      }
    }
    return [{ id: "K42", pass: compared > 0 && mismatches.length === 0,
      detail: mismatches.length ? `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}` : `${compared} episodes compared, 0 mismatches` }];
  };
}

export const serverSizingReport = (config: ServerSizingConfig): ReportSpec => ({
  title: "Bitcoin DeFi Bench v0: family 4 (server inbound resizing), baselines",
  contrasts: serverSizingContrasts(config),
  gates: serverSizingGates,
});
