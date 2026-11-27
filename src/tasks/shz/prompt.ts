// Prompt renderer for family 13 (docs/tasks.md §16). It states the venue's mechanics, the client's
// pinned packet policy, and the scoring, then shows each turn's packet, account, and budget as
// compact JSON. It describes what happens, never what to do: whether to trust a packet, how much
// margin to keep, and which tier to pay for are what the family measures, and what the `shz_hedge`
// skill computes.

import type { PromptRenderer } from "../../agents/chat.ts";
import { sha256, type Json } from "../../harness/json.ts";

interface Observation {
  budget: { attempts: number; probes: number; blocks: number };
  tools: string[];
  view: {
    step: number; steps: number; step_hours: number; slot: number; slots_per_step: number; slot_ms: number;
    clock: { now_ms: number };
    packet: Json;
    federation: { members: string[]; quorum: number; max_packet_age_ms: number; max_source_age_ms: number; max_future_ms: number; max_source_skew_ms: number; max_dispersion_bps: number };
    target: Json;
    account: Json;
    this_step: Json;
    venue: { max_lots: number; max_leverage: number; maintenance_bps: number; liquidation_discount_bps: number; ladder: { first_offset_bps: number; step_bps: number; levels: number; lots_per_level: number }; tiers: { standard: { taker_ppm: number; delay_ms: number }; premium: { taker_ppm: number; delay_ms: number } } };
    lightning: { base_fee_msat: number; fee_ppm: number };
    capital_ppm_per_step: number;
    costs_so_far: Json;
  };
  last: { accepted: boolean; reason: string | null; result: Json } | null;
}

const SYSTEM = `You run the client of a Lightning node operator who holds sats and wants their dollar value to stay at a target. You hedge on the SatsHedgeZero venue with a short inverse perpetual: a short of Q dollars gains Q x 1e8 x (1/p_new - 1/p_old) sats as the price falls and loses that much as it rises, so a short equal to the target in dollars holds the balance's dollar value still. The short is traded in lots of {lot} USD. The target is {lots} lots now ({usd} USD); it changes when Lightning income or payments move the balance. The episode runs {steps} steps of {hours} hours, then the short settles at the maturity price at no fee and your margin comes home over Lightning.

The venue:
- Each step it marks your short to the federation's verified mark and settles the gain or loss since the last settlement over Lightning. If the federation holds (no verified mark), nothing settles until it returns, and the move accumulates.
- Your posted margin bounds a settlement's loss. At a settlement where the margin plus the loss falls below {maint} bps of the short's notional in sats, the venue closes the whole short at {disc} bps worse than the mark (a penalty); if the loss reaches the margin, the margin is lost and the short closes. Your account shows liquidation_mark_usd, the mark at which the next settlement closes your short.
- Margin moves in whole multiples of the account's margin_unit_sats, up to {maxunits} units. Adding to the short needs margin of at least a tenth of the short's notional (leverage {lev}x at most), and so does a withdrawal.
- Takes fill against a maker's ladder: {per} lots a level, the first level {off} bps from the reference price and each next one {stepbps} bps further. A sell (adding to the short) hits bids below it, a buy (reducing the short) lifts asks above it. The short stays between 0 and {maxlots} lots.
- Two latency tiers: standard ({std_ppm} ppm taker fee) fills at the mark {std_ms} ms after the packet's boundary; premium ({pre_ppm} ppm taker fee) fills at the boundary's mark.
- A take is bound to the packet your relay shows. On a HOLD or a missing packet the venue refuses it. A packet that fails the policy below may come from a relay that is not the federation's, and whoever served it fills your take only when its price is worse for you than the true mark, at a ladder around its price.
- Every Lightning payment (each margin transfer, each settlement, each take's cost) pays one routing hop {base} msat plus {ppm} ppm. Posted margin costs {cap} ppm a step in capital.

The client's pinned policy for a packet: status VALID with a price; boundary_ms no more than {age} ms before now_ms and not after it; at least {quorum} signatures from distinct members, each signature's key equal to the pinned key of its member index; every source timestamp no more than {srcage} ms before the boundary and no more than {future} ms after it; the sources' timestamps within {skew} ms of each other; their prices within {disp} bps of each other. The pinned member keys are, by index: {members}.

A step has {slots} packet slots {slotms} ms apart; refresh reads the next one. A federation HOLD lasts the whole step.

Scoring, in sats, higher is better: minus the tracking error (at each settlement, the absolute difference between your short's sats change and the change in the sats your target dollar value needs, summed without netting), minus execution against the mark, taker fees, Lightning fees, capital, and penalties. Holding no short scores minus its tracking error.

Tools: refresh {} (next slot's packet), deposit {"sats": n}, withdraw {"sats": n}, take {"side": "sell" | "buy", "lots": n, "tier": "standard" | "premium"}, wait {} (ends the step), commit {} (holds everything as it is to maturity). At most one margin transfer and one take per step. A rejected reply costs an attempt.

Reply with exactly one JSON object and nothing else, for example {"tool":"deposit","args":{"sats":{unit}}} or {"tool":"wait","args":{}}. Your reply is cut off after {limit} tokens.`;

