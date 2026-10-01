// The corner runner: the same demand fed to each settlement object, composed from the pinned
// primitives ArkServer and channelLiquidityDuration, which are imported and not modified. This is
// the non-exported corner() of vendor/spiral/model/server.test.ts made into a function of a demand
// stream and a choice. The project brief names a `runCorner` in model/server.ts; no such export
// exists at the pinned commit (docs/tasks.md §0.1), and this file stands in for it.
//
// What is the pinned model's and what is the bench's:
// - Lock rule, lifetimes, refresh, the channel's peak-balance forecast: the pinned model's.
// - Server capital is unbounded, as in the pinned corner test. The pinned liquidity duration
//   charges W_S and not B_S, and a refresh the server cannot front is deferred without being
//   reported, so a finite B_S would be both free and unobservable. Peak W_S is reported instead:
//   it is the capital a server would have needed.
// - Vol counts receipts and spends for both objects. ArkServer.volumeDelivered counts spends only;
//   ∫ W_S dt is recovered as liquidityDuration() × volumeDelivered and divided by the common volume.
// - No server-tier term is charged. The brief requires one; the pin does not define it.

import { ArkServer, channelLiquidityDuration } from "../../../vendor/spiral/model/server.ts";
import type { DemandStream, Protocol } from "./generate.ts";

export type Choice =
  | { object: "channel"; margin: number }
  | { object: "vtxo"; refresh_lead_blocks: number };

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
  /** Largest capital locked at any time: pre-funded stock for the channel, peak W_S for the server. */
  peak_locked: number;
}

/** As in the pinned corner test: capital that never binds. */
const UNBOUNDED_CAPITAL = Number.MAX_SAFE_INTEGER / 4;

function attemptsOf(stream: DemandStream): number {
  let n = 0;
  for (const series of stream.values()) for (const s of series) n += (s.in ? 1 : 0) + (s.out ? 1 : 0);
  return n;
}

export function runVtxo(stream: DemandStream, protocol: Protocol, refreshLead: number): CornerResult {
  const server = new ArkServer(UNBOUNDED_CAPITAL, { lifetimeBlocks: protocol.lifetime_blocks, roundInterval: protocol.round_interval_blocks, refreshLead });
  const names = [...stream.keys()];
  const steps = stream.get(names[0]!)!.length;
  let volumeIn = 0, attempts = 0, failures = 0, peak = 0;
  for (let t = 0; t < steps; t++) {
    for (const name of names) {
      const s = stream.get(name)![t]!;
      if (s.in) { attempts += 1; server.receive(name, s.in); volumeIn += s.in; }
      if (s.out) { attempts += 1; if (!server.spendLightning(name, s.out)) failures += 1; }
    }
    peak = Math.max(peak, server.committed);
    server.advance(protocol.round_interval_blocks);
    peak = Math.max(peak, server.committed);
  }
  if (!server.aggregateBoundHolds()) throw new Error("server committed more than its capital");
  const spent = server.volumeDelivered;
  const lockedIntegral = spent === 0 ? 0 : server.liquidityDuration() * spent;
  const volume = spent + volumeIn;
  return {
    duration: volume === 0 ? Infinity : lockedIntegral / volume,
    attempts, failures, failure_rate: attempts === 0 ? 0 : failures / attempts,
    volume, locked_integral: lockedIntegral, peak_locked: peak,
  };
}

export function runChannel(stream: DemandStream, protocol: Protocol, margin: number): CornerResult {
  const steps = stream.values().next().value!.length;
  const horizon = steps * protocol.round_interval_blocks;
  const r = channelLiquidityDuration(stream, horizon, margin);
  const attempts = attemptsOf(stream);
  const lockedIntegral = r.locked * horizon;
  return {
    duration: r.duration,
    attempts, failures: r.failures, failure_rate: attempts === 0 ? 0 : r.failures / attempts,
    volume: r.duration === Infinity || r.duration === 0 ? 0 : lockedIntegral / r.duration,
    locked_integral: lockedIntegral, peak_locked: r.locked,
  };
}

export function runCorner(stream: DemandStream, protocol: Protocol, choice: Choice): CornerResult {
  return choice.object === "vtxo" ? runVtxo(stream, protocol, choice.refresh_lead_blocks) : runChannel(stream, protocol, choice.margin);
}
