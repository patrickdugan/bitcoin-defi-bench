// Named random streams. Each purpose (capacities, balances, demand, a baseline's own choices) has
// its own stream, seeded from SHA-256 of its labels, so adding or removing a draw in one stream
// cannot shift another. The generator is xoshiro128**; the pinned model's 32-bit LCG is not used
// for fixtures.

import { createHash } from "node:crypto";

export interface Stream {
  /** Uniform on [0, 1) with 32 bits of resolution. */
  next(): number;
  /** Uniform integer on [0, n). */
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(items: T[]): void;
  /** Standard normal by Box–Muller (one variate per call). */
  normal(): number;
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

export function stream(...labels: Array<string | number>): Stream {
  const digest = createHash("sha256").update(labels.join("|")).digest();
  const s = [digest.readUInt32LE(0), digest.readUInt32LE(4), digest.readUInt32LE(8), digest.readUInt32LE(12)];
  if ((s[0]! | s[1]! | s[2]! | s[3]!) === 0) s[0] = 1;
  const next32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s[1]!, 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1]! << 9) >>> 0;
    s[2] = (s[2]! ^ s[0]!) >>> 0;
    s[3] = (s[3]! ^ s[1]!) >>> 0;
    s[1] = (s[1]! ^ s[2]!) >>> 0;
    s[0] = (s[0]! ^ s[3]!) >>> 0;
    s[2] = (s[2]! ^ t) >>> 0;
    s[3] = rotl(s[3]!, 11);
    return result;
  };
  const next = (): number => next32() / 2 ** 32;
  const int = (n: number): number => {
    if (!Number.isInteger(n) || n <= 0) throw new Error("int: n must be a positive integer");
    return Math.floor(next() * n);
  };
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("pick: empty list");
      return items[int(items.length)]!;
    },
    shuffle<T>(items: T[]): void {
      for (let i = items.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const tmp = items[i]!;
        items[i] = items[j]!;
        items[j] = tmp;
      }
    },
    normal(): number {
      const u1 = 1 - next(); // (0, 1]
      const u2 = next();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
  };
}
