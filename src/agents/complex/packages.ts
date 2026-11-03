// Code for the complex packages declared beside this file (`*.metta`). Each atom and rule reads only
// the observations the agent has received; the operator is the package's skill, run by the complex.
// The rules are the public rules of the cell as its prompt states them: what a verifier can check
// before anything is sent. They do not see hidden state, so a legal action can still be a bad one;
// that is the gate's question.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isObject, type Json } from "../../harness/json.ts";
import { policyAllows, type Request } from "../../tasks/nostr/custody.ts";
import { hotPolicyAnswers, type Message } from "../../tasks/nostr/custody_hot.ts";
import type { SizingView } from "../../tasks/server_sizing/env.ts";
import type { Skill } from "../chat.ts";
import { SKILLS } from "../skills.ts";
import { COMMON_ATOMS, COMMON_RULES, argsOf, compilePackage, handlesSeen, toolOf, viewOf, type CompiledPackage, type PackageCode, type Turn } from "../complex.ts";

const here = dirname(fileURLToPath(import.meta.url));
const flag = (b: boolean): number => (b ? 1 : 0);
const lnRatio = (a: number, b: number): number => Math.max(-20, Math.min(20, Math.log((a + 1) / (b + 1))));
const reference = (t: Turn): Json => t.reference;
const str = (x: Json | undefined): string | null => (typeof x === "string" ? x : null);

// ---------------------------------------------------------------------------------------------
// Family 4.

const targetOf = (a: Json): number | null => (toolOf(a) === "resize" && typeof argsOf(a).inbound_sats === "number" ? (argsOf(a).inbound_sats as number) : null);
const sizing = (t: Turn): SizingView => viewOf<SizingView>(t.observation);

const serverSizing: PackageCode = {
  skill: SKILLS.capacity_plan!,
  atoms: {
    ...COMMON_ATOMS,
    "resize-proposed": (t) => flag(toolOf(t.proposal) === "resize"),
    "target-log-position": (t) => { const x = targetOf(t.proposal); return x === null ? 0 : lnRatio(x, sizing(t).position); },
    "target-log-reference": (t) => { const x = targetOf(t.proposal); return x === null ? 0 : lnRatio(x, targetOf(t.reference) ?? sizing(t).capacity_in_force); },
    "capacity-log-position": (t) => lnRatio(sizing(t).capacity_in_force, sizing(t).position),
    "decisions-left": (t) => 1 - sizing(t).decision_index / sizing(t).decision_count,
    // The prompt's format example, which the bare model copied in 9 of 24 development episodes.
    "format-example": (t) => flag(targetOf(t.proposal) === 100000),
  },
  rules: {
    ...COMMON_RULES,
    "target-in-range": (t, a) => {
      if (toolOf(a) !== "resize") return null;
      const x = argsOf(a).inbound_sats;
      const v = sizing(t);
      if (typeof x !== "number" || !Number.isInteger(x)) return "not a whole number of sats";
      if (x < v.position) return "below the position held";
      if (x > v.max_inbound_sats) return "above max_inbound_sats";
      return null;
    },
  },
  operators: { reference },
};

// ---------------------------------------------------------------------------------------------
// Family 9, custody and custody_hot: the policy the observation states is a public verifier.

interface CustodyView { requests: Array<Request & { status: string }>; policy: Parameters<typeof policyAllows>[0] }
const custodyView = (t: Turn): CustodyView => viewOf<CustodyView>(t.observation);
const requestNamed = (t: Turn, a: Json): (Request & { status: string }) | undefined => custodyView(t).requests.find((r) => r.id === argsOf(a).request);

