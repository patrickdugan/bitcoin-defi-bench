// Family 7 wiring: config, fixtures, episodes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment } from "../../harness/agent.ts";
import { ManifestError, loadFixture, type Manifest } from "../../harness/manifest.ts";
import { ProofEnv } from "./env.ts";
import { fixturePath, type ProofBudgetConfig, type ProofFixture } from "./generate.ts";

/** Practical-equivalence band in ln cost, as families 6 and 10. Not yet preregistered. */
export const PROOF_BAND = 0.05;

export function loadProofConfig(root: string): ProofBudgetConfig {
  return JSON.parse(readFileSync(join(root, "config/proof_budget.json"), "utf8")) as ProofBudgetConfig;
}

const loaded = new Map<string, ProofFixture>();

export function proofFixture(root: string, manifest: Manifest, cell: string, seed: number): ProofFixture {
  const path = fixturePath(cell, seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  const key = `${root}|${path}|${entry.sha256}`;
  let fixture = loaded.get(key);
  if (!fixture) { fixture = loadFixture<ProofFixture>(root, manifest, path); loaded.set(key, fixture); }
  return fixture;
}

/** One episode per seed per cell. */
export function proofEpisodes(root: string, manifest: Manifest, cell: string, seed: number): Environment[] {
  return [new ProofEnv(proofFixture(root, manifest, cell, seed))];
}
