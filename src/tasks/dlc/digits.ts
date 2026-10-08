// Numeric outcome compression, as dlcspecs NumericOutcomeCompression.md specifies it (pinned in
// config/dlc.json). An interval of outcomes with one payout is covered by digit prefixes; each
// prefix is one adaptor signature. `groupByIgnoringDigits` is the specification's algorithm, line
// for line; `prefixCount` returns its length without building the prefixes, and the tests hold the
// two equal.

/** Digits of `num` in `base`, most significant first, padded to `numDigits`. */
export function decompose(num: number, base: number, numDigits: number): number[] {
  const digits: number[] = [];
  let current = num;
  for (let i = 0; i < numDigits; i++) {
    digits.push(current % base);
    current = Math.floor(current / base);
  }
  return digits.reverse();
}

function separatePrefix(start: number, end: number, base: number, numDigits: number): { prefix: number[]; startDigits: number[]; endDigits: number[] } {
  const s = decompose(start, base, numDigits);
  const e = decompose(end, base, numDigits);
  let k = 0;
  while (k < numDigits && s[k] === e[k]) k++;
  return { prefix: s.slice(0, k), startDigits: s.slice(k), endDigits: e.slice(k) };
}

function frontGroupings(digits: number[], base: number): number[][] {
  // (digit, number of less significant digits) from the least significant digit up, trailing zeros dropped.
  const reversed = digits.map((d, i) => [d, digits.length - 1 - i] as [number, number]).reverse();
  const nonZero = reversed.slice(reversed.findIndex(([d]) => d !== 0) === -1 ? reversed.length : reversed.findIndex(([d]) => d !== 0));
  if (nonZero.length === 0) return [[0]];
  const fromFront: number[][] = [];
  for (const [last, unimportant] of nonZero.slice(0, -1)) {
    const fixed = digits.slice(0, digits.length - unimportant - 1);
    for (let d = last + 1; d < base; d++) fromFront.push([...fixed, d]);
  }
  return [nonZero.map(([d]) => d).reverse(), ...fromFront];
}

function backGroupings(digits: number[], base: number): number[][] {
  const reversed = digits.map((d, i) => [d, digits.length - 1 - i] as [number, number]).reverse();
  const first = reversed.findIndex(([d]) => d !== base - 1);
  const nonMax = first === -1 ? [] : reversed.slice(first);
  if (nonMax.length === 0) return [[base - 1]];
  const fromBack: number[][] = [];
  for (const [last, unimportant] of nonMax.slice(0, -1)) {
    const fixed = digits.slice(0, digits.length - unimportant - 1);
    for (let d = last - 1; d >= 0; d--) fromBack.push([...fixed, d]);
  }
  return [...fromBack.reverse(), nonMax.map(([d]) => d).reverse()];
}

function middleGrouping(firstStart: number, firstEnd: number): number[][] {
  const out: number[][] = [];
  for (let d = firstStart + 1; d < firstEnd; d++) out.push([d]);
  return out;
}

/** The specification's `groupByIgnoringDigits`: digit prefixes covering [start, end]. */
export function groupByIgnoringDigits(start: number, end: number, base: number, numDigits: number): number[][] {
  if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end < base ** numDigits)) {
    throw new Error(`groupByIgnoringDigits: bad interval [${start}, ${end}] for ${numDigits} digits in base ${base}`);
  }
  const { prefix, startDigits, endDigits } = separatePrefix(start, end, base, numDigits);
  if (start === end) return [prefix];
  if (startDigits.every((d) => d === 0) && endDigits.every((d) => d === base - 1)) {
    if (prefix.length > 0) return [prefix];
    throw new Error("DLCs with only one outcome are not supported.");
  }
  if (prefix.length === numDigits - 1) {
    const out: number[][] = [];
    for (let d = startDigits[startDigits.length - 1]!; d <= endDigits[endDigits.length - 1]!; d++) out.push([...prefix, d]);
    return out;
  }
  const groupings = [...frontGroupings(startDigits, base), ...middleGrouping(startDigits[0]!, endDigits[0]!), ...backGroupings(endDigits, base)];
  return groupings.map((g) => [...prefix, ...g]);
}