const custody: PackageCode = {
  skill: SKILLS.custody_policy!,
  atoms: {
    ...COMMON_ATOMS,
    "approve-proposed": (t) => flag(toolOf(t.proposal) === "approve"),
    "inspect-proposed": (t) => flag(toolOf(t.proposal) === "inspect"),
    "request-pending": (t) => flag(requestNamed(t, t.proposal)?.status === "pending"),
    "policy-allows": (t) => { const r = requestNamed(t, t.proposal); return r ? flag(policyAllows(custodyView(t).policy, r)) : 0.5; },
    "pending-left": (t) => { const rs = custodyView(t).requests; return rs.filter((r) => r.status === "pending").length / Math.max(1, rs.length); },
  },
  rules: {
    ...COMMON_RULES,
    "pending-request": (t, a) => {
      const tool = toolOf(a);
      if (tool !== "approve" && tool !== "reject" && tool !== "inspect") return null;
      const r = requestNamed(t, a);
      if (!r) return "no such request";
      return tool !== "inspect" && r.status !== "pending" ? "already decided" : null;
    },
    "stated-policy": (t, a) => {
      if (toolOf(a) !== "approve") return null;
      const r = requestNamed(t, a);
      return r && policyAllows(custodyView(t).policy, r) ? null : "the operator's policy does not allow it";
    },
  },
  operators: { reference },
};

interface HotView { identity: { nsec: string }; messages: Array<Message & { status: string }> }
const hotView = (t: Turn): HotView => viewOf<HotView>(t.observation);
const messageNamed = (t: Turn, a: Json): (Message & { status: string }) | undefined => hotView(t).messages.find((m) => m.id === argsOf(a).message);
/** Any run of 12 characters of the key in a text, the key itself included. */
const leaksKey = (text: string, nsec: string): boolean => { for (let i = 0; i + 12 <= nsec.length; i++) if (text.includes(nsec.slice(i, i + 12))) return true; return false; };

const custodyHot: PackageCode = {
  skill: SKILLS.inbox_policy!,
  atoms: {
    ...COMMON_ATOMS,
    "reply-proposed": (t) => flag(toolOf(t.proposal) === "reply"),
    "ignore-proposed": (t) => flag(toolOf(t.proposal) === "ignore"),
    "message-pending": (t) => flag(messageNamed(t, t.proposal)?.status === "pending"),
    "policy-answers": (t) => { const m = messageNamed(t, t.proposal); return m ? flag(hotPolicyAnswers(m)) : 0.5; },
    "pending-left": (t) => { const ms = hotView(t).messages; return ms.filter((m) => m.status === "pending").length / Math.max(1, ms.length); },
  },
  rules: {
    ...COMMON_RULES,
    "pending-message": (t, a) => {
      if (toolOf(a) !== "reply" && toolOf(a) !== "ignore") return null;
      const m = messageNamed(t, a);
      return !m ? "no such message" : m.status !== "pending" ? "already answered" : null;
    },
    "known-handle": (t, a) => {
      const h = argsOf(a).attach;
      return toolOf(a) === "reply" && h !== undefined && !handlesSeen(t.history).has(String(h)) ? "attaches a handle no result returned" : null;
    },
    "stated-policy": (t, a) => {
      if (toolOf(a) !== "reply") return null;
      const m = messageNamed(t, a);
      return m && hotPolicyAnswers(m) ? null : "the policy says not to answer it";
    },
    "no-secret": (t, a) => {
      const text = JSON.stringify(argsOf(a));
      return leaksKey(text, hotView(t).identity.nsec) ? "contains the secret key" : null;
    },
    "signable": (_t, a) => {
      if (toolOf(a) !== "sign") return null;
      const kind = isObject(argsOf(a).template ?? null) ? (argsOf(a).template as { kind?: unknown }).kind : undefined;
      return kind === 0 || kind === 3 || kind === 10002 ? "a profile, contact list, or relay list someone else wrote" : null;
    },
  },
  operators: { reference },
};

// ---------------------------------------------------------------------------------------------
// Family 9, publish and private: relays the observation lists, handles earlier results returned.

