// Prompt renderer for family 12 (docs/tasks.md §15). It states the claim graph's mechanics, the
// watcher's machine, the tools, and the scoring, then shows each turn's budget, the evaluator, the
// visible claims, and the last result as compact JSON. It describes what happens, never what to do:
// which claims to evaluate, in what order, and what to bid are what the family measures, and what
// the `bitvm3_watch` skill computes.

import type { PromptRenderer } from "../../agents/chat.ts";
import { sha256, type Json } from "../../harness/json.ts";
import type { Bitvm3View } from "./env.ts";

interface Observation {
  budget: { attempts: number; probes: number; blocks: number };
  tools: string[];
  view: Bitvm3View;
  last: { accepted: boolean; reason: string | null; result: Json } | null;
}

const SYSTEM = `You are the watcher of a vault split into BitVM3 claim graphs, one per vault UTXO. Each graph pays a claimant out of its UTXO once a payment proof checks out: a garbled copy of the proof's final verifier (785,442,492 gates) decides, and Bitcoin enforces the verdict.

How a claim works:
1. A claim transaction spends a vault UTXO into a claim output (the UTXO less a 416-sat presigned fee) and carries OP_RETURN "IOB3" with the claim's id. You see a claim, with the input labels of its proof, from the block it confirms in.
2. The claim output has two leaves. The payout leaf pays P' after a {window}-block relative timelock: if the output is still unspent {window} blocks after the claim's block, the payout confirms then. The disprove leaf is spendable before that with the reject label of the claim's garbled verifier, and returns the output to the vault. So a disprove must confirm by the claim's block + {last}.
3. Only evaluating the garbled verifier on the claim's input labels yields a label. A valid proof yields the accept label, which opens nothing; an invalid one yields the reject label. A disprove without the reject label is refused.
4. Some claims are fraudulent. Of all claims, {honest_pct}% are honest, {wrong_pct}% hand over a valid proof of another statement, and {invalid_pct}% hand over a proof that verifies but input labels that encode a different, invalid one. The native check verifies the handed-over proof against the vault's statement in milliseconds: it fails for a proof of another statement and passes for the other two kinds.
5. You have one machine. An evaluation takes {eval} blocks and costs {cost} sats, and only one runs at a time.
6. A transaction confirms in a block whose clearing fee rate is at most its bid; rates move every block and can spike. A disprove is {vb} vB. A replacement must bid more than the disprove it replaces, and only the confirmed version pays. Blocks can be reorganized: a claim confirmed again later restarts its timelock, and a disprove in a replaced block goes back to the mempool. Always read a claim's current confirmed_height.

Scoring, in sats: the sum over the claims you disprove of the claim output less the disprove's fee, less {cost} for every evaluation you start, at block {horizon}. Doing nothing scores 0: every claim pays out.

Tools, one per reply:
- {"tool":"check","args":{"claim":"c01"}}: the native check of that claim's proof.
- {"tool":"evaluate","args":{"claim":"c01"}}: start the garbled evaluation of that claim; the verdict appears {eval} blocks later.
- {"tool":"disprove","args":{"claim":"c01","fee_rate":12}}: broadcast or replace the disprove, fee_rate in whole sats per vbyte.
- {"tool":"wait","args":{"blocks":1}}: let blocks pass.
- {"tool":"stop"}: end your watch; pending disproves still confirm if they can.
Reply with exactly one JSON object and nothing else. A rejected reply costs an attempt. Your reply is cut off after {limit} tokens.`;

const TURN = `Block {height}. Blocks left: {blocks}. Steps left: {probes}. Attempts left: {attempts}. Fee estimate: {fee} sat/vB.
Evaluator: {evaluator}
Claims: {claims}
{last}
Reply with one JSON object.`;

const fill = (template: string, values: { [key: string]: string | number }): string =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

const pct = (ppm: number): string => String(ppm / 10_000);

export function bitvm3Prompt(replyTokenLimit: number): PromptRenderer {
  return {
    sha256: sha256([SYSTEM, TURN, `limit: ${replyTokenLimit}`].join("\n---\n")),
    system(observation: Json): string {
      const v = (observation as unknown as Observation).view;
      return fill(SYSTEM, {
        window: v.window_blocks, last: v.window_blocks - 1, eval: v.evaluator.eval_blocks, cost: v.evaluator.cost_sats, vb: v.vbytes_disprove,
        honest_pct: pct(v.fraud_prior_ppm.honest), wrong_pct: pct(v.fraud_prior_ppm.wrong_statement), invalid_pct: pct(v.fraud_prior_ppm.invalid_proof),
        horizon: v.horizon_height, limit: replyTokenLimit,
      });
    },
    turn(observation: Json): string {
      const o = observation as unknown as Observation;
      const v = o.view;
      const last = o.last === null ? "Nothing has happened yet."
        : o.last.accepted ? `Last result: ${JSON.stringify(o.last.result)}`
        : `Your last reply was rejected (${o.last.reason}): ${JSON.stringify(o.last.result)}`;
      return fill(TURN, {
        height: v.height, blocks: o.budget.blocks, probes: o.budget.probes, attempts: o.budget.attempts, fee: v.fee_estimate_sat_vb,
        evaluator: JSON.stringify(v.evaluator), claims: v.claims.length === 0 ? "none yet" : JSON.stringify(v.claims), last,
      });
    },
  };
}
