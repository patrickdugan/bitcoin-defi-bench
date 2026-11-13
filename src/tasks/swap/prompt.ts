// Prompt renderer for family 11 (docs/tasks.md §14). It states the swap's mechanics, the host's DAG
// workflow, and the scoring, then shows each turn's admitted tools, the budget, and the last result
// as compact JSON. It describes what happens, never what to do: when to fund, how deep to wait, and
// what to bid are what the family measures, and what the `swap_workflow` skill computes.

import type { PromptRenderer } from "../../agents/chat.ts";
import { sha256, type Json } from "../../harness/json.ts";
import type { SwapView } from "./baselines.ts";

interface Observation {
  budget: { attempts: number; probes: number; blocks: number };
  tools: string[];
  view: SwapView;
  last: { accepted: boolean; reason: string | null; result: Json } | null;
}

const SYSTEM = `You are a customer's agent swapping {amount_in} sats with a payout desk through two hashed time-locked contracts (BIP 199 scripts, P2WSH). Your wallet holds a secret preimage whose SHA-256 is {digest}.

How the swap works:
1. You fund the in-HTLC with {amount_in} sats. The desk can claim it with your preimage; you can refund it after block {in_timeout}. The quote is good only at block {h0}: fund then or never. Funding confirms in the next block.
2. After your funding confirms, the desk is supposed to lock a payout HTLC of {amount_out} sats that you can claim with the preimage and that the desk can refund after its locktime, promised {out_timeout} blocks after its lock confirms. The host shows the payout's script; decode it with the inspect tool.
3. You claim the payout. The claim reveals the preimage, so from then on the desk can take the in-HTLC. If your claim has not confirmed by the payout's locktime, the desk refunds the payout and you lose both.
Desks differ and you cannot see which kind you face. A lock that confirmed can be removed by a chain reorganization. A transaction confirms in a block whose clearing fee rate is at most its bid; rates move every block and can spike. A replacement must bid more than the transaction it replaces. Only a confirmed transaction pays its fee.
If you never broadcast the preimage, the host's armed refund returns your {amount_in} sats after block {in_timeout}, bidding {mult} times that block's clearing rate.

Scoring, in sats: your wallet's change by block {horizon}, plus {value} if the swap completed (your claim confirmed and stood). Not funding scores 0.

The host runs every action as a workflow and admits only the tools listed each turn: market.observe (chain evidence), host.inspect_evidence {"action": "fund_in" | "claim_out" | "refund_in"}, host.validate_arguments {"fee_rate": <whole sats per vbyte>, needed for claim_out and refund_in}, host.simulate_action, host.display_exact_effects_and_fees, wallet.request_approval, host.execute_approved (broadcasts), host.verify_effect, host.reconcile_ledger, host.persist_verified_state (ends the pass), host.hold_for_review {"blocks": n} (waits n blocks; an approval is good only in the block it was given), host.refresh_evidence, host.resume_persisted_state, and incident.revoke_and_freeze (ends the episode; the armed refund still runs). The episode also ends once the swap settles or the blocks run out.

Reply with exactly one JSON object and nothing else, for example {"tool":"host.inspect_evidence","args":{"action":"claim_out"}} or {"tool":"host.hold_for_review","args":{"blocks":1}}. A rejected reply costs an attempt. Your reply is cut off after {limit} tokens.`;

const TURN = `Block {height}. Workflow node: {node}. Blocks left: {blocks}. Steps left: {probes}. Attempts left: {attempts}.
Tools admitted now: {tools}
{last}
Reply with one JSON object.`;

const fill = (template: string, values: { [key: string]: string | number }): string =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

export function swapPrompt(replyTokenLimit: number): PromptRenderer {
  return {
    sha256: sha256([SYSTEM, TURN, `limit: ${replyTokenLimit}`].join("\n---\n")),
    system(observation: Json): string {
      const v = (observation as unknown as Observation).view;
      const q = v.quote;
      return fill(SYSTEM, {
        amount_in: q.amount_in_sats, amount_out: q.amount_out_sats, digest: v.wallet.preimage_digest, in_timeout: q.in_timeout_height,
        h0: q.quote_valid_at_height, out_timeout: q.out_timeout_blocks, mult: v.armed_refund_fee_multiplier,
        horizon: v.height + (observation as unknown as Observation).budget.blocks,
        value: q.swap_value_sats, limit: replyTokenLimit,
      });
    },
    turn(observation: Json): string {
      const o = observation as unknown as Observation;
      const last = o.last === null ? "Nothing has happened yet."
        : o.last.accepted ? `Last result: ${JSON.stringify(o.last.result)}`
        : `Your last reply was rejected (${o.last.reason}): ${JSON.stringify(o.last.result)}`;
      return fill(TURN, { height: o.view.height, node: o.view.workflow.node, blocks: o.budget.blocks, probes: o.budget.probes, attempts: o.budget.attempts, tools: o.tools.join(", "), last });
    },
  };
}