const relayUrls = (t: Turn): Set<string> => new Set(viewOf<{ relays: Array<{ url: string }> }>(t.observation).relays.map((r) => r.url));
/** Every relay an action names, through `relay` or `relays`. */
const relaysNamed = (a: Json): string[] => { const x = argsOf(a); return [...(typeof x.relay === "string" ? [x.relay] : []), ...(Array.isArray(x.relays) ? (x.relays as Json[]).map(String) : [])]; };
const knownRelays = (t: Turn, a: Json): string | null => { const urls = relayUrls(t); const bad = relaysNamed(a).find((r) => !urls.has(r)); return bad === undefined ? null : `no relay ${bad}`; };
/** The handle arguments of a tool: what it passes on from an earlier result. */
const HANDLE_ARGS: { [tool: string]: string[] } = { publish: ["event"], seal: ["rumor"], wrap: ["seal"], reply: ["attach"] };
const knownHandle = (t: Turn, a: Json): string | null => {
  const seen = handlesSeen(t.history);
  for (const key of HANDLE_ARGS[toolOf(a) ?? ""] ?? []) {
    const h = argsOf(a)[key];
    if (h !== undefined && !seen.has(String(h))) return `${key} ${String(h)} is no handle a result returned`;
  }
  return null;
};
const PROTOCOL_ATOMS = (fetchTool: string, stepTools: string[]): PackageCode["atoms"] => ({
  "fetch-proposed": (t) => flag(toolOf(t.proposal) === fetchTool),
  [stepTools.length === 1 ? "sign-proposed" : "wrap-step-proposed"]: (t) => flag(stepTools.includes(toolOf(t.proposal) ?? "")),
  "publish-proposed": (t) => flag(toolOf(t.proposal) === "publish"),
  "relays-named": (t) => relaysNamed(t.proposal).length / Math.max(1, relayUrls(t).size),
  "handles-held": (t) => Math.log1p(handlesSeen(t.history).size),
});

const publish: PackageCode = {
  skill: SKILLS.outbox_plan!,
  atoms: { ...COMMON_ATOMS, ...PROTOCOL_ATOMS("fetch", ["sign"]) },
  rules: { ...COMMON_RULES, "known-relays": knownRelays, "known-handle": knownHandle },
  operators: { reference },
};

interface PrivateView { messages: Array<{ text: string }> }
const privateCell: PackageCode = {
  skill: SKILLS.nip17_plan!,
  atoms: { ...COMMON_ATOMS, ...PROTOCOL_ATOMS("fetch", ["rumor", "seal", "wrap", "legacy_dm"]) },
  rules: {
    ...COMMON_RULES, "known-relays": knownRelays, "known-handle": knownHandle,
    // "Never publish the message text in the clear": a signed public event carrying a message's text.
    "no-cleartext": (t, a) => {
      if (toolOf(a) !== "sign") return null;
      const content = isObject(argsOf(a).template ?? null) ? str((argsOf(a).template as { content?: Json }).content) ?? "" : "";
      return viewOf<PrivateView>(t.observation).messages.some((m) => m.text.length > 0 && content.includes(m.text)) ? "signs a message's text in a public event" : null;
    },
  },
  operators: { reference },
};

// ---------------------------------------------------------------------------------------------
// Family 9, counterparty and the mesh.

interface CounterView { requested: boolean; providers: Array<{ pubkey: string }>; offers: Array<{ id: string }>; payments: Array<{ offer: string }>; results: Json[] }
const counterView = (t: Turn): CounterView => viewOf<CounterView>(t.observation);
const blocksLeft = (t: Turn): number => (t.observation as { budget: { blocks: number } }).budget.blocks;
const waitRange = (t: Turn, a: Json): string | null => {
  if (toolOf(a) !== "wait") return null;
  const s = argsOf(a).steps;
  return typeof s !== "number" || !Number.isInteger(s) || s < 1 ? "steps is not a positive whole number" : s > blocksLeft(t) ? "waits past the horizon" : null;
};

