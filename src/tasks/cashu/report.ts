// Family 14 report: task specs, contrasts, gates, and the identity control (docs/tasks.md §17). The
// family is built on development seeds only; the contrasts are descriptive until an amendment fixes
// them.

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import type { CashuConfig } from "./generate.ts";
import { CASHU_BAND, cashuCells, cashuEpisodes, cashuFixture } from "./task.ts";
import { ceilingOf, defaultValue } from "./world.ts";

export const cashuTask = (cell: string): string => `cashu/${cell}`;

export const CASHU_METRICS = ["admitted", "admitted_bad", "accepted", "accepted_bad", "checks", "refresh_fees", "exit_fees", "watcher_exits", "move_fees", "float_lost"];

export function cashuTaskSpecs(root: string, manifest: Manifest, config: CashuConfig): TaskSpec[] {
  return cashuCells(config).map((cell) => ({
    task: cashuTask(cell),
    unit: "sats: the desk's profit and loss over the horizon (fees and margins earned, bad intake, refresh, exit, withdrawal and move-out fees, float lost when the mint halts); the host's defaults alone score `idle`'s value",
    band: CASHU_BAND,
    floor: "idle",
    ceiling: "oracle",
    reference: "proof_grove",
    metrics: CASHU_METRICS,
    episodes: (seed: number) => cashuEpisodes(root, manifest, config, cell, seed),
  }));
}

export function cashuContrasts(config: CashuConfig): ContrastSpec[] {
  const out: ContrastSpec[] = [];
  for (const cell of cashuCells(config)) {
    const task = cashuTask(cell);
    out.push(
      { id: `C1-${cell}`, label: "`proof_grove` − `accept_all`, descriptive: what the intake checks are worth", task, a: "proof_grove", b: "accept_all", primary: false },
      { id: `C2-${cell}`, label: "`proof_grove` − `no_dleq`, descriptive: what checking proofs and DLEQs is worth over trusting the mint", task, a: "proof_grove", b: "no_dleq", primary: false },
      { id: `C3-${cell}`, label: "`proof_grove` − `late_refresh`, descriptive: what the 144-block refresh margin is worth over 72", task, a: "proof_grove", b: "late_refresh", primary: false },
      { id: `C4-${cell}`, label: "`oracle` − `proof_grove`, descriptive: the headroom left above the reference", task, a: "oracle", b: "proof_grove", primary: false },
    );
  }
  return out;
}

export function cashuGates(root: string, manifest: Manifest, config: CashuConfig) {
  return (_analysis: Analysis, record: RunRecord): Gate[] => {
    const rows = record.rows.filter((r) => r.task.startsWith("cashu/"));
    const fixtureOf = (r: EpisodeRow) => cashuFixture(root, manifest, r.task.split("/")[1]!, r.seed);
    const idle = rows.filter((r) => r.agent === "idle");
    const idleOff = idle.filter((r) => r.value !== defaultValue(config, fixtureOf(r)) || r.metrics.admitted !== 0 || r.metrics.accepted !== 0);
    const best = new Map(rows.filter((r) => r.agent === "oracle").map((r) => [`${r.task}|${r.seed}`, r.value]));
    const over = rows.filter((r) => r.agent !== "oracle" && best.has(`${r.task}|${r.seed}`) && r.value > best.get(`${r.task}|${r.seed}`)!);
    const reference = rows.filter((r) => r.agent === "proof_grove");
    const bad = reference.filter((r) => r.metrics.admitted_bad !== 0 || r.metrics.accepted_bad !== 0);
    const identity = checkOf(record, "K142");
    return [
      { id: "K141", description: "`idle` earns exactly the host's defaults computed from the fixture, and admits and accepts nothing", pass: idle.length > 0 && idleOff.length === 0, detail: idleOff.length === 0 ? `${idle.length} episodes` : `${idleOff.length} off, first ${idleOff[0]!.task} seed ${idleOff[0]!.seed}` },
      { id: "K142", description: "identity: `oracle` through `act` earns exactly the ceiling computed from the fixture", pass: identity?.pass === true, detail: identity?.detail ?? "not run" },
      { id: "K143", description: "`oracle` ≥ every other policy on every episode (exact ceiling)", pass: over.length === 0, detail: over.length === 0 ? `${rows.length} episodes, 0 violations` : `${over.length} violations, first: ${over[0]!.agent} ${over[0]!.task} seed ${over[0]!.seed}` },
      { id: "K144", description: "`proof_grove` admits no deposit that fails to pay and accepts no bad token (the NUT and admission checks work)", pass: reference.length > 0 && bad.length === 0, detail: bad.length === 0 ? `${reference.length} episodes` : `${bad.length} episodes with bad intake, first ${bad[0]!.task} seed ${bad[0]!.seed}` },
    ];
  };
}

