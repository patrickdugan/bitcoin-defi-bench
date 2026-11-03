// The TRM complex: a skill restructured as Dugan, "MeTTa-Scaffolded Repair Curricula for TRM-Infused
// Hermes Skills" (2026), §12 lays it out, each decision owned by the cheapest executor reliable for it.
//
//   observe → propose → validate → repair → validate → commit or veto → record
//
// The language model proposes an action. A package declares, one atom per line in a small MeTTa-style
// file, the typed state a verifier can see, the verifier's rules, the repair operators in the order
// they are tried, and the gate's menu; the compiler here checks that the code implements exactly what
// the package declares. A proposal that breaks a rule is repaired by the first operator whose action
// passes the rules, and vetoed to the skill's action if none does. A legal proposal equal to the
// skill's action is sent. What is left, a legal proposal that differs from the skill's action, goes to
// the gate: tiny recursive networks trained on the proposer's own development near-misses
// (`scripts/train_complex_gate.ts`), majority-voted, or a constant where the training labels never
// disagree. Every turn emits a typed record, so evaluation data are produced by construction.

import type { Agent, EpisodeInfo } from "../harness/agent.ts";
import { canonical, isObject, sha256, type Json } from "../harness/json.ts";
import type { Skill } from "./chat.ts";
import { Trm, type TrmJson } from "./trm.ts";

/** What a package's code sees on a turn. `history` ends with `observation`. */
export interface Turn {
  observation: Json;
  history: readonly Json[];
  proposal: Json;
  reference: Json;
}

export interface PackageCode {
  /** A declared atom's value on a turn. */
  atoms: { [name: string]: (t: Turn) => number };
  /** A declared verifier rule: null when the action passes it, else the verdict. */
  rules: { [name: string]: (t: Turn, action: Json) => string | null };
  /** A declared repair operator: the action it proposes, or null when it has none. */
  operators: { [name: string]: (t: Turn) => Json | null };
  /** The skill whose action is the reference and the repair: the complex runs it itself every turn. */
  skill: Skill;
}

export interface CompiledPackage {
  name: string;
  skill: string;
  /** SHA-256 of the package text. */
  sha256: string;
  atoms: string[];
  rules: string[];
  operators: string[];
  /** The gate's menu: "commit" (send the proposal) or an operator. */
  gate: string[];
  code: PackageCode;
}

/** Read a package: one parenthesized atom per line, `;` comments. Declared and implemented must match exactly. */
export function compilePackage(text: string, code: PackageCode): CompiledPackage {
  let name: string | null = null;
  let skill: string | null = null;
  const declared: { [kind: string]: string[] } = { atom: [], rule: [], operator: [], gate: [] };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/;.*$/, "").trim();
    if (line === "") continue;
    const m = line.match(/^\((\S+)((?:\s+[A-Za-z0-9_-]+)+)\)$/);
    if (!m) throw new Error(`package line is not one atom: ${line}`);
    const [head, args] = [m[1]!, m[2]!.trim().split(/\s+/)];
    if (head === "skill") { if (skill !== null || args.length !== 1) throw new Error("a package names one skill"); skill = args[0]!; continue; }
    if (head === "complex") { if (name !== null || args.length !== 1) throw new Error("a package names one complex"); name = args[0]!; continue; }
    if (!(head in declared)) throw new Error(`unknown package atom (${head} ...)`);
    if (head === "gate") { if (declared.gate!.length) throw new Error("a package declares one gate"); declared.gate = args; continue; }
    if (args.length !== 1) throw new Error(`(${head} ...) takes one name`);
    if (declared[head]!.includes(args[0]!)) throw new Error(`${head} ${args[0]} is declared twice`);
    declared[head]!.push(args[0]!);
  }
  if (name === null) throw new Error("the package names no complex");
  if (skill !== code.skill.name) throw new Error(`${name}: declares skill ${skill}, implements ${code.skill.name}`);
  const match = (kind: string, implemented: object): void => {
    const missing = declared[kind]!.filter((n) => !(n in implemented));
    const extra = Object.keys(implemented).filter((n) => !declared[kind]!.includes(n));
    if (missing.length) throw new Error(`${name}: declared ${kind} not implemented: ${missing.join(", ")}`);
    if (extra.length) throw new Error(`${name}: implemented ${kind} not declared: ${extra.join(", ")}`);
  };
  match("atom", code.atoms);
  match("rule", code.rules);
  match("operator", code.operators);
  if (declared.gate!.length < 2 || declared.gate![0] !== "commit" || !declared.gate!.slice(1).every((g) => declared.operator!.includes(g))) {
    throw new Error(`${name}: the gate's menu is commit followed by declared operators`);
  }
  return { name, skill, sha256: sha256(text), atoms: declared.atom!, rules: declared.rule!, operators: declared.operator!, gate: declared.gate!, code };
}

