// Prompt renderer for routing episodes. Every turn states the current payment, its candidates with
// hop counts and public fees, what was already tried for it, and the whole history of earlier
// payments with each attempt's terminal outcome, raw, as prereg/v0.md §9.1 requires. It is built
// for a context window of the current turn alone (ChatOptions.contextTurns = 0): a turn carries the
// whole state, and an episode is several hundred turns.

import type { PromptRenderer } from "../../agents/chat.ts";
import { sha256, type Json } from "../../harness/json.ts";
import type { RoutingView } from "./env.ts";

interface Observation { view: RoutingView; last: { accepted: boolean; reason: string | null; result: { delivered?: boolean; skipped?: boolean } | null } | null }

const SYSTEM = `You are a Lightning wallet routing a stream of payments over a network whose channel balances you cannot see. For each payment you are shown up to {paths} candidate paths, each with its number of hops and its public fee. You may attempt a candidate; you learn only whether the whole payment was delivered, never which channel failed. You have {attempts} attempts per payment, and after that many failures the payment fails. A delivered payment moves balance along its path, so what you route now changes what can be routed later. There are {demands} payments; the last {scored} are scored by the share delivered, and the first {warmup} are not scored.

Reply with exactly one JSON object and nothing else. To attempt the candidate with index 0:
{"tool":"attempt","args":{"candidate":0}}
To give up on the payment:
{"tool":"skip"}
The index shown is the format only; which candidate is yours to choose. Your reply is cut off after {limit} tokens.`;

// The history comes first and only grows, so consecutive requests share almost their whole prefix and
// a server with prompt caching reprocesses only the end; the current payment comes last.
const TURN = `Earlier payments (i source>target sats: candidate and outcome of each attempt):
{history}

{last}Payment {i} of {demands} ({phase}): {sats} sats from {source} to {target}. Attempts left for this payment: {left}.
Candidates (index hops fee_msat path):
{candidates}
Already tried for this payment: {tried}

Reply with one JSON object.`;

const WHY: { [reason: string]: string } = {
  malformed: "your reply was not one complete JSON object of the required form.",
  unknown_tool: "the tool must be attempt or skip.",
  not_integer: "candidate must be a whole number.",
  out_of_grid: "there is no candidate with that index.",
  phase_closed: "the episode has ended.",
};

const fill = (template: string, values: { [key: string]: string | number }): string =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

const outcome = (a: { candidate: number; delivered: boolean }): string => (a.candidate < 0 ? "rejected" : `${a.candidate} ${a.delivered ? "delivered" : "failed"}`);

export function routingPrompt(replyTokenLimit: number): PromptRenderer {
  const templates = [SYSTEM, TURN, ...Object.keys(WHY).sort().map((k) => `${k}: ${WHY[k]}`), `limit: ${replyTokenLimit}`];
  return {
    sha256: sha256(templates.join("\n---\n")),
    system(observation: Json): string {
      const v = (observation as unknown as Observation).view;
      return fill(SYSTEM, { paths: 8, attempts: v.attempts_left, demands: v.horizon.demands, scored: v.horizon.demands - v.horizon.evaluation_start, warmup: v.horizon.evaluation_start, limit: replyTokenLimit });
    },
    turn(observation: Json): string {
      const o = observation as unknown as Observation;
      const v = o.view;
      let last = "";
      if (o.last && !o.last.accepted) last = `Your last action was rejected: ${WHY[o.last.reason ?? ""] ?? "it broke a rule."}\n\n`;
      return fill(TURN, {
        last, i: v.demand.i, demands: v.horizon.demands, phase: v.demand.scored ? "scored" : "not scored",
        sats: v.demand.sats, source: v.demand.source, target: v.demand.target, left: v.attempts_left,
        candidates: v.candidates.map((c) => `${c.index} ${c.hops} ${c.fee_msat} ${c.path.join(">")}`).join("\n"),
        tried: v.tried.length ? v.tried.map(outcome).join(", ") : "nothing",
        history: v.history.length ? v.history.map((h) => `${h.i} ${h.source}>${h.target} ${h.sats}: ${h.attempts.length ? h.attempts.map(outcome).join(", ") : "skipped"}`).join("\n") : "(none yet)",
      });
    },
  };
}
