// Prompt renderer for proof-budget episodes. It states the costs, the measured cost table, the
// arrival process's parameters, and the pending claims; it does not compute an interval or a
// threshold. The examples use counts of one, so a copied example proves claim by claim and runs out
// of proofs, which is what such a policy does.

import type { PromptRenderer } from "../../agents/chat.ts";
import { sha256, type Json } from "../../harness/json.ts";
import type { ProofView } from "./env.ts";
import { meanRate } from "./generate.ts";

interface Observation {
  budget: { attempts: number; blocks: number };
  view: ProofView;
  last: { accepted: boolean; reason: string | null; result: { proven?: number; prover_sats?: number; staleness_sats?: number; block?: number; detail?: string } | null } | null;
}

const SYSTEM = `You run the prover for a registry of claims. Claims arrive block by block, and each has a value in sats. A claim earns nothing until a proof covering it is published. A proof covers the oldest pending claims, as many as you choose up to {max_batch}; you choose when to prove and how many.

Costs, all in sats, and lower total is better:
- Each proof costs {price} sats per second of proving. Measured seconds by batch size: {table}. Between sizes the cost is interpolated, and a batch is never charged more than a larger one.
- Each pending claim costs {ppm} parts per million of its value for every block it waits before its proof.
- Every claim not proven by block {horizon} is lost: its whole value is a cost.
You may publish at most {proofs} proofs in total. Claims arrive {arrivals}; their values are spread between {vmin} and {vmax} sats, more of them small than large.

Reply with exactly one JSON object and nothing else, in one of three forms. To prove the oldest pending claims, here one of them:
{"tool":"prove","args":{"count":1}}
To wait, here one block:
{"tool":"wait","args":{"blocks":1}}
To stop now, losing every claim not yet proven, including every claim still to arrive:
{"tool":"commit"}
The numbers shown are the format only. A proof that is rejected still uses one of your proofs. Your reply is cut off after {limit} tokens.`;

const TURN = `{last}Block {block} of {horizon}. Proofs left: {proofs}.
Pending claims, oldest first (id arrived_at_block value_sats):
{pending}

Reply with one JSON object.`;

const WHY: { [reason: string]: string } = {
  malformed: "your reply was not one complete JSON object of the required form.",
  unknown_tool: "the tool must be prove, wait, or commit.",
  not_integer: "count and blocks must be whole numbers.",
  below_minimum: "count and blocks must be at least 1.",
  out_of_grid: "you asked to prove more claims than are pending.",
  over_budget: "the batch was too large, or the wait went past the horizon.",
  phase_closed: "the episode has ended.",
};

const fill = (template: string, values: { [key: string]: string | number }): string =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

export function proofPrompt(replyTokenLimit: number): PromptRenderer {
  const templates = [SYSTEM, TURN, ...Object.keys(WHY).sort().map((k) => `${k}: ${WHY[k]}`), `limit: ${replyTokenLimit}`];
  return {
    sha256: sha256(templates.join("\n---\n")),
    system(observation: Json): string {
      const o = observation as unknown as Observation;
      const v = o.view;
      const a = v.arrivals;
      const arrivals = a.process === "steady"
        ? `at random, ${a.rate} per block on average`
        : `in bursts: ${a.quiet_rate} per block on average in quiet spells and ${a.burst_rate} in bursts, ${meanRate(a).toFixed(2)} overall; a quiet spell turns into a burst with probability ${a.p_quiet_to_burst} each block and a burst ends with probability ${a.p_burst_to_quiet}`;
      return fill(SYSTEM, {
        max_batch: v.max_batch, price: v.prover_price_sats_per_second, ppm: v.staleness_ppm_per_block, horizon: v.horizon_blocks,
        proofs: o.budget.attempts, arrivals, vmin: a.value_sats_min, vmax: a.value_sats_max, limit: replyTokenLimit,
        table: v.cost_table.filter((g) => g.batch <= v.max_batch).map((g) => `${g.batch} claims ${g.seconds} s`).join(", "),
      });
    },
    turn(observation: Json): string {
      const o = observation as unknown as Observation;
      const v = o.view;
      let last = "";
      if (o.last !== null) {
        const r = o.last.result ?? {};
        if (!o.last.accepted) last = `Your last action was rejected: ${WHY[o.last.reason ?? ""] ?? "it broke a rule."}${r.detail ? ` (${r.detail})` : ""}\n\n`;
        else if (r.proven !== undefined) last = `Proof published: ${r.proven} claims, prover cost ${Math.round(r.prover_sats ?? 0)} sats, staleness ${Math.round(r.staleness_sats ?? 0)} sats.\n\n`;
      }
      return fill(TURN, {
        last, block: v.block, horizon: v.horizon_blocks, proofs: o.budget.attempts,
        pending: v.pending.length ? v.pending.map((c) => `${c.id} ${c.arrived_at} ${c.value_sats}`).join("\n") : "(none)",
      });
    },
  };
}
