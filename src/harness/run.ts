// Run orchestration. A run verifies the manifest, then runs every policy (baselines included)
// through the same episode runner, in this process, on the same seeds. Nothing is cached between
// runs: a table always comes from baselines executed alongside whatever else is in the run.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH, type Agent, type Environment } from "./agent.ts";
import { runEpisode, type EpisodeRow } from "./episode.ts";
import { sha256 } from "./json.ts";
import { manifestHash, verifyManifest, type Manifest } from "./manifest.ts";

export interface TaskSpec {
  task: string;
  /** Native unit, for the table. */
  unit: string;
  /** Practical-equivalence band in native units. */
  band: number;
  /** Agent ids that play the floor, ceiling, and reference-heuristic roles. */
  floor: string;
  ceiling: string;
  reference: string;
  /** Metrics to show beside the native value. */
  metrics: string[];
  /** Fresh environments for one seed. Called once per agent. */
  episodes(seed: number): Environment[];
}

export type SeedBlock = "confirmatory" | "development" | "exploratory";

export interface Check { id: string; pass: boolean; detail: string; }

export interface RunRecord {
  bench: string;
  block: SeedBlock;
  manifest_sha256: string;
  prereg_sha256: string;
  spiral_commit: string;
  node: string;
  seeds: number[];
  agents: Array<{ id: string; privileged: boolean; baseline: boolean }>;
  tasks: Array<Omit<TaskSpec, "episodes">>;
  rows: EpisodeRow[];
  /** Family-specific checks computed at run time (for example the identity control). */
  checks: Check[];
}

export interface RunOptions {
  root: string;
  manifest: Manifest;
  block: SeedBlock;
  seeds: number[];
  tasks: TaskSpec[];
  baselines: Agent[];
  agents?: Agent[];
  checks?: (rows: EpisodeRow[]) => Check[];
  progress?: (message: string) => void;
}

export const PREREG_PATH = "prereg/v0.md";

export async function executeRun(options: RunOptions): Promise<RunRecord> {
  const { root, manifest } = options;
  // Refuse to score against any fixture, model file, or config whose hash does not match.
  verifyManifest(root, manifest);
  const seeds = [...options.seeds].sort((a, b) => a - b);
  if (new Set(seeds).size !== seeds.length) throw new Error("seed set contains duplicates");
  const agents = [...options.baselines, ...(options.agents ?? [])];
  if (new Set(agents.map((a) => a.id)).size !== agents.length) throw new Error("agent ids must be unique");
  const rows: EpisodeRow[] = [];
  for (const task of options.tasks) {
    for (const role of [task.floor, task.ceiling, task.reference]) {
      if (!agents.some((a) => a.id === role)) throw new Error(`${task.task}: baseline ${role} is not in the run`);
    }
    for (const seed of seeds) {
      for (const agent of agents) {
        for (const env of task.episodes(seed)) rows.push(await runEpisode(env, agent));
      }
      options.progress?.(`${task.task} seed ${seed}`);
    }
  }
  const baselineIds = new Set(options.baselines.map((a) => a.id));
  return {
    bench: BENCH,
    block: options.block,
    manifest_sha256: manifestHash(manifest),
    prereg_sha256: sha256(readFileSync(join(root, PREREG_PATH))),
    spiral_commit: manifest.spiral.commit,
    node: process.version,
    seeds,
    agents: agents.map((a) => ({ id: a.id, privileged: a.privileged === true, baseline: baselineIds.has(a.id) })),
    tasks: options.tasks.map(({ episodes: _episodes, ...rest }) => rest),
    rows,
    checks: options.checks ? options.checks(rows) : [],
  };
}
