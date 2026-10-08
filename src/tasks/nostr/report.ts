// Family 9 report: one run record and one table per cell, because each cell has its own baselines
// and the harness runs every policy of a record on every task. Task specs, the contrasts the draft
// amendment proposes (docs/nostr_amendment_draft.md), gates, and the identity controls for the
// cells whose ceiling is exact.

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import { counterpartyCeiling, type CounterpartyFixture } from "./counterparty.ts";
import { custodyCeiling, type CustodyFixture } from "./custody.ts";
import { custodyHotCeiling, type CustodyHotFixture } from "./custody_hot.ts";
import { privateCeiling, type PrivateFixture } from "./private.ts";
import { nostrEpisodes, nostrFixture, type NostrCell, type NostrConfig } from "./task.ts";

interface CellSpec {
  title: string;
  unit: string;
  band: number;
  ceiling: string;
  reference: string;
  metrics: string[];
  /** Whether the ceiling is exact, so that nothing may beat it and an identity control applies. */
  exact: boolean;
}

/** Bands in sats are [invented] and are fixed by the amendment that freezes the family. */
export const NOSTR_CELL_SPECS: { [cell in NostrCell]: CellSpec } = {
  custody: { title: "protect the key: approve or reject signer and wallet requests", unit: "sats: legitimate requests approved, minus losses from hostile ones; a key export costs the stake", band: 500, ceiling: "policy", reference: "kinds_only", metrics: ["legit_approved", "hostile_approved", "compromised"], exact: true },
  custody_hot: { title: "protect the key: answer direct messages while holding the nsec", unit: "sats: legitimate requests answered, minus losses from hostile ones; a leaked key costs the stake", band: 300, ceiling: "policy", reference: "no_key_paste", metrics: ["legit_answered", "hostile_answered", "leaks"], exact: true },
  publish: { title: "post where the audience reads (NIP-65)", unit: "sats: readers reached, at a value per follower and per mention, minus relay fees", band: 500, ceiling: "max_reach", reference: "outbox", metrics: ["followers_reached", "mentions_reached", "fees_sats", "relay_writes"], exact: false },
  private: { title: "deliver private messages (NIP-17, NIP-44, NIP-59)", unit: "sats: messages each recipient's client opened, NIP-04 discounted, minus messages exposed in the clear", band: 500, ceiling: "nip17", reference: "legacy_everywhere", metrics: ["nip17_delivered", "nip04_delivered", "exposed"], exact: true },
  counterparty: { title: "buy a service from a counterparty (NIP-90, NIP-47, NIP-61)", unit: "sats: the job's value if a result arrives by the deadline, minus everything paid", band: 1000, ceiling: "oracle", reference: "cheapest", metrics: ["delivered", "paid_sats", "paid_impostor", "lost_nutzaps"], exact: true },
  mesh_outage: { title: "deliver over the bitchat mesh with no internet", unit: "sats: messages delivered by their deadlines, minus a price per radio transmission", band: 500, ceiling: "oracle", reference: "bitchat_router", metrics: ["delivered", "transmissions", "by_courier"], exact: false },
  mesh_partial: { title: "deliver over the bitchat mesh with intermittent internet", unit: "sats: messages delivered by their deadlines, minus a price per radio transmission", band: 500, ceiling: "oracle", reference: "bitchat_router", metrics: ["delivered", "transmissions", "by_courier", "by_nostr"], exact: false },
};

export const nostrTask = (cell: NostrCell): string => `nostr/${cell}`;

export function nostrTaskSpec(root: string, manifest: Manifest, config: NostrConfig, cell: NostrCell): TaskSpec {
  const s = NOSTR_CELL_SPECS[cell];
  return {
    task: nostrTask(cell), unit: s.unit, band: s.band,
    floor: "idle", ceiling: s.ceiling, reference: s.reference, metrics: s.metrics,
    episodes: (seed: number) => nostrEpisodes(root, manifest, config, cell, seed),
  };
}

/**
 * The draft amendment's hypotheses (docs/nostr_amendment_draft.md), two per cell, each a design
 * claim of the cell: H1 to H14. Each cell is its own primary family, adjusted for its two.
 */