/** The declared atoms in declared order. Non-finite values are an error, not a feature. */
export function features(pkg: CompiledPackage, t: Turn): number[] {
  return pkg.atoms.map((a) => {
    const v = pkg.code.atoms[a]!(t);
    if (!Number.isFinite(v)) throw new Error(`${pkg.name}: atom ${a} is not finite`);
    return v;
  });
}

/** The first rule the action breaks, or null. */
export function verify(pkg: CompiledPackage, t: Turn, action: Json): string | null {
  for (const r of pkg.rules) {
    const verdict = pkg.code.rules[r]!(t, action);
    if (verdict !== null) return `${r}: ${verdict}`;
  }
  return null;
}

/** The gate file: the package it was trained for, its menu, and five or so networks, or a constant choice. */
export interface GateJson {
  kind: "trm-gate";
  package: { name: string; sha256: string };
  menu: string[];
  /** Set when every training label agreed: the gate is that rule, no network. */
  constant: string | null;
  models: TrmJson[];
  training: Json;
}

export class Gate {
  readonly sha256: string;
  readonly file: GateJson;
  private readonly models: Trm[];
  constructor(file: GateJson) {
    this.file = file;
    this.sha256 = sha256(canonical(file as unknown as Json));
    this.models = file.models.map((m) => Trm.fromJson(m));
    if (file.constant === null && this.models.length === 0) throw new Error("a gate needs networks or a constant");
    if (file.constant !== null && !file.menu.includes(file.constant)) throw new Error(`constant ${file.constant} is not on the menu`);
  }
  /** Majority over the networks; a tie goes to the last menu entry, the skill's action. */
  choose(atoms: readonly number[]): string {
    if (this.file.constant !== null) return this.file.constant;
    const votes = this.file.menu.map(() => 0);
    for (const m of this.models) votes[m.predict(atoms)]! += 1;
    let best = this.file.menu.length - 1;
    for (let i = 0; i < votes.length; i++) if (votes[i]! > votes[best]!) best = i;
    return this.file.menu[best]!;
  }
}

export type Stage = "agree" | "gate" | "repair" | "veto";

export interface ComplexRecord {
  episode: EpisodeInfo;
  turn: number;
  atoms: number[];
  verdict: string | null;
  stage: Stage;
  choice: string;
  proposal: Json;
  reference: Json;
  sent: Json;
}

export interface ComplexOptions {
  name: string;
  /** The language model, as an agent; its own identity is part of the complex's. */
  proposer: Agent & { describe(): Json };
  pkg: CompiledPackage;
  gate: Gate;
  onRecord?: (record: ComplexRecord) => void;
}

export const COMPLEX_VERSION = "trm-complex/v0";

export class TrmComplex implements Agent {
  readonly id: string;
  private readonly options: ComplexOptions;
  private history: Json[] = [];
  private episode: EpisodeInfo = { task: "", seed: -1, cell: "" };
  /** Turns per stage in this process, for the run notes. */
  readonly counts: { [stage in Stage]: number } = { agree: 0, gate: 0, repair: 0, veto: 0 };

  constructor(options: ComplexOptions) {
    if (options.gate.file.package.sha256 !== options.pkg.sha256) throw new Error(`gate was trained for package ${options.gate.file.package.name}@${options.gate.file.package.sha256.slice(0, 12)}, not this one`);
    this.options = options;
    this.id = `${options.name}@${sha256(canonical(this.describe())).slice(0, 12)}`;
  }

  /** Everything the id binds: the proposer's identity, the package text, the gate file. */
  describe(): Json {
    const { proposer, pkg, gate } = this.options;
    return { complex: COMPLEX_VERSION, proposer: proposer.describe(), proposer_id: proposer.id, package: { name: pkg.name, sha256: pkg.sha256 }, skill: { name: pkg.code.skill.name, sha256: pkg.code.skill.sha256 }, gate: { sha256: gate.sha256, menu: gate.file.menu, constant: gate.file.constant, models: gate.file.models.length } };
  }