const TURN = `Step {step} of {steps}, slot {slot}. Budget: {blocks} steps, {probes} moves, {attempts} attempts left.
Packet: {packet}
Now: {now}. Target: {target}. Account: {account}. This step: {thisstep}. Costs so far: {costs}.
{last}
Reply with one JSON object.`;

const fill = (template: string, values: { [key: string]: string | number }): string =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

export function shzPrompt(replyTokenLimit: number): PromptRenderer {
  return {
    sha256: sha256([SYSTEM, TURN, `limit: ${replyTokenLimit}`].join("\n---\n")),
    system(observation: Json): string {
      const v = (observation as unknown as Observation).view;
      const t = v.target as { lots: number; usd: number; lot_usd: number };
      const a = v.account as { margin_unit_sats: number; max_margin_units: number };
      const fed = v.federation;
      return fill(SYSTEM, {
        lot: t.lot_usd, lots: t.lots, usd: t.usd, steps: v.steps, hours: v.step_hours,
        maint: v.venue.maintenance_bps, disc: v.venue.liquidation_discount_bps, maxunits: a.max_margin_units, lev: v.venue.max_leverage,
        per: v.venue.ladder.lots_per_level, off: v.venue.ladder.first_offset_bps, stepbps: v.venue.ladder.step_bps, maxlots: v.venue.max_lots,
        std_ppm: v.venue.tiers.standard.taker_ppm, std_ms: v.venue.tiers.standard.delay_ms, pre_ppm: v.venue.tiers.premium.taker_ppm,
        base: v.lightning.base_fee_msat, ppm: v.lightning.fee_ppm, cap: v.capital_ppm_per_step,
        age: fed.max_packet_age_ms, quorum: fed.quorum, srcage: fed.max_source_age_ms, future: fed.max_future_ms, skew: fed.max_source_skew_ms, disp: fed.max_dispersion_bps,
        members: fed.members.map((k, i) => `${i}: ${k}`).join(", "), slots: v.slots_per_step, slotms: v.slot_ms,
        unit: a.margin_unit_sats, limit: replyTokenLimit,
      });
    },
    turn(observation: Json): string {
      const o = observation as unknown as Observation;
      const v = o.view;
      const last = o.last === null ? "Nothing has happened yet."
        : o.last.accepted ? `Last result: ${JSON.stringify(o.last.result)}`
        : `Your last reply was rejected (${o.last.reason}): ${JSON.stringify(o.last.result)}`;
      return fill(TURN, {
        step: v.step, steps: v.steps, slot: v.slot, blocks: o.budget.blocks, probes: o.budget.probes, attempts: o.budget.attempts,
        packet: JSON.stringify(v.packet), now: v.clock.now_ms, target: JSON.stringify(v.target), account: JSON.stringify(v.account),
        thisstep: JSON.stringify(v.this_step), costs: JSON.stringify(v.costs_so_far), last,
      });
    },
  };
}
