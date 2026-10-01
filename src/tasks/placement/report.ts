// Family 1 report: task specs, the contrasts and calibration gates fixed in prereg/v0.md §5.1 and
// §6.1, and the identity control (K5).

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import { pairKey } from "../../harness/order.ts";
import { stream } from "../../harness/prng.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import { evaluatePlacements, warmUpHistory, type Placement } from "./env.ts";
import { BALANCE_MODELS, REGIMES, SAMPLING_MODES, type BalanceModel, type PlacementConfig, type PlacementFixture, type Regime } from "./generate.ts";
import { PLACEMENT_BAND, placementEpisodes, placementFixture } from "./task.ts";

export function placementTaskSpecs(root: string, manifest: Manifest, config: PlacementConfig): TaskSpec[] {
  return REGIMES.map((regime) => ({
    task: `placement/${regime}`,
    unit: "success rate over the evaluation demands, percentage points",
    band: PLACEMENT_BAND,
    floor: "random",
    ceiling: "oracle",
    reference: "failure_aware",
    metrics: ["volume_share"],
    episodes: (seed: number) => placementEpisodes(root, manifest, config, `placement/${regime}`, seed),
  }));
}

export const PLACEMENT_CONTRASTS: ContrastSpec[] = [
  { id: "H1", label: "`failure_aware` − `random`", task: "placement/stationary", a: "failure_aware", b: "random", primary: true },
  { id: "H2", label: "`failure_aware` − `random`", task: "placement/shift", a: "failure_aware", b: "random", primary: true },
  { id: "S1", label: "`random` − `none`", task: "placement/stationary", a: "random", b: "none", primary: false },
  { id: "S2", label: "`random` − `none`", task: "placement/shift", a: "random", b: "none", primary: false },
];

/** Calibration windows of prereg/v0.md §5.1. */
export const K1_WINDOW: readonly [number, number] = [3.0, 9.5];
export const K2_WINDOW: readonly [number, number] = [-1.0, 1.0];

const fmt = (x: number): string => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;

export function placementGates(analysis: Analysis, record: RunRecord): Gate[] {
  const gates: Gate[] = [];
  const has = (task: string): boolean => record.tasks.some((t) => t.task === task);
  const meanOf = (task: string, agent: string): number => {
    const m = [...analysis.means(task, agent).values()];
    return m.reduce((a, x) => a + x, 0) / m.length;
  };
  if (has("placement/stationary")) {
    const d = analysis.difference("placement/stationary", "failure_aware", "random");
    gates.push({
      id: "K1", description: `stationary: \`failure_aware\` − \`random\` in [${fmt(K1_WINDOW[0])}, ${fmt(K1_WINDOW[1])}] and interval above zero (Spiral measured +6.13, 4.91 to 7.35)`,
      pass: d.mean >= K1_WINDOW[0] && d.mean <= K1_WINDOW[1] && d.lo > 0,
      detail: `${fmt(d.mean)} (${fmt(d.lo)} to ${fmt(d.hi)})`,
    });
  }
  if (has("placement/shift")) {
    const d = analysis.difference("placement/shift", "failure_aware", "random");
    gates.push({
      id: "K2", description: `shift: \`failure_aware\` − \`random\` in [${fmt(K2_WINDOW[0])}, ${fmt(K2_WINDOW[1])}] and interval not wholly outside the band (Spiral measured +0.44, −0.21 to 1.09)`,
      pass: d.mean >= K2_WINDOW[0] && d.mean <= K2_WINDOW[1] && !(d.lo > PLACEMENT_BAND || d.hi < -PLACEMENT_BAND),
      detail: `${fmt(d.mean)} (${fmt(d.lo)} to ${fmt(d.hi)})`,
    });
  }
  const headroom = record.tasks.filter((t) => t.task.startsWith("placement/")).map((t) => ({ task: t.task, d: analysis.difference(t.task, "oracle", "random") }));
  gates.push({
    id: "K3", description: "`oracle` − `random` interval above zero on each task",
    pass: headroom.every((h) => h.d.lo > 0),
    detail: headroom.map((h) => `${h.task.split("/")[1]} ${fmt(h.d.mean)} (${fmt(h.d.lo)} to ${fmt(h.d.hi)})`).join("; "),
  });
  const order: string[] = [];
  let ordered = true;
  if (has("placement/stationary")) {
    const [o, f, r] = ["oracle", "failure_aware", "random"].map((a) => meanOf("placement/stationary", a)) as [number, number, number];
    ordered &&= o >= f && f >= r;
    order.push(`stationary ${o.toFixed(2)} ≥ ${f.toFixed(2)} ≥ ${r.toFixed(2)}`);
  }
  if (has("placement/shift")) {
    const [o, f, r] = ["oracle", "failure_aware", "random"].map((a) => meanOf("placement/shift", a)) as [number, number, number];
    ordered &&= o >= f && o >= r && f >= r - PLACEMENT_BAND;
    order.push(`shift oracle ${o.toFixed(2)}, failure_aware ${f.toFixed(2)}, random ${r.toFixed(2)}`);
  }
  gates.push({ id: "K4", description: "ordering of means: stationary oracle ≥ failure_aware ≥ random; shift oracle ≥ both and failure_aware ≥ random − 1.0", pass: ordered, detail: order.join("; ") });
  const identity = checkOf(record, "K5");
  gates.push({
    id: "K5", description: "identity: each baseline run through `act` equals its rule computed directly from the fixture",
    pass: identity?.pass === true, detail: identity?.detail ?? "not run",
  });
  return gates;
}