  reset(episode: EpisodeInfo): void {
    this.episode = episode;
    this.history = [];
    this.options.proposer.reset?.(episode);
  }

  async act(observation: Json): Promise<Json> {
    const { proposer, pkg, gate } = this.options;
    this.history.push(observation);
    const proposal = await proposer.act(observation);
    const reference = pkg.code.skill.run(observation, {}, this.history);
    const t: Turn = { observation, history: this.history, proposal, reference };
    const atoms = features(pkg, t);
    const verdict = verify(pkg, t, proposal);
    let stage: Stage;
    let choice: string;
    let sent: Json;
    if (verdict === null && canonical(proposal) === canonical(reference)) {
      stage = "agree"; choice = "commit"; sent = proposal;
    } else if (verdict === null) {
      stage = "gate";
      choice = gate.choose(atoms);
      const repaired = choice === "commit" ? proposal : pkg.code.operators[choice]!(t);
      sent = repaired !== null && verify(pkg, t, repaired) === null ? repaired : reference;
    } else {
      stage = "veto"; choice = "reference"; sent = reference;
      for (const op of pkg.operators) {
        const a = pkg.code.operators[op]!(t);
        if (a !== null && verify(pkg, t, a) === null) { stage = "repair"; choice = op; sent = a; break; }
      }
    }
    this.counts[stage] += 1;
    const turn = (observation as { episode: { turn: number } }).episode.turn;
    this.options.onRecord?.({ episode: this.episode, turn, atoms, verdict, stage, choice, proposal, reference, sent });
    return sent;
  }
}

// ---------------------------------------------------------------------------------------------
// Atoms and rules every package declares, over any family's observation envelope.

const obj = (x: Json): { [k: string]: Json } => (isObject(x) ? (x as { [k: string]: Json }) : {});
export const toolOf = (a: Json): string | null => (isObject(a) && typeof a.tool === "string" ? a.tool : null);
export const argsOf = (a: Json): { [k: string]: Json } => obj(obj(a).args ?? null);
const budgetOf = (o: Json): { attempts: number; probes: number; blocks: number } => obj(o).budget as unknown as { attempts: number; probes: number; blocks: number };
export const viewOf = <T>(o: Json): T => obj(o).view as unknown as T;

export const COMMON_ATOMS: PackageCode["atoms"] = {
  "proposal-parses": (t) => (toolOf(t.proposal) !== null ? 1 : 0),
  "tool-known": (t) => ((obj(t.observation).tools as string[]).includes(toolOf(t.proposal) ?? "") ? 1 : 0),
  "same-tool": (t) => (toolOf(t.proposal) !== null && toolOf(t.proposal) === toolOf(t.reference) ? 1 : 0),
  "proposes-commit": (t) => (toolOf(t.proposal) === "commit" ? 1 : 0),
  "reference-commits": (t) => (toolOf(t.reference) === "commit" ? 1 : 0),
  "turn": (t) => Math.log1p(t.history.length - 1),
  "attempts-left": (t) => budgetOf(t.observation).attempts / Math.max(1, budgetOf(t.history[0]!).attempts),
  "blocks-left": (t) => (budgetOf(t.history[0]!).blocks > 0 ? budgetOf(t.observation).blocks / budgetOf(t.history[0]!).blocks : 0),
  "last-rejected": (t) => { const last = obj(t.observation).last; return isObject(last) && last.accepted === false ? 1 : 0; },
};

export const COMMON_RULES: PackageCode["rules"] = {
  "parses": (_t, a) => (toolOf(a) === null ? "not one JSON object with a tool" : null),
  "known-tool": (t, a) => ((obj(t.observation).tools as string[]).includes(toolOf(a) ?? "") ? null : `no tool ${toolOf(a)}`),
  "args-object": (_t, a) => (obj(a).args === undefined || isObject(obj(a).args ?? null) ? null : "args is not an object"),
};

/** The handles earlier results returned in this episode: what an action may pass on. */
export function handlesSeen(history: readonly Json[]): Set<string> {
  const seen = new Set<string>();
  for (const o of history) {
    const r = obj(obj(obj(o).last).result ?? null);
    if (typeof r.handle === "string") seen.add(r.handle);
  }
  return seen;
}
