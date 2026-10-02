// The corner runner: the same demand fed to each settlement object, composed from the pinned
// primitives ArkServer and channelLiquidityDuration, which are imported and not modified. This is
// the non-exported corner() of vendor/spiral/model/server.test.ts made into a function of a demand
// stream and a choice. The project brief names a `runCorner` in model/server.ts; no such export
// exists at the pinned commit (docs/tasks.md §0.1), and this file stands in for it.
//
// What is the pinned model's and what is the bench's:
// - Lock rule, lifetimes, refresh, the channel's peak-balance forecast: the pinned model's.
// - Vol counts receipts and spends for both objects. ArkServer.volumeDelivered counts spends only;
//   ∫ W_S dt is recovered as liquidityDuration() × volumeDelivered and divided by the common volume.
// - Server capital B_S is unbounded, as in the pinned corner test. A refresh the server cannot
//   front is deferred by the pinned model without being reported, so a finite B_S cannot be scored.
// - The server-tier term is the bench's (docs/server_tier_proposal.md, adopted 2026-10-02): the
//   capital on the server's own Lightning channels, the paper's §3.4. The pin does not define one.
//   Locked_V(t) = W_S(t) + C_S. Passing no server tier gives the pinned definition, W_S alone.
//
// The server tier is the channel model one tier up, with the same rule. Every receipt and spend
// of every holder crosses the server's channels, and nothing rebalances them during the horizon.
// P is the server's cumulative net Lightning position: a receipt raises it and needs inbound
// room, a spend lowers it and needs outbound balance. The server pre-funds (1 + margin) × the
// realized peak of P as inbound and (1 + margin) × the realized trough as outbound, holds both for
// the horizon, and a payment that does not fit fails. At a margin of zero or more nothing fails.

import { ArkServer, channelLiquidityDuration } from "../../../vendor/spiral/model/server.ts";
import type { DemandStream, Protocol } from "./generate.ts";

export type Choice =
  | { object: "channel"; margin: number }
  | { object: "vtxo"; refresh_lead_blocks: number; margin: number };

export interface CornerResult {
  /** Liquidity duration 𝒟 = ∫ Locked dt / Vol, in blocks. Infinity when nothing was delivered. */
  duration: number;
  attempts: number;
  failures: number;
  failure_rate: number;
  /** Delivered receipts plus delivered spends, in sats. */
  volume: number;
  /** ∫ Locked dt, in sat·blocks. */
  locked_integral: number;
  /** Largest capital locked at any time: pre-funded stock for the channel; peak W_S plus C_S for the server. */
  peak_locked: number;
  /** C_S, the capital on the server's own Lightning channels. Zero for the channel object and when no server tier is charged. */
  server_tier_locked: number;
  /** Peak W_S: the most the server had fronted and not yet swept. Zero for the channel object. */
  peak_fronted: number;
}

/** As in the pinned corner test: server capital that never binds. */
const UNBOUNDED_CAPITAL = Number.MAX_SAFE_INTEGER / 4;

function attemptsOf(stream: DemandStream): number {
  let n = 0;
  for (const series of stream.values()) for (const s of series) n += (s.in ? 1 : 0) + (s.out ? 1 : 0);
  return n;
}

/** Peak and trough of the server's net Lightning position with every payment delivered, event by event. */
export function serverEnvelope(stream: DemandStream): { peak: number; trough: number } {
  const series = [...stream.values()];
  const steps = series[0]!.length;
  let p = 0, hi = 0, lo = 0;
  for (let t = 0; t < steps; t++) {
    for (const s of series) {
      const step = s[t]!;
      if (step.in) { p += step.in; if (p > hi) hi = p; }
      if (step.out) { p -= step.out; if (p < lo) lo = p; }
    }
  }
  return { peak: hi, trough: 0 - lo };
}

/** Capacities of the server's channel set for a margin: the same forecast rule the channel model uses. */
export function serverTierCapacity(envelope: { peak: number; trough: number }, margin: number): { inbound: number; outbound: number } {
  return { inbound: Math.ceil(envelope.peak * (1 + margin)), outbound: Math.ceil(envelope.trough * (1 + margin)) };
}

export interface VtxoPath {
  /** ∫ W_S dt, in sat·blocks. */
  fronted_integral: number;
  peak_fronted: number;
  volume: number;
  attempts: number;
  failures: number;
}

