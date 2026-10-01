// Canonical JSON and hashing. Every hash in the bench (fixtures, manifest, run record, state
// snapshots) is taken over this serialization, so that key order and container iteration order
// can never change a hash. Maps and Sets are serialized as sorted entry lists.

import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical serialization: sorted keys, no whitespace, finite numbers only. */
export function canonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonical: non-finite number");
      return JSON.stringify(value);
    case "string": return JSON.stringify(value);
    case "object": break;
    default: throw new Error(`canonical: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([k, v]) => `[${canonical(k)},${canonical(v)}]`).sort(cmp);
    return `{"$map":[${entries.join(",")}]}`;
  }
  if (value instanceof Set) {
    return `{"$set":[${[...value].map(canonical).sort(cmp).join(",")}]}`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(cmp);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Git blob id of text content after CRLF→LF normalization, so the id is the same on every platform. */
export function gitBlobId(content: Uint8Array): string {
  const lf = Buffer.from(Buffer.from(content).toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return createHash("sha1").update(`blob ${lf.length}\0`).update(lf).digest("hex");
}

/** Whether a value is a plain JSON object (not null, not an array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
