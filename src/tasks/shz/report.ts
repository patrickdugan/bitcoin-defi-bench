// Family 13 report: task specs, contrasts, gates, and the identity control (docs/tasks.md §16). The
// family is built on development seeds only; the contrasts are descriptive until an amendment fixes
// them.

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import type { ShzConfig } from "./generate.ts";
import { SHZ_BAND, shzCells, shzEpisodes, shzFixture } from "./task.ts";
import { ceilingOf, idleValue, takeOutcome } from "./world.ts";

export const shzTask = (cell: string): string => `shz/${cell}`;

export const SHZ_METRICS = ["tracking_sats", "execution_sats", "taker_fee_sats", "lightning_fee_sats", "capital_sats", "penalty_sats", "liquidations", "rogue_fills", "premium_takes"];

export function shzTaskSpecs(root: string, manifest: Manifest, config: ShzConfig): TaskSpec[] {
  return shzCells(config).map((cell) => ({
    task: shzTask(cell),
    unit: "sats: minus the hedge's tracking error and every cost (execution, taker fees, Lightning fees, capital, penalties); the unhedged holder scores minus its tracking error",
    band: SHZ_BAND,
    floor: "idle",
    ceiling: "oracle",
    reference: "hedger",
    metrics: SHZ_METRICS,
    episodes: (seed: number) => shzEpisodes(root, manifest, config, cell, seed),
  }));
}

export function shzContrasts(config: ShzConfig): ContrastSpec[] {
  const out: ContrastSpec[] = [];
  for (const cell of shzCells(config)) {
    const task = shzTask(cell);
    out.push(
      { id: `D1-${cell}`, label: "`hedger` − `premium_always`, descriptive: what taking on the free tier saves", task, a: "hedger", b: "premium_always", primary: false },
      { id: `D2-${cell}`, label: "`hedger` − `unverified`, descriptive: what verifying the mark packet is worth", task, a: "hedger", b: "unverified", primary: false },
      { id: `D3-${cell}`, label: "`hedger` − `thin_margin`, descriptive: what the margin buffer is worth", task, a: "hedger", b: "thin_margin", primary: false },
      { id: `D4-${cell}`, label: "`hedger` − `naive`, descriptive: what following the target and the checks are worth together", task, a: "hedger", b: "naive", primary: false },
      { id: `D5-${cell}`, label: "`oracle` − `hedger`, descriptive: the headroom left above the reference", task, a: "oracle", b: "hedger", primary: false },
    );
  }
  return out;
}

export function shzGates(_analysis: Analysis, record: RunRecord): Gate[] {
  const rows = record.rows.filter((r) => r.task.startsWith("shz/"));
  const best = new Map(rows.filter((r) => r.agent === "oracle").map((r) => [`${r.task}|${r.seed}`, r.value]));
  const over = rows.filter((r) => r.agent !== "oracle" && best.has(`${r.task}|${r.seed}`) && r.value > best.get(`${r.task}|${r.seed}`)!);
  const idle = checkOf(record, "K131");
  const identity = checkOf(record, "K132");
  return [
    { id: "K131", description: "`idle` earns exactly minus the unhedged tracking error computed from the fixture, on every episode", pass: idle?.pass === true, detail: idle?.detail ?? "not run" },
    { id: "K132", description: "identity: `oracle` through `act` earns exactly the dynamic program's value computed from the fixture", pass: identity?.pass === true, detail: identity?.detail ?? "not run" },
    { id: "K133", description: "`oracle` ≥ every other policy on every episode (exact ceiling)", pass: over.length === 0, detail: over.length === 0 ? `${rows.length} episodes, 0 violations` : `${over.length} violations, first: ${over[0]!.agent} ${over[0]!.task} seed ${over[0]!.seed}` },
  ];
}

export function shzIdentityCheck(root: string, manifest: Manifest, config: ShzConfig): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    const out: Check[] = [];
    for (const [id, agent, direct] of [
      ["K131", "idle", (cell: string, seed: number) => idleValue(shzFixture(root, manifest, cell, seed), config)],
      ["K132", "oracle", (cell: string, seed: number) => ceilingOf(shzFixture(root, manifest, cell, seed), config).value],
    ] as const) {
      let compared = 0;
      const mismatches: string[] = [];
      for (const row of rows) {
        if (!row.task.startsWith("shz/") || row.agent !== agent) continue;
        compared += 1;
        const d = direct(row.task.split("/")[1]!, row.seed);
        if (d !== row.value) mismatches.push(`${row.task} seed ${row.seed}: ${row.value} through act, ${d} direct`);
      }
      out.push({ id, pass: compared > 0 && mismatches.length === 0, detail: mismatches.length === 0 ? `${compared} episodes compared, 0 mismatches` : `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}` });
    }
    return out;
  };
}

