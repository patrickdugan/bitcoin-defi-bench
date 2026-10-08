// NIP-19 bare keys and ids: bech32 (BIP-173, not bech32m) over 32 bytes with the prefixes npub,
// nsec, and note. The bench uses them for display and for the custody cell's leak detector, which
// must recognize a secret key in either encoding (docs/tasks.md §10.2). TLV entities are not needed.

import { CryptoError } from "./secp256k1.ts";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
  }
  return chk >>> 0;
}

const hrpExpand = (hrp: string): number[] => [
  ...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];

function convertBits(data: Uint8Array | number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new CryptoError("invalid bech32 data");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits > 0) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) throw new CryptoError("invalid bech32 padding");
  return out;
}

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(bytes, 8, 5, true);
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (chk >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}

export function bech32Decode(text: string): { hrp: string; bytes: Uint8Array } {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) throw new CryptoError("mixed-case bech32");
  const s = text.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) throw new CryptoError("invalid bech32 separator");
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => {
    const d = CHARSET.indexOf(c);
    if (d < 0) throw new CryptoError("invalid bech32 character");
    return d;
  });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new CryptoError("invalid bech32 checksum");
  return { hrp, bytes: Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

export type Nip19Prefix = "npub" | "nsec" | "note";

export const nip19Encode = (prefix: Nip19Prefix, bytes32: Uint8Array): string => {
  if (bytes32.length !== 32) throw new CryptoError(`${prefix} must encode 32 bytes`);
  return bech32Encode(prefix, bytes32);
};

export function nip19Decode(text: string, prefix: Nip19Prefix): Uint8Array {
  const { hrp, bytes } = bech32Decode(text);
  if (hrp !== prefix) throw new CryptoError(`expected ${prefix}, got ${hrp}`);
  if (bytes.length !== 32) throw new CryptoError(`${prefix} must decode to 32 bytes`);
  return bytes;
}
