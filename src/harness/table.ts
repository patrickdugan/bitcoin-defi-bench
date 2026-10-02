// Results table writer (markdown). The table is a pure function of a run record and the declared
// contrasts and gates: rendering the same record twice gives the same bytes, and the footer binds
// the record by hash. There is no aggregate row and no function that combines task families; the
// output is a profile.

import { canonical, sha256 } from "./json.ts";
import type { EpisodeRow } from "./episode.ts";
import type { Check, RunRecord } from "./run.ts";
import { CLIP, clusterInterval, clusterMeans, normalizedGain, pairedDifference, verdict, verdictLabel, type Interval, type NormalizedGain } from "./stats.ts";

export interface ContrastSpec {
  id: string;
  label: string;
  task: string;
  a: string;
  b: string;
  /** Primary contrasts are Bonferroni-adjusted over the number of primary contrasts in the report. */
  primary: boolean;
}

/** A family-level gate blocks agent reporting for the family when it fails; a cell-level gate only marks its own cell. */
export interface Gate { id: string; description: string; pass: boolean; detail: string; scope?: "family" | "cell"; }

export interface ReportSpec {
  title: string;
  contrasts: ContrastSpec[];
  gates(analysis: Analysis, record: RunRecord): Gate[];
  /** Extra audit flags for a non-baseline agent on a task. */
  flags?(analysis: Analysis, task: string, agent: string): string[];
  /** Subgroup of a seed for the secondary breakdown (for example the sampling mode). */
  seedGroup?: { label: string; of(seed: number): string };
  /** Family-specific sections, placed after the secondary table. */
  extra?(analysis: Analysis, record: RunRecord): string[];
}

export interface PolicyResult {
  agent: string;
  episodes: number;
  mean: number;
  vsFloor: Interval | null;
  gain: NormalizedGain | null;
  metrics: { [name: string]: number };
}

export interface Analysis {
  means(task: string, agent: string, filter?: (row: EpisodeRow) => boolean): Map<number, number>;
  difference(task: string, a: string, b: string, comparisons?: number, filter?: (row: EpisodeRow) => boolean): Interval;
  policies(task: string): PolicyResult[];
}

export function analyze(record: RunRecord): Analysis {
  const rowsFor = (task: string, agent: string, filter?: (row: EpisodeRow) => boolean): EpisodeRow[] =>
    record.rows.filter((r) => r.task === task && r.agent === agent && (!filter || filter(r)));
  const means = (task: string, agent: string, filter?: (row: EpisodeRow) => boolean): Map<number, number> =>
    clusterMeans(rowsFor(task, agent, filter));
  const difference = (task: string, a: string, b: string, comparisons = 1, filter?: (row: EpisodeRow) => boolean): Interval =>
    pairedDifference(means(task, a, filter), means(task, b, filter), 0.05, comparisons);
  const policies = (task: string): PolicyResult[] => {
    const spec = record.tasks.find((t) => t.task === task);
    if (!spec) throw new Error(`unknown task ${task}`);
    return record.agents.map(({ id }) => {
      const rows = rowsFor(task, id);
      const m = means(task, id);
      const metrics: { [name: string]: number } = {};
      for (const name of spec.metrics) {
        const perSeed = clusterMeans(rows.map((r) => ({ seed: r.seed, cell: r.cell, value: r.metrics[name]! })));
        metrics[name] = [...perSeed.values()].reduce((a, x) => a + x, 0) / perSeed.size;
      }
      return {
        agent: id,
        episodes: rows.length,
        mean: clusterInterval([...m.values()]).mean,
        vsFloor: id === spec.floor ? null : difference(task, id, spec.floor),
        gain: id === spec.floor || id === spec.ceiling ? null : normalizedGain(m, means(task, spec.floor), means(task, spec.ceiling)),
        metrics,
      };
    });
  };
  return { means, difference, policies };
}

const f2 = (x: number): string => x.toFixed(2).replace(/^-0\.00$/, "0.00").replace("-", "−");
const f1 = (x: number): string => String(x).replace("-", "−");
const signed = (x: number): string => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
const ci = (i: Interval): string => `${signed(i.mean)} (${signed(i.lo)} to ${signed(i.hi)})`;

function gainCell(g: NormalizedGain | null, role: string): string {
  if (g === null) return role;
  if (!g.defined) return "n/a (no headroom)";
  return `${f2(g.gain)} (${f2(g.lo)} to ${f2(g.hi)})${g.clipped ? " clipped" : ""}`;
}

