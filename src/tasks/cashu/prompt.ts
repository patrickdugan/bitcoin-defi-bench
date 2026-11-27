// Prompt renderer for family 14 (docs/tasks.md §17). It states the desk's mechanics, the tools, and
// the scoring, puts the mint's keysets in the system prompt, and shows each turn's block, budget,
// pending items in full, VTXOs, the mint's report, and the last result as compact JSON. It describes
// what happens, never what to do: which checks to run, when to refresh, and when to move the float
// are what the family measures, and what the `cashu_desk` skill computes.

import type { PromptRenderer } from "../../agents/chat.ts";
import { sha256, type Json } from "../../harness/json.ts";

interface Observation {
  budget: { attempts: number; probes: number; blocks: number };
  view: {
    height: number; horizon_height: number; fee_rate_sat_vb: number; operator_online: boolean; float_sats: number;
    mint: { status: string; keysets: Json; report: Json };
    policy: { min_confirmations: number; max_tip_lag: number; desk_fee_ppm: number; token_margin_ppm: number; refresh_fee: Json; move_out_fee: Json; exit_vbytes: number; exit_runway_blocks: number; watcher_fee_multiplier: number; withdrawal_fee_limit_sats: number };
    intents: Json; claimed_outpoints: Json; pending: Json; checks: Json; vtxos: Json; alerts: Json;
  };
  last: { accepted: boolean; reason: string | null; result: Json } | null;
}

const SYSTEM = `You operate a Cashu ecash desk backed by Ark, from block {h0} to block {horizon}. You hold {float} sats of ecash at one mint (your float) and the VTXOs listed each turn. Each block, deposits, Cashu tokens offered in payment, and withdrawal requests can arrive.

Deposits. A depositor registers an intent (an amount and a deposit script, one script per intent) and submits evidence of an on-chain payment: an M16 PAY1 proof of the payment, or a report from the mint that it was paid, which carries no proof. Admitting a deposit issues the intent's amount less your fee of {fee_ppm} ppm; you keep the difference only if the payment really delivered that amount to that intent's script and stays in the active chain. proof.verify {"deposit": id} runs the pinned verifier on the proof. chain.check {"deposit": id} asks your Bitcoin node for the block at the payment's height. A deposit not decided in its block is refused. The desk's stated policy is at least {min_conf} confirmations and a proof tip at most {tip_lag} blocks behind.

Tokens. A buyer pays with a Cashu token; accepting it hands over goods worth its amount less your margin of {margin_ppm} ppm. A token is worth its amount only if every proof carries a valid NUT-12 DLEQ under the key, for its amount, of a keyset this mint lists (active or inactive), and no proof is already spent. The DLEQ check is offline: Y = hash_to_curve(secret), C' = C + rA, B' = Y + rG, R1 = sG - eA, R2 = sB' - eC', and e must equal hash_e(R1, R2, A, C'). mint.check_state {"token": id} asks the mint (NUT-07) whether each proof's Y is spent; the mint answers UNSPENT for any Y it has never seen. A token not decided in its block is refused. The mint's keysets:
{keysets}

Withdrawals. A user redeems ecash from your float into an Ark VTXO through the processor; withdrawal.dispatch {"withdrawal": id} pays the current quote. The outbox dispatches it at its deadline if you have not.

VTXOs. A VTXO must be refreshed in a round (ark.refresh {"vtxos": [ids]}, only while the Ark server is online) or exited unilaterally on-chain before it expires. Refresh fee: {refresh}, one base fee per request, the ppm chosen by blocks left to expiry. An exit (ark.exit {"vtxos": [ids]}) costs {exit_vb} vB at the block's fee rate per VTXO and needs more than {runway} blocks before expiry. At the last block that allows, a watcher exits any VTXO still live, bidding {mult} times the rate.

The mint. Each round the mint publishes its reserve and its outstanding liabilities. A mint can halt; the ecash you hold then is lost. mint.move_out {"amount_sats": n} moves n sats of float into your Ark wallet for {move}.

Scoring, in sats: fees and margins earned, minus what bad deposits and bad tokens cost, minus every withdrawal, refresh, exit, and move-out fee, minus float lost to a halt. Principal that only changes form scores 0.

Budget: each check costs one probe; each decision (admit, refuse, accept, dispatch, refresh, exit, move_out) costs one attempt, and so does a rejected reply; wait {"blocks": n} costs the blocks it waits and stops early at the next alert; end stops the episode and leaves the rest to the defaults above.

Reply with exactly one JSON object and nothing else, for example {"tool":"proof.verify","args":{"deposit":"d01"}} or {"tool":"wait","args":{"blocks":6}}. Your reply is cut off after {limit} tokens.`;

const TURN = `Block {height} of {horizon}. Fee rate {fee} sat/vB. Ark server {online}. Float {float} sats. Mint {mint_status}; latest report {report}.
Probes left: {probes}. Attempts left: {attempts}. Blocks left: {blocks}.
Alerts: {alerts}
Intents registered: {intents}
Claimed outpoints: {claimed}
Pending: {pending}
Checks this block: {checks}
VTXOs: {vtxos}
{last}
Reply with one JSON object.`;

const fill = (template: string, values: { [key: string]: string | number }): string =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

const j = (x: Json): string => JSON.stringify(x);

export function cashuPrompt(replyTokenLimit: number): PromptRenderer {
  return {
    sha256: sha256([SYSTEM, TURN, `limit: ${replyTokenLimit}`].join("\n---\n")),
    system(observation: Json): string {
      const v = (observation as unknown as Observation).view;
      const p = v.policy;
      return fill(SYSTEM, {
        h0: v.height, horizon: v.horizon_height, float: v.float_sats, fee_ppm: p.desk_fee_ppm, min_conf: p.min_confirmations, tip_lag: p.max_tip_lag,
        margin_ppm: p.token_margin_ppm, keysets: j(v.mint.keysets), refresh: j(p.refresh_fee), exit_vb: p.exit_vbytes, runway: p.exit_runway_blocks,
        mult: p.watcher_fee_multiplier, move: j(p.move_out_fee), limit: replyTokenLimit,
      });
    },
    turn(observation: Json): string {
      const o = observation as unknown as Observation;
      const v = o.view;
      const last = o.last === null ? "Nothing has happened yet."
        : o.last.accepted ? `Last result: ${j(o.last.result)}`
        : `Your last reply was rejected (${o.last.reason}): ${j(o.last.result)}`;
      return fill(TURN, {
        height: v.height, horizon: v.horizon_height, fee: v.fee_rate_sat_vb, online: v.operator_online ? "online" : "offline", float: v.float_sats,
        mint_status: v.mint.status, report: j(v.mint.report), probes: o.budget.probes, attempts: o.budget.attempts, blocks: o.budget.blocks,
        alerts: j(v.alerts), intents: j(v.intents), claimed: j(v.claimed_outpoints), pending: j(v.pending), checks: j(v.checks), vtxos: j(v.vtxos), last,
      });
    },
  };
}
