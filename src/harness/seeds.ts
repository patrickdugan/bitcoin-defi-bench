// Seed blocks fixed in prereg/v0.md §3. A confirmatory block may be run only for a family whose
// preregistration sections are frozen.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const range = (start: number, count: number): number[] => Array.from({ length: count }, (_, i) => start + i);

export const SEED_BLOCKS = {
  development: range(0, 8),
  confirmatory: range(1000, 32),
  reserve_1: range(1100, 32),
  reserve_2: range(1200, 32),
} as const;

/** Families whose sections the preregistration declares frozen (the "Frozen families:" line). */
export function frozenFamilies(root: string): string[] {
  const text = readFileSync(join(root, "prereg/v0.md"), "utf8");
  const line = text.split("\n").find((l) => l.startsWith("Frozen families:"));
  if (!line) return [];
  return line.slice("Frozen families:".length).split(",").map((s) => s.trim().replace(/[.*`]/g, "")).filter((s) => s !== "" && s !== "none");
}

export function requireFrozen(root: string, family: string): void {
  if (!frozenFamilies(root).includes(family)) {
    throw new Error(`prereg/v0.md does not list "${family}" as frozen; confirmatory seeds cannot be run for it`);
  }
}