export const placementReport: ReportSpec = {
  title: "Bitcoin DeFi Bench v0: family 1 (directional placement), baselines",
  contrasts: PLACEMENT_CONTRASTS,
  gates: placementGates,
  flags(analysis: Analysis, task: string, agent: string): string[] {
    if (task !== "placement/shift") return [];
    return analysis.difference(task, agent, "random").lo > PLACEMENT_BAND ? ["unexplained_shift_gain"] : [];
  },
  seedGroup: { label: "mode", of: (seed: number) => SAMPLING_MODES[seed % SAMPLING_MODES.length]! },
};

/**
 * Report for a run that includes an agent. Per prereg/v0.md §7 and §9.1 the primary contrasts are
 * agent − `failure_aware` on each task; H1 and H2 were tested in the baseline run and appear here
 * as secondary rows and as gates.
 */
export function placementAgentReport(agentId: string, title: string): ReportSpec {
  return {
    ...placementReport,
    title,
    contrasts: [
      { id: "A1", label: `\`${agentId}\` − \`failure_aware\``, task: "placement/stationary", a: agentId, b: "failure_aware", primary: true },
      { id: "A2", label: `\`${agentId}\` − \`failure_aware\``, task: "placement/shift", a: agentId, b: "failure_aware", primary: true },
      ...PLACEMENT_CONTRASTS.map((c) => ({ ...c, primary: false })),
    ],
  };
}

/**
 * Each baseline's placement computed straight from the fixture, without the observation or the
 * action interface. The identity control compares the simulator's outcome on these placements with
 * what the same rule earned through the episode runner.
 */
export function directPlacements(rule: string, fixture: PlacementFixture, model: BalanceModel, regime: Regime, config: PlacementConfig): Placement[] {
  const budget = config.budget_sats;
  const even = (u: string, v: string): Placement[] => [{ from: u, to: v, sats: Math.floor(budget / 2) }, { from: v, to: u, sats: budget - Math.floor(budget / 2) }];
  const edges = new Set(fixture.edges.map((e) => pairKey(e.u, e.v)));
  const nonEdges: Array<[string, string]> = [];
  for (let i = 0; i < fixture.nodes.length; i++) {
    for (let j = i + 1; j < fixture.nodes.length; j++) {
      if (!edges.has(pairKey(fixture.nodes[i]!, fixture.nodes[j]!))) nonEdges.push([fixture.nodes[i]!, fixture.nodes[j]!]);
    }
  }
  const randomPair = (): [string, string] => stream("baseline/placement/random", fixture.seed, model).pick(nonEdges);
  if (rule === "none") return [];
  if (rule === "random") return even(...randomPair());
  if (rule === "failure_aware") {
    const counts = new Map<string, number>();
    for (const h of warmUpHistory(fixture, model, config)) {
      const key = pairKey(h.source, h.target);
      if (!h.delivered && !edges.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const [key, n] of counts) {
      if (best === null || n > counts.get(best)! || (n === counts.get(best)! && key > best)) best = key;
    }
    if (best === null) return even(...randomPair());
    const [u, v] = best.split("|") as [string, string];
    return even(u, v);
  }
  if (rule === "oracle") {
    const [a, b] = regime === "shift" ? fixture.hotspots.second : fixture.hotspots.first;
    const ahead = Math.round(budget * config.hotspot_forward_probability);
    return [{ from: a, to: b, sats: ahead }, { from: b, to: a, sats: budget - ahead }];
  }
  throw new Error(`no direct rule for ${rule}`);
}

export function placementIdentityCheck(root: string, manifest: Manifest, config: PlacementConfig): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      if (!row.task.startsWith("placement/") || !["none", "random", "failure_aware", "oracle"].includes(row.agent)) continue;
      const regime = row.task.split("/")[1] as Regime;
      const model = row.cell as BalanceModel;
      if (!BALANCE_MODELS.includes(model)) throw new Error(`unknown cell ${row.cell}`);
      const fixture = placementFixture(root, manifest, row.seed);
      const direct = evaluatePlacements(fixture, model, regime, config, directPlacements(row.agent, fixture, model, regime, config));
      compared += 1;
      if (direct.value !== row.value || direct.metrics.delivered !== row.metrics.delivered) {
        mismatches.push(`${row.agent} ${row.task} seed ${row.seed} ${row.cell}`);
      }
    }
    return [{
      id: "K5", pass: compared > 0 && mismatches.length === 0,
      detail: mismatches.length === 0 ? `${compared} episodes compared, 0 mismatches` : `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}`,
    }];
  };
}
