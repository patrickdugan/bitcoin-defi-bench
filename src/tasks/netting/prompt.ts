// Prompt renderer for netting episodes. It states the task, the rules, and the instance in a
// compact text form. It does not net, rank, or suggest; that is what a skill is for. The action
// examples use the instance's own first trader ids with an amount of 1, because a small model
// copies a placeholder such as [...] literally (seen with Bonsai 8B on 2026-10-07).

import type { PromptRenderer } from "../../agents/chat.ts";
import { sha256, type Json } from "../../harness/json.ts";
import type { Instance } from "./plans.ts";

interface Observation {
  budget: { attempts: number; probes: number };
  view: Instance;
  last: { accepted: boolean; reason: string | null; result: { violations?: Array<{ reason: string; detail: string }>; cost_sats?: number } | null } | null;
}

const SYSTEM = `You are settling open derivative positions between traders at a settlement value. Every trade is a bilateral contract; at settlement one party owes the other quantity × (settlement value − entry price): if that is positive the short pays the long, if negative the long pays the short. Each trader must end up paying exactly its net obligation (what it owes minus what it is owed), and no more than its collateral.

You pay by transfers. A transfer {"from": A, "to": B, "sats": n, "via": "link"} uses the link between A and B, which exists only if they have traded, costs {link_rate} parts per million of the amount, and shares one capacity in both directions. A transfer with "via": "ghost" works between any two traders, has no capacity, and costs {ghost_rate} parts per million. Each transfer also costs a base fee of {base_fee} sats. Lower total cost is better. Transfers may route through intermediaries: a trader may pay out what it receives, within its collateral.

A plan is valid only if every transfer names two different existing traders, every amount is a positive whole number, every link transfer stays within its link's capacity, every trader's net paid equals its net obligation exactly, and no trader pays more than its collateral. An invalid plan is rejected whole and still uses one attempt.

Reply with exactly one JSON object and nothing else, in one of three forms. To check a plan and see its violations and cost without committing it:
{"tool":"probe","args":{"plan":{"transfers":[{"from":"{t0}","to":"{t1}","sats":1,"via":"link"},{"from":"{t1}","to":"{t2}","sats":1,"via":"ghost"}]}}}
To commit a plan:
{"tool":"settle","args":{"plan":{"transfers":[{"from":"{t0}","to":"{t1}","sats":1,"via":"link"}]}}}
To stop without a plan, which scores at twice the cost of the worst plan:
{"tool":"commit"}
The transfers shown are the format only; which pairs, which amounts, and how many transfers are yours to choose. Your reply is cut off after {limit} tokens, and a reply that is cut off is rejected.`;

const FIRST = `Attempts left: {attempts}. Probes left: {probes}.

Settlement value: {settlement}.

Traders (id collateral_sats):
{traders}

Trades (id long short quantity entry_price):
{trades}

Links (a b capacity_sats rate_ppm):
{links}

Reply with one JSON object.`;

const ACCEPTED_PROBE = `Probe result: {result} Attempts left: {attempts}. Probes left: {probes}.

Reply with one JSON object.`;

const REJECTED = `Your last action was rejected and settled nothing: {why} Attempts left: {attempts}. Probes left: {probes}.

Reply with one JSON object.`;

const WHY: { [reason: string]: string } = {
  malformed: "your reply was not one complete JSON object of the required form. It may have been cut off.",
  unknown_tool: "the tool must be probe, settle, or commit.",
  unknown_node: "a transfer named a trader that does not exist.",
  self_pair: "a transfer had the same trader as from and to.",
  not_integer: "sats must be a positive whole number.",
  no_link: "a link transfer named two traders that have no link.",
  over_budget: "a link was over its capacity, a trader paid more than its collateral, or you had no probes left.",
  unbalanced: "some trader's net paid did not equal its net obligation.",
  phase_closed: "the decision phase has ended.",
};

const fill = (template: string, values: { [key: string]: string | number }): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));

export function nettingPrompt(replyTokenLimit: number): PromptRenderer {
  const templates = [SYSTEM, FIRST, ACCEPTED_PROBE, REJECTED, ...Object.keys(WHY).sort().map((k) => `${k}: ${WHY[k]}`), `limit: ${replyTokenLimit}`];
  return {
    sha256: sha256(templates.join("\n---\n")),
    system(observation: Json): string {
      const o = observation as unknown as Observation;
      const linkRate = o.view.links[0]?.rate_ppm ?? 0;
      const ids = o.view.traders.map((t) => t.id);
      return fill(SYSTEM, { link_rate: linkRate, ghost_rate: o.view.ghost.rate_ppm, base_fee: o.view.base_fee_sats, limit: replyTokenLimit, t0: ids[0] ?? "A", t1: ids[1] ?? "B", t2: ids[2] ?? "C" });
    },
    turn(observation: Json): string {
      const o = observation as unknown as Observation;
      const common = { attempts: o.budget.attempts, probes: o.budget.probes };
      if (o.last === null) {
        return fill(FIRST, {
          ...common,
          settlement: o.view.settlement_value,
          traders: o.view.traders.map((t) => `${t.id} ${t.collateral_sats}`).join("\n"),
          trades: o.view.trades.map((t) => `${t.id} ${t.long} ${t.short} ${t.quantity} ${t.entry_price}`).join("\n"),
          links: o.view.links.map((l) => `${l.a} ${l.b} ${l.capacity_sats} ${l.rate_ppm}`).join("\n"),
        });
      }
      if (o.last.accepted) {
        const r = o.last.result ?? {};
        const violations = (r.violations ?? []).map((v) => v.detail).join("; ");
        return fill(ACCEPTED_PROBE, { ...common, result: violations ? `invalid: ${violations}.` : `valid, cost ${r.cost_sats} sats.` });
      }
      const detail = (o.last.result?.violations ?? []).map((v) => v.detail).slice(0, 5).join("; ");
      const why = `${WHY[o.last.reason ?? ""] ?? "it broke a rule."}${detail ? ` Details: ${detail}.` : ""}`;
      return fill(REJECTED, { ...common, why });
    },
  };
}
