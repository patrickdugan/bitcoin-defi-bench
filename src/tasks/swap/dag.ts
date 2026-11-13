// BitAgent's DAG v3 workflow, ported for family 11 (docs/tasks.md §14). The node set, the allowed
// transitions, and the host tool that enters each node are BitAgent's (patrickdugan/BitAgent commit
// 1cfe7e0, apps/bitagent-launch-kernel/src/bench/dag.ts), unchanged except that
// host.request_clarification is not offered: there is no principal to answer it inside an episode.
//
// The model proposes the next tool; the host admits it only along an allowed edge. Every
// state-changing action is one pass: observe -> inspect -> validate -> simulate -> display ->
// approval -> execute -> verify -> reconcile -> complete. `start` is the bench's name for "no pass
// open": a pass ends at `complete`, and the next one begins at `observe`.

export type DagNode =
  | "observe" | "inspect" | "validate" | "simulate" | "display" | "approval"
  | "execute" | "verify" | "reconcile" | "complete"
  | "hold" | "recovery" | "incident";

export type Node = DagNode | "start";

export const DAG_NEXT: Record<DagNode, DagNode[]> = {
  observe: ["inspect", "hold", "incident"],
  inspect: ["validate", "observe", "hold", "incident"],
  validate: ["simulate", "observe", "hold", "incident"],
  simulate: ["display", "hold", "recovery"],
  display: ["approval", "recovery", "hold"],
  approval: ["execute", "recovery", "incident"],
  execute: ["verify", "incident", "recovery"],
  verify: ["reconcile", "recovery", "hold", "incident"],
  reconcile: ["complete", "recovery", "incident"],
  complete: [],
  hold: ["observe", "validate", "recovery", "incident"],
  recovery: ["observe", "inspect", "validate", "display", "approval", "verify", "reconcile", "incident"],
  incident: ["recovery"],
};

export const NODE_TOOL: Record<Exclude<DagNode, "hold" | "recovery" | "incident">, string> = {
  observe: "market.observe",
  inspect: "host.inspect_evidence",
  validate: "host.validate_arguments",
  simulate: "host.simulate_action",
  display: "host.display_exact_effects_and_fees",
  approval: "wallet.request_approval",
  execute: "host.execute_approved",
  verify: "host.verify_effect",
  reconcile: "host.reconcile_ledger",
  complete: "host.persist_verified_state",
};

export const HOLD_TOOL = "host.hold_for_review";
export const REFRESH_TOOL = "host.refresh_evidence";
export const RESUME_TOOL = "host.resume_persisted_state";
export const INCIDENT_TOOL = "incident.revoke_and_freeze";

/** The node each tool enters. */
export const TOOL_NODE: Record<string, DagNode> = {
  ...Object.fromEntries(Object.entries(NODE_TOOL).map(([node, tool]) => [tool, node as DagNode])),
  [HOLD_TOOL]: "hold",
  [REFRESH_TOOL]: "recovery",
  [RESUME_TOOL]: "recovery",
  [INCIDENT_TOOL]: "incident",
};

export const ALL_TOOLS: string[] = Object.keys(TOOL_NODE).sort();

/** Nodes reachable from `node`; `start` opens a pass at `observe`. */
export function nextNodes(node: Node): DagNode[] {
  if (node === "start") return ["observe"];
  return DAG_NEXT[node];
}

/** Tools the host admits from `node`, sorted. */
export function allowedTools(node: Node): string[] {
  const nodes = new Set(nextNodes(node));
  return ALL_TOOLS.filter((tool) => nodes.has(TOOL_NODE[tool]!));
}
