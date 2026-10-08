// Prompt renderer for bonding episodes: the service, the escrow's costs, the counterparty's
// admission rule, the observed challenger response times, and the grid. It does not estimate the
// response rate or compute a period; that is the decision being scored. The example uses the
// largest bond and the longest period, a valid and expensive offer.

import type { PromptRenderer } from "../../agents/chat.ts";
import { sha256, type Json } from "../../harness/json.ts";
import type { BondingView } from "./env.ts";

interface Observation { view: BondingView; last: { accepted: boolean; reason: string | null; result: { detail?: string } | null } | null }

const SYSTEM = `You operate a connector service and must bond it for one window of {window} blocks with an optimistic escrow (BitVM3 style). You choose the bond in sats and the challenge period Δ in blocks, both from the listed grid, in one offer.

How the escrow works. At the end of the window you post an Assert ({assert_vb} vB at {fee} sat/vB) claiming the service met its threshold. If the claim is true, you withdraw the bond Δ blocks later. If it is false, any challenger who responds within Δ blocks posts a Disprove and you lose the whole bond; if no challenger responds in time, you withdraw it anyway. The service handles {requests} requests, honors each with probability {honored}, and meets its threshold if at least {threshold}% are honored.

Your cost, in sats, lower is better: the Assert fee, plus the bond × the blocks it stays locked × {rate} per block, plus the bond if it is slashed.

The counterparty admits the bond only if it is at least the value at risk, {var} sats, and only if a challenger would respond within Δ with probability at least {catch}. Challengers respond at an unknown, fixed rate per block. Their last {n} response times, in blocks, were: {observed}. A bond the counterparty does not admit costs twice the most expensive admissible offer.

Reply with exactly one JSON object and nothing else. To offer a bond:
{"tool":"bond","args":{"bond_sats":{b_ex},"delta_blocks":{d_ex}}}
The values shown are the format only. Your reply is cut off after {limit} tokens.`;

const TURN = `{last}Bond grid (sats): {bonds}
Challenge period grid (blocks): {deltas}
Attempts left: {attempts}.

Reply with one JSON object.`;

const WHY: { [reason: string]: string } = {
  malformed: "your reply was not one complete JSON object of the required form.",
  unknown_tool: "the tool must be bond.",
  not_integer: "bond_sats and delta_blocks must be whole numbers.",
  below_minimum: "the bond must be positive and Δ at least the minimum.",
  out_of_grid: "bond_sats and delta_blocks must be values from the grids.",
  phase_closed: "the episode has ended.",
};

const fill = (template: string, values: { [key: string]: string | number }): string =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

export function bondingPrompt(replyTokenLimit: number): PromptRenderer {
  const templates = [SYSTEM, TURN, ...Object.keys(WHY).sort().map((k) => `${k}: ${WHY[k]}`), `limit: ${replyTokenLimit}`];
  return {
    sha256: sha256(templates.join("\n---\n")),
    system(observation: Json): string {
      const v = (observation as unknown as Observation).view;
      return fill(SYSTEM, {
        window: v.service.window_blocks, assert_vb: v.bitvm3.assert_vb, fee: v.fee_rate_sat_vb, requests: v.service.requests,
        honored: v.service.p_honored, threshold: 100 * v.service.threshold, rate: v.capital_rate_per_block,
        var: v.service.value_at_risk_sats, catch: v.challenge.catch_probability, n: v.challenge.observed_response_blocks.length,
        observed: v.challenge.observed_response_blocks.join(", "), limit: replyTokenLimit,
        b_ex: Math.max(...v.grid.bonds), d_ex: Math.max(...v.grid.deltas),
      });
    },
    turn(observation: Json): string {
      const o = observation as unknown as Observation & { budget: { attempts: number } };
      const last = o.last && !o.last.accepted ? `Your last offer was rejected: ${WHY[o.last.reason ?? ""] ?? "it broke a rule."}${o.last.result?.detail ? ` (${o.last.result.detail})` : ""}\n\n` : "";
      return fill(TURN, { last, bonds: o.view.grid.bonds.join(", "), deltas: o.view.grid.deltas.join(", "), attempts: o.budget.attempts });
    },
  };
}