/**
 * The number of prefixes `groupByIgnoringDigits` returns, in O(numDigits). For the front groupings
 * each digit of the start's unique part, from its lowest non-zero digit up to but excluding its
 * first digit, adds base − 1 − digit; the back groupings mirror that with the digit itself; the
 * two endpoints add one each, and the middle adds the first digits' gap less one.
 */
export function prefixCount(start: number, end: number, base: number, numDigits: number): number {
  if (start === end) return 1;
  const s = decompose(start, base, numDigits);
  const e = decompose(end, base, numDigits);
  let k = 0;
  while (k < numDigits && s[k] === e[k]) k++;
  let allZero = true;
  let allMax = true;
  for (let i = k; i < numDigits; i++) {
    if (s[i] !== 0) allZero = false;
    if (e[i] !== base - 1) allMax = false;
  }
  if (allZero && allMax) {
    if (k > 0) return 1;
    throw new Error("DLCs with only one outcome are not supported.");
  }
  if (k === numDigits - 1) return e[numDigits - 1]! - s[numDigits - 1]! + 1;
  // Front: the unique digits of start are s[k..n-1]. Drop trailing zeros; the remaining run from the
  // lowest non-zero digit up to s[k]; every digit but s[k] adds base − 1 − digit; plus the endpoint.
  let front = 1;
  let low = numDigits - 1;
  while (low > k && s[low] === 0) low--;
  if (!(low === k && s[k] === 0)) for (let i = low; i > k; i--) front += base - 1 - s[i]!;
  let back = 1;
  let high = numDigits - 1;
  while (high > k && e[high] === base - 1) high--;
  if (!(high === k && e[k] === base - 1)) for (let i = high; i > k; i--) back += e[i]!;
  const middle = Math.max(0, e[k]! - s[k]! - 1);
  return front + middle + back;
}

/** `prefixCount` for base 2 with bit operations, for the hot loops. Outcomes must be below 2^31. */
export function binaryPrefixCount(start: number, end: number, numDigits: number): number {
  if (start === end) return 1;
  // Unique part: the bits below the highest differing bit, inclusive.
  const diff = start ^ end;
  const top = 31 - Math.clz32(diff); // index of the first differing bit; bits top..0 are unique
  const mask = top === 31 ? 0xffffffff : (2 ** (top + 1)) - 1;
  const su = start & mask;
  const eu = end & mask;
  if (su === 0 && eu === mask) {
    if (top < numDigits - 1) return 1;
    throw new Error("DLCs with only one outcome are not supported.");
  }
  if (top === 0) return 2; // prefix of length numDigits − 1; start ends in 0 and end in 1
  // Front: bits top−1 .. lowest set bit of su (exclusive of trailing zeros); each zero bit adds one.
  let front = 1;
  const sLow = su & (2 ** top - 1); // start's unique bits below its first unique bit (which is 0)
  if (sLow !== 0) {
    const lowest = 31 - Math.clz32(sLow & -sLow);
    for (let i = lowest; i < top; i++) if (((su >>> i) & 1) === 0) front += 1;
  }
  // Back: bits top−1 .. lowest zero bit of eu (trailing ones dropped); each one bit adds one.
  let back = 1;
  const eLow = eu & (2 ** top - 1); // end's unique bits below its first unique bit (which is 1)
  const ones = eLow ^ (2 ** top - 1); // zero bits of eLow become ones
  if (ones !== 0) {
    const lowest = 31 - Math.clz32(ones & -ones);
    for (let i = lowest; i < top; i++) if (((eu >>> i) & 1) === 1) back += 1;
  }
  return front + back; // the middle grouping is empty in base 2
}
