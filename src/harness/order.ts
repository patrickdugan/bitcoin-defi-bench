// Canonical ordering helpers. The audit (paper/liquidity_on_trial.md §7) found that the earlier
// generator sorted raw edge tuples before canonicalizing endpoints and enumerated candidates in
// container order, so a hash seed changed the results. Everything that could break a tie by
// insertion order goes through these functions instead. Comparison is by UTF-16 code unit, never
// by locale.

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Lexicographic comparison of node sequences; a proper prefix sorts first. */
export function cmpSeq(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmp(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** Endpoints of an undirected pair in canonical order. */
export function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Key of an undirected pair. Endpoints are canonicalized before the key is formed. */
export function pairKey(a: string, b: string): string {
  const [u, v] = sortedPair(a, b);
  return `${u}|${v}`;
}

/** Zero-padded identifier, so that lexicographic and numeric order agree. */
export function nodeId(index: number, prefix = "N", width = 3): string {
  return `${prefix}${String(index).padStart(width, "0")}`;
}

type Key = string | number;

/** Sort by a tuple of keys. The key tuple must be a total order on the items; ties throw. */
export function sortByKeys<T>(items: readonly T[], keys: (item: T) => readonly Key[]): T[] {
  const decorated = items.map((item) => ({ item, k: keys(item) }));
  decorated.sort((x, y) => {
    for (let i = 0; i < x.k.length; i++) {
      const a = x.k[i]!;
      const b = y.k[i]!;
      if (a === b) continue;
      if (typeof a === "number" && typeof b === "number") return a - b;
      return cmp(String(a), String(b));
    }
    return 0;
  });
  for (let i = 1; i < decorated.length; i++) {
    const a = decorated[i - 1]!.k;
    const b = decorated[i]!.k;
    if (a.length === b.length && a.every((v, j) => v === b[j])) {
      throw new Error(`sortByKeys: key is not a total order (tie at ${JSON.stringify(a)})`);
    }
  }
  return decorated.map((d) => d.item);
}