/**
 * Drive the pinned ArkServer with a demand stream. With `capacity`, each payment must also fit
 * the server's own channels; without it nothing gates a payment and the path is the pinned one.
 */
export function vtxoPath(stream: DemandStream, protocol: Protocol, refreshLead: number, capacity: { inbound: number; outbound: number } | null): VtxoPath {
  const server = new ArkServer(UNBOUNDED_CAPITAL, { lifetimeBlocks: protocol.lifetime_blocks, roundInterval: protocol.round_interval_blocks, refreshLead });
  const names = [...stream.keys()];
  const steps = stream.get(names[0]!)!.length;
  let volumeIn = 0, attempts = 0, failures = 0, peak = 0, position = 0;
  for (let t = 0; t < steps; t++) {
    for (const name of names) {
      const s = stream.get(name)![t]!;
      if (s.in) {
        attempts += 1;
        if (capacity && position + s.in > capacity.inbound) failures += 1;
        else { server.receive(name, s.in); volumeIn += s.in; position += s.in; }
      }
      if (s.out) {
        attempts += 1;
        // A holder whose receipt failed may not hold enough; a server short of outbound cannot pay.
        if ((capacity && s.out - position > capacity.outbound) || !server.spendLightning(name, s.out)) failures += 1;
        else position -= s.out;
      }
    }
    peak = Math.max(peak, server.committed);
    server.advance(protocol.round_interval_blocks);
    peak = Math.max(peak, server.committed);
  }
  if (!server.aggregateBoundHolds()) throw new Error("server committed more than its capital");
  const spent = server.volumeDelivered;
  return { fronted_integral: spent === 0 ? 0 : server.liquidityDuration() * spent, peak_fronted: peak, volume: spent + volumeIn, attempts, failures };
}

/** Score a VTXO path, charging the server tier's capacity for the whole horizon when there is one. */
export function scoreVtxo(path: VtxoPath, horizonBlocks: number, capacity: { inbound: number; outbound: number } | null): CornerResult {
  const tier = capacity ? capacity.inbound + capacity.outbound : 0;
  const lockedIntegral = path.fronted_integral + tier * horizonBlocks;
  return {
    duration: path.volume === 0 ? Infinity : lockedIntegral / path.volume,
    attempts: path.attempts, failures: path.failures, failure_rate: path.attempts === 0 ? 0 : path.failures / path.attempts,
    volume: path.volume, locked_integral: lockedIntegral,
    peak_locked: path.peak_fronted + tier, server_tier_locked: tier, peak_fronted: path.peak_fronted,
  };
}

export const horizonOf = (stream: DemandStream, protocol: Protocol): number => stream.values().next().value!.length * protocol.round_interval_blocks;

/** The VTXO object. `serverMargin` null gives the pinned definition, with no server-tier term. */
export function runVtxo(stream: DemandStream, protocol: Protocol, refreshLead: number, serverMargin: number | null = null): CornerResult {
  if (serverMargin === null) return scoreVtxo(vtxoPath(stream, protocol, refreshLead, null), horizonOf(stream, protocol), null);
  const capacity = serverTierCapacity(serverEnvelope(stream), serverMargin);
  // At a margin of zero or more the capacity covers the whole envelope and gates nothing.
  return scoreVtxo(vtxoPath(stream, protocol, refreshLead, serverMargin < 0 ? capacity : null), horizonOf(stream, protocol), capacity);
}

export function runChannel(stream: DemandStream, protocol: Protocol, margin: number): CornerResult {
  const horizon = horizonOf(stream, protocol);
  const r = channelLiquidityDuration(stream, horizon, margin);
  const attempts = attemptsOf(stream);
  const lockedIntegral = r.locked * horizon;
  return {
    duration: r.duration,
    attempts, failures: r.failures, failure_rate: attempts === 0 ? 0 : r.failures / attempts,
    volume: r.duration === Infinity || r.duration === 0 ? 0 : lockedIntegral / r.duration,
    locked_integral: lockedIntegral, peak_locked: r.locked, server_tier_locked: 0, peak_fronted: 0,
  };
}

export function runCorner(stream: DemandStream, protocol: Protocol, choice: Choice): CornerResult {
  return choice.object === "vtxo" ? runVtxo(stream, protocol, choice.refresh_lead_blocks, choice.margin) : runChannel(stream, protocol, choice.margin);
}