const signed = (n: number): string => (n < 0 ? `−${-n}` : `${n}`);

/** The reference against the ceiling, and the latency study's tension measured on the fixtures. */
function extra(root: string, manifest: Manifest, config: ShzConfig) {
  return (_analysis: Analysis, record: RunRecord): string[] => {
    const rows = record.rows.filter((r) => r.task.startsWith("shz/"));
    const out = ["## The reference against the ceiling", "", "| Task | `hedger` mean | `oracle` mean | Mean gap | Largest gap (seed) | Episodes where `hedger` = `oracle` |", "|---|---:|---:|---:|---:|---:|"];
    for (const task of [...new Set(rows.map((r) => r.task))].sort()) {
      const h = rows.filter((r) => r.task === task && r.agent === "hedger");
      const o = new Map(rows.filter((r) => r.task === task && r.agent === "oracle").map((r) => [r.seed, r.value]));
      if (h.length === 0) continue;
      const gaps = h.map((r) => ({ seed: r.seed, gap: o.get(r.seed)! - r.value }));
      const worst = gaps.reduce((a, b) => (b.gap > a.gap ? b : a));
      const mean = (xs: number[]): string => signed(Math.round(xs.reduce((a, x) => a + x, 0) / xs.length));
      out.push(`| \`${task}\` | ${mean(h.map((r) => r.value))} | ${mean([...o.values()])} | ${mean(gaps.map((g) => g.gap))} | ${signed(worst.gap)} (${worst.seed}) | ${gaps.filter((g) => g.gap === 0).length} of ${gaps.length} |`);
    }
    // The latency study's tension: how often the paid tier is cheaper ex post for a one-lot take on a genuine packet.
    let slots = 0;
    let cheaper = 0;
    const kinds = new Map<string, number>();
    for (const task of [...new Set(rows.map((r) => r.task))].sort()) {
      const cell = task.split("/")[1]!;
      for (const seed of record.seeds) {
        const f = shzFixture(root, manifest, cell, seed);
        for (let t = 0; t < f.steps; t++) {
          for (let r = 0; r < config.slots_per_step; r++) {
            const kind = f.packets[t]![r]!.kind;
            kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
            if (kind !== "genuine") continue;
            for (const side of ["sell", "buy"] as const) {
              const std = takeOutcome(f, config, t, r, side, 1, "standard")!;
              const pre = takeOutcome(f, config, t, r, side, 1, "premium")!;
              slots += 1;
              if (pre.execution + pre.taker_fee + pre.lightning < std.execution + std.taker_fee + std.lightning) cheaper += 1;
            }
          }
        }
      }
    }
    out.push("", "## The paid tier, ex post", "",
      `Over every genuine packet slot of these fixtures, a one-lot take on the paid tier would have cost less than on the free tier in ${cheaper} of ${slots} slot-and-side cases (${(100 * cheaper / Math.max(1, slots)).toFixed(3)}%). The 200 ms move is calibrated to the latency study's BTC premium gross-saving quantiles, under which the saving exceeds the 2 bp fee on 0.058% of decisions; the study found the paid tier the ex-post winner among three tiers 0.022% of the time. \`oracle\`, which sees every 200 ms move, took on the paid tier ${rows.filter((r) => r.agent === "oracle").reduce((a, r) => a + (r.metrics.premium_takes ?? 0), 0)} times.`,
      "", "## Packet slots by kind", "", "| Kind | Slots |", "|---|---:|",
      ...[...kinds.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `| \`${k}\` | ${n} |`),
      "", "Kinds are hidden from every policy except `oracle`.", "");
    return out;
  };
}

export const shzReport = (config: ShzConfig, root: string, manifest: Manifest): ReportSpec => ({
  title: "Bitcoin DeFi Bench v0: family 13 (hedging on the SatsHedgeZero Lightning venue), baselines",
  contrasts: shzContrasts(config),
  gates: shzGates,
  extra: extra(root, manifest, config),
});