function seedRanges(seeds: number[]): string {
  const parts: string[] = [];
  let start = seeds[0]!;
  let prev = start;
  for (const s of [...seeds.slice(1), NaN]) {
    if (s === prev + 1) { prev = s; continue; }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = s; prev = s;
  }
  return parts.join(", ");
}

export function renderTable(record: RunRecord, spec: ReportSpec): string {
  const analysis = analyze(record);
  const out: string[] = [];
  const blockNote: { [block: string]: string } = {
    confirmatory: "confirmatory seeds; covered by the preregistration where a contrast is listed as primary or as a gate",
    development: "development seeds; nothing here is a reported result",
    exploratory: "exploratory seeds; not covered by the preregistration",
  };
  out.push(`# ${spec.title}`, "");
  out.push("Generated by the harness from a run record. Do not edit.", "");
  out.push("| | |", "|---|---|");
  out.push(`| Bench | \`${record.bench}\` |`);
  out.push(`| Seed block | ${record.block}: ${blockNote[record.block]} |`);
  out.push(`| Seeds | ${seedRanges(record.seeds)} (${record.seeds.length} clusters) |`);
  out.push(`| Policies | ${record.agents.map((a) => `\`${a.id}\`${a.privileged ? " (privileged)" : ""}${a.baseline ? "" : " (agent)"}`).join(", ")} |`);
  out.push(`| Manifest SHA-256 | \`${record.manifest_sha256}\` |`);
  out.push(`| Preregistration SHA-256 | \`${record.prereg_sha256}\` |`);
  out.push(`| Spiral commit | \`${record.spiral_commit}\` |`);
  out.push(`| Node | ${record.node} |`, "");
  out.push(`Intervals are two-sided 95% Student-t intervals over seed clusters. The normalized gain is Σ(policy − floor) / Σ(ceiling − floor) over seeds with a delete-one-cluster jackknife interval, clipped to [${f1(CLIP[0])}, ${f1(CLIP[1])}]. Each task is reported on its own; there is no composite score.`, "");

  if (record.notes && record.notes.length > 0) out.push("## Run notes", "", ...record.notes.map((n) => `- ${n}`), "");

  out.push("## Profile", "");
  for (const task of record.tasks) {
    const metricHeads = task.metrics.map((m) => ` ${m} |`).join("");
    out.push(`### \`${task.task}\``, "");
    out.push(`Native value: ${task.unit}. Floor \`${task.floor}\`, ceiling \`${task.ceiling}\`, reference heuristic \`${task.reference}\`. Equivalence band ±${task.band}.`, "");
    out.push(`| Policy | Episodes | Mean | Δ vs \`${task.floor}\` | Normalized gain |${metricHeads}`);
    out.push(`|---|---:|---:|---|---|${task.metrics.map(() => "---:|").join("")}`);
    for (const p of analysis.policies(task.task)) {
      const role = p.agent === task.floor ? "0 (floor)" : "1 (ceiling)";
      const metricCells = task.metrics.map((m) => ` ${f2(p.metrics[m]!)} |`).join("");
      out.push(`| \`${p.agent}\` | ${p.episodes} | ${f2(p.mean)} | ${p.vsFloor ? ci(p.vsFloor) : "—"} | ${gainCell(p.gain, role)} |${metricCells}`);
    }
    out.push("");
  }

  const primaries = spec.contrasts.filter((c) => c.primary && record.tasks.some((t) => t.task === c.task));
  const m = primaries.length;
  out.push("## Primary contrasts", "");
  if (m === 0) {
    out.push("None in this run.", "");
  } else {
    out.push(`${m} primary contrast${m === 1 ? "" : "s"}. The adjusted interval is Bonferroni-adjusted for ${m} comparison${m === 1 ? "" : "s"} (family-wise 95%); the verdict is read from the adjusted interval.`, "");
    out.push("| Id | Contrast | Task | Unadjusted 95% | Adjusted | Verdict |", "|---|---|---|---|---|---|");
    for (const c of primaries) {
      const band = record.tasks.find((t) => t.task === c.task)!.band;
      const adjusted = analysis.difference(c.task, c.a, c.b, m);
      out.push(`| ${c.id} | ${c.label} | \`${c.task}\` | ${ci(analysis.difference(c.task, c.a, c.b))} | ${ci(adjusted)} | ${verdictLabel(verdict(adjusted, band))} |`);
    }
    out.push("");
  }

  const gates = spec.gates(analysis, record);
  out.push("## Calibration gates", "");
  const cellLevel = gates.some((g) => g.scope === "cell") ? " A cell-level gate that fails withholds only that cell's normalized gains." : "";
  out.push(`Checks on the harness, read from unadjusted intervals. A failed gate blocks agent reporting for the family.${cellLevel}`, "");
  out.push("| Gate | Check | Result | Detail |", "|---|---|---|---|");
  for (const g of gates) out.push(`| ${g.id} | ${g.description}${g.scope === "cell" ? " (cell-level)" : ""} | ${g.pass ? "pass" : "**FAIL**"} | ${g.detail} |`);
  out.push("");

  const secondary = spec.contrasts.filter((c) => !c.primary && record.tasks.some((t) => t.task === c.task));
  out.push("## Secondary, declared and descriptive", "");
  out.push("Unadjusted intervals.", "");
  const secondaryStart = out.length;
  out.push("| Contrast | Task | Group | Clusters | Difference |", "|---|---|---|---:|---|");
  for (const c of [...primaries, ...secondary]) {
    if (!c.primary) {
      const all = analysis.difference(c.task, c.a, c.b);
      out.push(`| ${c.label} | \`${c.task}\` | all | ${all.n} | ${ci(all)} |`);
    }
    const cells = [...new Set(record.rows.filter((r) => r.task === c.task).map((r) => r.cell))].sort();
    if (cells.length > 1) {
      for (const cell of cells) {
        const d = analysis.difference(c.task, c.a, c.b, 1, (r) => r.cell === cell);
        out.push(`| ${c.label} | \`${c.task}\` | cell ${cell} | ${d.n} | ${ci(d)} |`);
      }
    }
    if (spec.seedGroup) {
      const groups = [...new Set(record.seeds.map((s) => spec.seedGroup!.of(s)))].sort();
      for (const group of groups) {
        const filter = (r: EpisodeRow): boolean => spec.seedGroup!.of(r.seed) === group;
        if (record.seeds.filter((s) => spec.seedGroup!.of(s) === group).length < 2) continue;
        const d = analysis.difference(c.task, c.a, c.b, 1, filter);
        out.push(`| ${c.label} | \`${c.task}\` | ${spec.seedGroup.label} ${group} | ${d.n} | ${ci(d)} |`);
      }
    }
  }
  // No breakdowns and no secondary contrasts: say so instead of printing an empty table.
  if (out.length === secondaryStart + 2) out.splice(secondaryStart - 2, 4, "No contrast of this kind in this run; see the family's own section below.");
  out.push("");

  if (spec.extra) out.push(...spec.extra(analysis, record));

  const gateFailed = gates.some((g) => !g.pass && g.scope !== "cell");
  const flagged: string[] = [];
  for (const task of record.tasks) {
    for (const p of analysis.policies(task.task)) {
      const meta = record.agents.find((a) => a.id === p.agent)!;
      if (meta.baseline) continue;
      const flags: string[] = [];
      if (p.gain?.defined && p.gain.gain > 1) flags.push("exceeds_oracle");
      if (gateFailed) flags.push("baseline_off_calibration");
      flags.push(...(spec.flags?.(analysis, task.task, p.agent) ?? []));
      if (flags.length) flagged.push(`| \`${p.agent}\` | \`${task.task}\` | ${flags.join(", ")} |`);
    }
  }
  out.push("## Flagged, pending audit", "");
  if (flagged.length === 0) {
    out.push(record.agents.some((a) => !a.baseline) ? "None." : "No agent in this run; baselines only.", "");
  } else {
    out.push("These rows are not results until an audit note is attached (prereg §9).", "");
    out.push("| Policy | Task | Flags |", "|---|---|---|", ...flagged, "");
  }

  const rejected = new Map<string, number>();
  for (const r of record.rows) for (const x of r.rejections) rejected.set(`${r.agent}|${x.reason}`, (rejected.get(`${r.agent}|${x.reason}`) ?? 0) + 1);
  out.push("## Rejected actions", "");
  if (rejected.size === 0) {
    out.push("None.", "");
  } else {
    out.push("| Policy | Reason | Count |", "|---|---|---:|");
    for (const key of [...rejected.keys()].sort()) out.push(`| \`${key.split("|")[0]}\` | ${key.split("|")[1]} | ${rejected.get(key)} |`);
    out.push("");
  }

  out.push(`Run record SHA-256: \`${recordHash(record)}\``, "");
  return out.join("\n");
}

export const recordHash = (record: RunRecord): string => sha256(canonical(record));

export const checkOf = (record: RunRecord, id: string): Check | undefined => record.checks.find((c) => c.id === id);