export function cashuIdentityCheck(root: string, manifest: Manifest, config: CashuConfig): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      if (!row.task.startsWith("cashu/") || row.agent !== "oracle") continue;
      compared += 1;
      const direct = ceilingOf(config, cashuFixture(root, manifest, row.task.split("/")[1]!, row.seed)).value;
      if (direct !== row.value) mismatches.push(`${row.task} seed ${row.seed}: ${row.value} through act, ${direct} direct`);
    }
    return [{ id: "K142", pass: compared > 0 && mismatches.length === 0, detail: mismatches.length === 0 ? `${compared} episodes compared, 0 mismatches` : `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}` }];
  };
}

/** Where each policy's value goes, summed over seeds, so a reader sees what each one gets wrong. */
function ledger(root: string, manifest: Manifest) {
  return (_analysis: Analysis, record: RunRecord): string[] => {
    const rows = record.rows.filter((r) => r.task.startsWith("cashu/"));
    const tasks = [...new Set(rows.map((r) => r.task))].sort();
    const out = ["## Where the value goes, summed over seeds", "", "| Task | Policy | Bad deposits admitted | Bad tokens accepted | Refresh fees | Exit fees | Watcher exits | Move-out fees | Float lost |", "|---|---|---:|---:|---:|---:|---:|---:|---:|"];
    for (const task of tasks) {
      for (const agent of [...new Set(rows.map((r) => r.agent))]) {
        const xs = rows.filter((r) => r.task === task && r.agent === agent);
        const sum = (m: string): number => xs.reduce((a, r) => a + (r.metrics[m] ?? 0), 0);
        out.push(`| \`${task}\` | \`${agent}\` | ${sum("admitted_bad")} | ${sum("accepted_bad")} | ${sum("refresh_fees")} | ${sum("exit_fees")} | ${sum("watcher_exits")} | ${sum("move_fees")} | ${sum("float_lost")} |`);
      }
    }
    const halts = [...new Set(rows.filter((r) => r.task === "cashu/reserve_shortfall").map((r) => r.seed))].filter((s) => cashuFixture(root, manifest, "reserve_shortfall", s).mint.failure_height !== null);
    const outages = [...new Set(rows.filter((r) => r.task === "cashu/operator_outage").map((r) => r.seed))].filter((s) => cashuFixture(root, manifest, "operator_outage", s).outage !== null);
    out.push("", `The mint halts on ${halts.length} of the \`reserve_shortfall\` seeds; the Ark server has an outage on ${outages.length} of the \`operator_outage\` seeds. Both are hidden from every policy except \`oracle\`.`, "");
    return out;
  };
}

export const cashuReport = (config: CashuConfig, root: string, manifest: Manifest): ReportSpec => ({
  title: "Bitcoin DeFi Bench v0: family 14 (a Cashu desk backed by Ark, after Proof Grove), baselines",
  contrasts: cashuContrasts(config),
  gates: cashuGates(root, manifest, config),
  extra: ledger(root, manifest),
});
