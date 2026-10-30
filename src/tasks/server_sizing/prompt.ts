// Prompt renderer for server-sizing episodes. It states the rules and costs and shows the
// observation as JSON; it computes no margin, buffer, or schedule. The examples use round numbers
// that are not a sound plan, so a copied example is a bad sizing.

import type { PromptRenderer } from "../../agents/chat.ts";
import { sha256, type Json } from "../../harness/json.ts";
import type { SizingView } from "./env.ts";

interface Observation {
  budget: { attempts: number };
  view: SizingView;
  last: { accepted: boolean; reason: string | null; result: { decision_index?: number; step?: number } | null } | null;
}

const SYSTEM = `You are an Ark server sizing the INBOUND capacity of your own Lightning channels. Outbound is not modelled. Time runs in steps of one protocol round, {round} blocks, for {steps} steps ({horizon} blocks).

Payments. In each step, holder by holder in a fixed order, a holder's receipt comes first and then its spend. Your position starts at 0. A receipt of v sats succeeds only if position + v is at most the capacity in force at that step: then the position and that holder's delivered balance both rise by v. Otherwise it fails and changes nothing. A spend of v sats executes only if that holder's delivered balance covers it, and then the position and the balance fall by v; otherwise it is dropped, and a dropped spend is not a failure.

Costs, all in sats, and lower total is better. Your score is minus the natural log of the total, with the total at least 1.
- Capital: each step costs capacity_in_force x capital_rate_per_block x round_interval_blocks.
- Resizing: a target different from the capacity in force costs resize_fee_sats when you order it, and lease_rate_ppm / 1,000,000 x the increase actually put in force when it takes effect (a decrease adds nothing). The capacity starts at 0, so the first sizing pays the fee and the lease on its whole amount. A target equal to the capacity in force costs nothing.
- Failures: each failed receipt costs failure_fixed_sats plus failure_value_share x its value.

Decisions. You decide {count} times, every {interval} blocks, at steps 0, {stride}, and so on. The capacity you choose at decision 0 is in force from step 0. A resize at a later decision takes effect {delay} blocks after the decision, and until then the old capacity is in force. The capacity can never be below the position you hold: a target below your current position is rejected, and when a resize takes effect the capacity in force becomes the larger of the target and your position at that step. After each accepted action time moves on to the next decision, and the last one runs to the horizon.

What you see each turn is a JSON object. position is your position now. capacity_in_force is the capacity. failures and failed_sats are the receipts that have failed so far. max_inbound_sats ({max}) is the largest target allowed. pilot is a separate sample of the same demand with every payment delivered: per decision interval, the position at its start, its maximum, and its end, with max_with_delay the maximum through the interval and the resize delay, and peak over all of it. evaluation_completed is the same summary for the intervals of this episode that are over, on the path with every payment delivered, and nothing about the intervals to come.

Reply with exactly one JSON object and nothing else, in one of three forms. To set the target, here to a round number:
{"tool":"resize","args":{"inbound_sats":100000}}
To keep the target and move on:
{"tool":"hold"}
To keep the target to the horizon:
{"tool":"commit"}
The numbers shown are the format only. The target is a whole number of sats from your current position to max_inbound_sats. An action that is rejected changes nothing and uses one of your {attempts} attempts; accepted actions use none, and with no attempts left the capacity in force holds to the horizon. Your reply is cut off after {limit} tokens.`;

const TURN = `{last}Decision {decision} of {count}, step {step} (block {block}). Attempts left: {attempts}.
{view}

Reply with one JSON object.`;

const WHY: { [reason: string]: string } = {
  malformed: "your reply was not one complete JSON object of the required form.",
  unknown_tool: "the tool must be resize, hold, or commit.",
  not_integer: "inbound_sats must be a whole number.",
  below_minimum: "inbound_sats cannot be negative.",
  over_budget: "inbound_sats is above max_inbound_sats.",
  below_position: "inbound_sats is below your current position, and the capacity can never be below the position you hold.",
  phase_closed: "the episode has ended.",
};

const fill = (template: string, values: { [key: string]: string | number }): string =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

export function serverSizingPrompt(replyTokenLimit: number): PromptRenderer {
  const templates = [SYSTEM, TURN, ...Object.keys(WHY).sort().map((k) => `${k}: ${WHY[k]}`), `limit: ${replyTokenLimit}`];
  return {
    sha256: sha256(templates.join("\n---\n")),
    system(observation: Json): string {
      const o = observation as unknown as Observation;
      const v = o.view;
      return fill(SYSTEM, {
        round: v.round_interval_blocks, steps: v.horizon_steps, horizon: v.horizon_blocks, count: v.decision_count,
        interval: v.decision_interval_blocks, stride: v.decision_interval_blocks / v.round_interval_blocks,
        delay: v.resize_delay_blocks, max: v.max_inbound_sats, attempts: o.budget.attempts, limit: replyTokenLimit,
      });
    },
    turn(observation: Json): string {
      const o = observation as unknown as Observation;
      const v = o.view;
      let last = "";
      if (o.last !== null && !o.last.accepted) last = `Your last action was rejected: ${WHY[o.last.reason ?? ""] ?? "it broke a rule."}\n\n`;
      return fill(TURN, {
        last, decision: v.decision_index + 1, count: v.decision_count, step: v.step, block: v.block,
        attempts: o.budget.attempts, view: JSON.stringify(v),
      });
    },
  };
}