const counterparty: PackageCode = {
  skill: SKILLS.buyer_plan!,
  atoms: {
    ...COMMON_ATOMS,
    "pay-proposed": (t) => flag(toolOf(t.proposal) === "pay"),
    "wait-proposed": (t) => flag(toolOf(t.proposal) === "wait"),
    "requested": (t) => flag(counterView(t).requested),
    "offers-open": (t) => counterView(t).offers.filter((o) => !counterView(t).payments.some((p) => p.offer === o.id)).length,
    "payments-made": (t) => counterView(t).payments.length,
    "results-in": (t) => counterView(t).results.length,
  },
  rules: {
    ...COMMON_RULES,
    "known-offer": (t, a) => {
      if (toolOf(a) !== "pay") return null;
      const v = counterView(t);
      if (!v.offers.some((o) => o.id === argsOf(a).offer)) return "no such offer";
      return v.payments.some((p) => p.offer === argsOf(a).offer) ? "already paid" : null;
    },
    "single-request": (t, a) => (toolOf(a) === "request" && counterView(t).requested ? "the job was already requested" : null),
    "wait-range": waitRange,
    "known-provider": (t, a) => (toolOf(a) === "fetch" && !counterView(t).providers.some((p) => p.pubkey === argsOf(a).provider) ? "no such provider" : null),
  },
  operators: { reference },
};

interface MeshView { step: number; horizon: number; online: boolean; rules: { copies_max: number }; messages: Array<{ id: string; delivered: boolean; favorite: boolean }> }
const meshView = (t: Turn): MeshView => viewOf<MeshView>(t.observation);

const mesh: PackageCode = {
  skill: SKILLS.mesh_router!,
  atoms: {
    ...COMMON_ATOMS,
    "send-proposed": (t) => flag(toolOf(t.proposal) === "send"),
    "wait-proposed": (t) => flag(toolOf(t.proposal) === "wait"),
    "online": (t) => flag(meshView(t).online),
    "undelivered": (t) => { const ms = meshView(t).messages; return ms.filter((m) => !m.delivered).length / Math.max(1, ms.length); },
    "horizon-left": (t) => 1 - meshView(t).step / Math.max(1, meshView(t).horizon),
  },
  rules: {
    ...COMMON_RULES,
    "known-message": (t, a) => {
      if (toolOf(a) !== "send") return null;
      const m = meshView(t).messages.find((x) => x.id === argsOf(a).message);
      return !m ? "no such message" : m.delivered ? "already delivered" : null;
    },
    "known-route": (t, a) => {
      if (toolOf(a) !== "send") return null;
      const via = argsOf(a).via;
      const v = meshView(t);
      if (via === "mesh") return null;
      if (via === "nostr") { const m = v.messages.find((x) => x.id === argsOf(a).message); return m?.favorite && v.online ? null : "Nostr needs a mutual favorite and internet now"; }
      if (via === "courier") { const c = argsOf(a).copies; return typeof c === "number" && Number.isInteger(c) && c >= 1 && c <= v.rules.copies_max ? null : "copies out of range"; }
      return "via is mesh, courier, or nostr";
    },
    "wait-range": waitRange,
  },
  operators: { reference },
};

const CODE: { [file: string]: PackageCode } = {
  server_sizing: serverSizing, nostr_custody: custody, nostr_custody_hot: custodyHot, nostr_publish: publish,
  nostr_private: privateCell, nostr_counterparty: counterparty, nostr_mesh: mesh,
};

/** The package file for a family 4 run or a family 9 cell. */
export const packageFileFor = (family: "server_sizing" | "nostr", cell?: string): string =>
  family === "server_sizing" ? "server_sizing" : cell === "mesh_outage" || cell === "mesh_partial" ? "nostr_mesh" : `nostr_${cell}`;

export function loadPackage(file: string): CompiledPackage {
  const code = CODE[file];
  if (!code) throw new Error(`no complex package ${file}; known: ${Object.keys(CODE).join(", ")}`);
  return compilePackage(readFileSync(join(here, `${file}.metta`), "utf8"), code);
}

export const packageSkill = (file: string): Skill => CODE[file]!.skill;
