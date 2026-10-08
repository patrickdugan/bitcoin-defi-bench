// Prompt renderer for DLC design episodes. It states the contract, the costs, and the menus with
// the forecast's probability at each point. It does not rank options or suggest a design; that is
// what a skill is for. The action examples use the instance's own menu values, chosen to be valid
// and expensive (the largest collateral, small moduli), because a small model copies examples
// (family 6, 2026-10-07) and a copied example should score as what it is.

import type { PromptRenderer } from "../../agents/chat.ts";
import { sha256, type Json } from "../../harness/json.ts";
import type { Costs } from "./contract.ts";
import type { DlcView } from "./designs.ts";

interface Observation {
  budget: { attempts: number; probes: number };
  view: DlcView;
  last: { accepted: boolean; reason: string | null; result: (Partial<Costs> & { detail?: string }) | null } | null;
}

const SYSTEM = `You are designing a discreet log contract (DLC) on the bitcoin price, as the DLC specification defines one. On day {days} an oracle attests the BTC/USD price as a whole number of dollars in {digits} binary digits; a price above {max} is attested as {max}. The offerer holds {notional} US dollars: at price x it is paid {notional} × 100,000,000 / x sats, rounded and capped as described below, and the counterparty is paid the rest of the total collateral.

You choose two things.
1. The total collateral, from the listed options. The offerer funds {offerer} sats of it whatever you choose; the counterparty funds the rest, and that costs {rate}% a year for {days} days. Each option has a floor price: below it the offerer is owed more than the collateral holds, and the expected amount it is short is a cost.
2. Rounding intervals. From each interval's begin_interval (a price, from the listed breakpoints) up to the next interval, payouts are rounded to the nearest multiple of its rounding_mod (from the listed moduli); before the first interval the modulus is 1. The contract needs one contract execution transaction (CET) for each stretch of prices with the same payout, so larger moduli need fewer CETs; each CET costs {cpc} to sign and verify. The expected rounding error, weighted by how likely each price is, is a cost.

Your cost is counterparty capital + expected shortfall + expected rounding error + CETs × {cpc}. Lower is better. The forecast for the price on day {days}: spot {spot} dollars, lognormal with {vol}% annual volatility and no drift; the menus below give the probability that the price ends below each point.

Reply with exactly one JSON object and nothing else, in one of three forms. To see a design's CET count and costs without committing it:
{"tool":"probe","args":{"collateral_sats":{c0},"rounding_intervals":[{"begin_interval":0,"rounding_mod":{m0}},{"begin_interval":{b1},"rounding_mod":{m1}}]}}
To offer a design, which ends the episode:
{"tool":"offer","args":{"collateral_sats":{c0},"rounding_intervals":[{"begin_interval":0,"rounding_mod":{m0}}]}}
To stop without offering, which scores at twice the cost of the specification's default design:
{"tool":"commit"}
The values shown are the format only; the collateral, the breakpoints, the moduli, and how many intervals are yours to choose. Every collateral_sats, begin_interval, and rounding_mod must be one of the listed values, and begin_interval values must increase. An invalid design is rejected whole and still uses its attempt or probe. Your reply is cut off after {limit} tokens, and a reply that is cut off is rejected.`;

const FIRST = `Attempts left: {attempts}. Probes left: {probes}.

Collateral options (collateral_sats floor_price_usd probability_price_ends_below):
{collateral}

Breakpoints (begin_interval probability_price_ends_below):
{breakpoints}

Rounding moduli (sats): {mods}

Reply with one JSON object.`;

const ACCEPTED_PROBE = `Probe result: {result} Attempts left: {attempts}. Probes left: {probes}.

Reply with one JSON object.`;

const REJECTED = `Your last action was rejected and offered nothing: {why} Attempts left: {attempts}. Probes left: {probes}.

Reply with one JSON object.`;

const WHY: { [reason: string]: string } = {
  malformed: "your reply was not one complete JSON object of the required form. It may have been cut off.",
  unknown_tool: "the tool must be probe, offer, or commit.",
  not_integer: "collateral_sats, begin_interval, and rounding_mod must be whole numbers.",
  out_of_grid: "a value was not one of the listed options.",
  over_budget: "you had no probes left.",
  phase_closed: "the decision phase has ended.",
};

/** Three significant digits of the probability, or of its complement near 100%, so that a tail never reads as 0% or 100% unless it is. */
const percent = (p: number): string => {
  if (p < 0.5) return `${(100 * p).toPrecision(3)}%`;
  const q = 100 * (1 - p);
  if (q === 0) return "100%";
  const decimals = Math.min(12, Math.max(1, 2 - Math.floor(Math.log10(q))));
  return `${(100 - q).toFixed(decimals)}%`;
};
const whole = (n: number): string => String(Math.round(n));

const fill = (template: string, values: { [key: string]: string | number }): string =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

export function dlcPrompt(replyTokenLimit: number): PromptRenderer {
  const templates = [SYSTEM, FIRST, ACCEPTED_PROBE, REJECTED, ...Object.keys(WHY).sort().map((k) => `${k}: ${WHY[k]}`), `limit: ${replyTokenLimit}`];
  return {
    sha256: sha256(templates.join("\n---\n")),
    system(observation: Json): string {
      const v = (observation as unknown as Observation).view;
      const c = v.contract;
      return fill(SYSTEM, {
        days: c.forecast.days, digits: c.num_digits, max: v.oracle.max_outcome, notional: c.notional_usd,
        offerer: v.offerer_collateral_sats, rate: 100 * c.capital_rate_annual, cpc: `${c.sats_per_cet} ${c.sats_per_cet === 1 ? "sat" : "sats"}`,
        spot: c.forecast.spot_usd, vol: 100 * c.forecast.annual_volatility, limit: replyTokenLimit,
        c0: v.collateral_options[v.collateral_options.length - 1]!.collateral_sats,
        m0: v.rounding_mods[Math.min(1, v.rounding_mods.length - 1)]!, m1: v.rounding_mods[Math.min(2, v.rounding_mods.length - 1)]!,
        b1: v.breakpoints[v.breakpoints.length - 1]!.begin_interval,
      });
    },
    turn(observation: Json): string {
      const o = observation as unknown as Observation;
      const common = { attempts: o.budget.attempts, probes: o.budget.probes };
      if (o.last === null) {
        return fill(FIRST, {
          ...common,
          collateral: o.view.collateral_options.map((c) => `${c.collateral_sats} ${c.floor_price_usd} ${percent(c.below_probability)}`).join("\n"),
          breakpoints: o.view.breakpoints.map((b) => `${b.begin_interval} ${percent(b.below_probability)}`).join("\n"),
          mods: o.view.rounding_mods.join(", "),
        });
      }
      if (o.last.accepted) {
        const r = o.last.result ?? {};
        const result = `${r.cets} CETs; counterparty capital ${whole(r.capital_sats ?? 0)} sats, expected shortfall ${whole(r.shortfall_sats ?? 0)} sats, expected rounding error ${whole(r.tracking_sats ?? 0)} sats, signing ${whole(r.signing_sats ?? 0)} sats; total ${whole(r.total_sats ?? 0)} sats.`;
        return fill(ACCEPTED_PROBE, { ...common, result });
      }
      const detail = o.last.result?.detail;
      const why = `${WHY[o.last.reason ?? ""] ?? "it broke a rule."}${detail ? ` Details: ${detail}.` : ""}`;
      return fill(REJECTED, { ...common, why });
    },
  };
}
