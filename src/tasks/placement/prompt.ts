// Prompt renderer for placement episodes. It states the task, the rules, and the facts of the
// interface (the reply length limit, what each rejection means), and lists what the observation
// contains in a compact text form. It does not aggregate, rank, or summarize the history: counting
// failures per pair is the failure-aware heuristic, and doing it in the prompt would make the
// adapter the agent.

import type { PromptRenderer } from "../../agents/chat.ts";
import { sha256, type Json } from "../../harness/json.ts";

interface Observation {
  budget: { attempts: number; sats: number };
  view: {
    nodes: string[];
    edges: Array<{ u: string; v: string }>;
    history: Array<{ i: number; source: string; target: string; sats: number; delivered: boolean }>;
    horizon: { warmup: number; evaluation: number };
    rules: { min_pair_sats: number };
  };
  last: { accepted: boolean; reason: string | null } | null;
}

const SYSTEM = `You operate a routing business on a payment-channel network of {nodes} nodes. You have a fixed budget of satoshis (sats) to add channel capacity, and you want as many future payments as possible to be delivered.

What you can see: which pairs of nodes already have a channel (not the channels' capacities or balances), and the {warmup} most recent payments, each marked delivered or failed.

How payments are routed: a payment tries up to 3 of the cheapest paths from its source to its target. It is delivered if, on one of those paths, every hop has enough balance in the direction of the payment.

What you can do: fund capacity on directed pairs. A placement {"from": A, "to": B, "sats": n} adds n sats of capacity between A and B, all of it spendable from A toward B. To make a pair usable in both directions, place on A to B and also on B to A. You may place on a pair that already has a channel or on one that has none.

Rules: node names must exist. sats must be a positive whole number. The total must not exceed your remaining budget. A pair with no existing channel must receive at least {min} sats in total. An action that breaks a rule is rejected whole, places nothing, and still uses up one attempt.

Score: the share of the next {evaluation} payments that are delivered once your capacity is added.

Reply with exactly one JSON object and nothing else. Either
{"tool":"place","args":{"placements":[{"from":"<node>","to":"<node>","sats":<whole number>}]}}
with one or more placements in the list, or
{"tool":"commit"}
when you are finished. Unspent budget has no value. Your reply is cut off after {limit} tokens, and a reply that is cut off is rejected.`;

const FIRST = `Budget: {sats} sats. Attempts left: {attempts}.

Nodes: {first} to {last}.

Pairs that already have a channel:
{edges}

Recent payments, oldest first (number source>target sats result):
{history}

Reply with one JSON object.`;

const ACCEPTED = `Your last action was accepted. Remaining budget: {sats} sats. Attempts left: {attempts}.

Reply with one JSON object.`;

const REJECTED = `Your last action was rejected and placed nothing: {why} Remaining budget: {sats} sats. Attempts left: {attempts}.

Reply with one JSON object.`;

/** What each rejection reason of the placement environment means, in the words of the rules above. */
const WHY: { [reason: string]: string } = {
  malformed: "your reply was not one complete JSON object of the required form. It may have been cut off.",
  unknown_tool: "the tool must be place or commit.",
  unknown_node: "a node name in your placements does not exist.",
  self_pair: "a placement had the same node as from and to.",
  not_integer: "sats must be a positive whole number.",
  over_budget: "your placements added up to more than your remaining budget.",
  below_minimum: "a pair with no existing channel would have received less than {min} sats in total.",
  phase_closed: "the decision phase has ended.",
};

const fill = (template: string, values: { [key: string]: string | number }): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));

/** The renderer for a given reply limit. The limit is part of the prompt text and so of its hash. */
export function placementPrompt(replyTokenLimit: number): PromptRenderer {
  const templates = [SYSTEM, FIRST, ACCEPTED, REJECTED, ...Object.keys(WHY).sort().map((k) => `${k}: ${WHY[k]}`), `limit: ${replyTokenLimit}`];
  return {
    sha256: sha256(templates.join("\n---\n")),
    system(observation: Json): string {
      const o = observation as unknown as Observation;
      return fill(SYSTEM, { nodes: o.view.nodes.length, warmup: o.view.horizon.warmup, evaluation: o.view.horizon.evaluation, min: o.view.rules.min_pair_sats, limit: replyTokenLimit });
    },
    turn(observation: Json): string {
      const o = observation as unknown as Observation;
      const common = { sats: o.budget.sats, attempts: o.budget.attempts };
      if (o.last === null) {
        return fill(FIRST, {
          ...common,
          first: o.view.nodes[0]!, last: o.view.nodes[o.view.nodes.length - 1]!,
          edges: o.view.edges.map((e) => `${e.u}-${e.v}`).join(" "),
          history: o.view.history.map((h) => `${h.i} ${h.source}>${h.target} ${h.sats} ${h.delivered ? "delivered" : "failed"}`).join("\n"),
        });
      }
      if (o.last.accepted) return fill(ACCEPTED, common);
      const why = fill(WHY[o.last.reason ?? ""] ?? "it broke a rule.", { min: o.view.rules.min_pair_sats });
      return fill(REJECTED, { ...common, why });
    },
  };
}