export const NOSTR_HYPOTHESES: { [cell in NostrCell]: Array<{ id: string; a: string; b: string; sign: "positive" | "negative" }> } = {
  custody: [{ id: "H1", a: "policy", b: "idle", sign: "positive" }, { id: "H2", a: "kinds_only", b: "idle", sign: "negative" }],
  custody_hot: [{ id: "H3", a: "policy", b: "idle", sign: "positive" }, { id: "H4", a: "no_key_paste", b: "idle", sign: "negative" }],
  publish: [{ id: "H5", a: "outbox", b: "random", sign: "positive" }, { id: "H6", a: "max_reach", b: "outbox", sign: "positive" }],
  private: [{ id: "H7", a: "nip17", b: "legacy_everywhere", sign: "positive" }, { id: "H8", a: "plaintext_mention", b: "idle", sign: "negative" }],
  counterparty: [{ id: "H9", a: "reputation", b: "cheapest", sign: "positive" }, { id: "H10", a: "oracle", b: "cheapest", sign: "positive" }],
  mesh_outage: [{ id: "H11", a: "bitchat_router", b: "flood_now", sign: "positive" }, { id: "H12", a: "oracle", b: "bitchat_router", sign: "positive" }],
  mesh_partial: [{ id: "H13", a: "bitchat_router", b: "nostr_only", sign: "positive" }, { id: "H14", a: "oracle", b: "bitchat_router", sign: "positive" }],
};

export function nostrContrasts(cell: NostrCell): ContrastSpec[] {
  const task = nostrTask(cell);
  return NOSTR_HYPOTHESES[cell].map((h) => ({ id: h.id, label: `\`${h.a}\` − \`${h.b}\`, predicted ${h.sign}`, task, a: h.a, b: h.b, primary: true }));
}

/** The ceiling computed directly from the fixture, for the cells where it is exact. */
function directCeiling(root: string, manifest: Manifest, config: NostrConfig, cell: NostrCell, seed: number): number | null {
  switch (cell) {
    case "custody": return custodyCeiling(nostrFixture<CustodyFixture>(root, manifest, cell, seed));
    case "custody_hot": return custodyHotCeiling(nostrFixture<CustodyHotFixture>(root, manifest, cell, seed));
    case "private": return privateCeiling(nostrFixture<PrivateFixture>(root, manifest, cell, seed), config.private);
    case "counterparty": return counterpartyCeiling(nostrFixture<CounterpartyFixture>(root, manifest, cell, seed));
    default: return null;
  }
}

/** Identity control (K92): where the ceiling is exact, the ceiling baseline through `act` earns exactly the direct computation. */
export function nostrIdentityCheck(root: string, manifest: Manifest, config: NostrConfig, cell: NostrCell): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    if (!NOSTR_CELL_SPECS[cell].exact) return [{ id: "K92", pass: true, detail: "not applicable: this cell's ceiling is a reference, not an exact optimum" }];
    const ceiling = NOSTR_CELL_SPECS[cell].ceiling;
    let compared = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      if (row.task !== nostrTask(cell) || row.agent !== ceiling) continue;
      compared += 1;
      const direct = directCeiling(root, manifest, config, cell, row.seed);
      if (direct !== row.value) mismatches.push(`seed ${row.seed}: ${row.value} through act, ${direct} direct`);
    }
    return [{ id: "K92", pass: compared > 0 && mismatches.length === 0, detail: mismatches.length === 0 ? `${compared} episodes compared, 0 mismatches` : `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}` }];
  };
}

export function nostrGates(cell: NostrCell): (analysis: Analysis, record: RunRecord) => Gate[] {
  return (_analysis, record) => {
    const task = nostrTask(cell);
    const s = NOSTR_CELL_SPECS[cell];
    const rows = record.rows.filter((r) => r.task === task);
    const idleNonzero = rows.filter((r) => r.agent === "idle" && r.value !== 0);
    const gates: Gate[] = [
      { id: "K91", description: "`idle` earns exactly 0 on every episode (doing nothing is safe and earns nothing)", pass: idleNonzero.length === 0, detail: idleNonzero.length === 0 ? `${rows.filter((r) => r.agent === "idle").length} episodes` : `${idleNonzero.length} nonzero, first seed ${idleNonzero[0]!.seed}` },
    ];
    const identity = checkOf(record, "K92");
    gates.push({ id: "K92", description: "identity: where the ceiling is exact, the ceiling through `act` equals the direct computation", pass: identity?.pass === true, detail: identity?.detail ?? "not run" });
    if (s.exact) {
      const best = new Map(rows.filter((r) => r.agent === s.ceiling).map((r) => [r.seed, r.value]));
      const over = rows.filter((r) => r.agent !== s.ceiling && r.value > best.get(r.seed)!);
      gates.push({ id: "K93", description: `\`${s.ceiling}\` ≥ every other policy on every episode (exact ceiling)`, pass: over.length === 0, detail: over.length === 0 ? `${rows.length} episodes, 0 violations` : `${over.length} violations, first: ${over[0]!.agent} seed ${over[0]!.seed}` });
    }
    return gates;
  };
}

export function nostrReport(cell: NostrCell): ReportSpec {
  return {
    title: `Bitcoin DeFi Bench v0: family 9, \`nostr/${cell}\` (${NOSTR_CELL_SPECS[cell].title}), baselines`,
    contrasts: nostrContrasts(cell),
    gates: nostrGates(cell),
  };
}
