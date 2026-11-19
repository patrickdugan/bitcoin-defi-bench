// Development-only execution contract. No network, keys, or model calls.
// Wire responses must be normalized by a trusted host before entering this model.
import { canonical, sha256 } from "../../harness/json.ts";

export interface OrderIntent {
  kind: "isolated_order";
  accountId: string;
  operationId: string;
  apiFamily: "perp" | "futures";
  clientId: string;
  instrument: "inverse_perp" | "quanto_perp";
  pair: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  quantity: string;
  leverage: string;
  price: string | null;
  // Host reservation, expressed in sats. It is not an LN Markets request field.
  reserveSats: string;
}

export interface Mandate {
  accountId: string;
  markets: ReadonlyArray<{ instrument: OrderIntent["instrument"]; pair: string }>;
  maxReservedSats: string;
  expiresAtMs: number;
  maxTickAgeMs: number;
}

export interface HostContext {
  nowMs: number;
  market: { instrument: OrderIntent["instrument"]; pair: string };
  // Normalized host capabilities, deliberately separate from venue scope strings.
  capabilities: ReadonlyArray<"read" | "trade" | "withdraw">;
  connected: boolean;
  authenticated: boolean;
  subscribed: boolean;
  reconciled: boolean;
  lastTickMs: number | null;
}

export type TradeStatus = "open" | "running" | "closed" | "canceled";
export interface ObservedTrade {
  accountId: string;
  clientId: string;
  tradeId: string;
  instrument: OrderIntent["instrument"];
  pair: string;
  side: OrderIntent["side"];
  orderType: OrderIntent["orderType"];
  quantity: string;
  leverage: string;
  price: string | null;
  status: TradeStatus;
}

export interface OrderRecord {
  intent: OrderIntent;
  intentHash: string;
  status: "pending" | "ambiguous" | "reconciliation_required" | TradeStatus;
  lastObservedStatus: TradeStatus | null;
  attempts: number;
  tradeId: string | null;
}

export interface ExecutionState {
  mandate: Mandate;
  orders: ReadonlyMap<string, OrderRecord>; // operationId, including terminal records
}

export interface Decision {
  state: ExecutionState;
  effect: "submit" | "retry_same_id" | "lookup" | "none";
  reason: string;
}

export type Outcome =
  | { kind: "ambiguous" } // timeout, connection loss, or gateway error
  | { kind: "conflict" } // 409 is evidence of ID use; it is not a fill receipt
  | { kind: "not_found" } // a lookup miss cannot prove the earlier request failed
  | { kind: "observed"; trade: ObservedTrade };

const positiveDecimal = (v: unknown): v is string =>
  typeof v === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(v) && !/^0(?:\.0+)?$/.test(v);
const sats = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]*$/.test(v);
const validTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
const terminal = (s: OrderRecord["status"]): boolean => s === "closed" || s === "canceled";
const intentKeys = ["accountId", "apiFamily", "clientId", "instrument", "kind", "leverage", "operationId", "orderType", "pair", "price", "quantity", "reserveSats", "side"].sort().join(",");

function validIntent(i: OrderIntent): boolean {
  return i !== null && typeof i === "object" && Object.keys(i).sort().join(",") === intentKeys
    && i.kind === "isolated_order" && text(i.accountId) && text(i.operationId)
    && text(i.clientId) && i.clientId.length <= 64
    && ["perp", "futures"].includes(i.apiFamily)
    && ["inverse_perp", "quanto_perp"].includes(i.instrument) && text(i.pair)
    && (i.apiFamily !== "futures" || (i.instrument === "inverse_perp" && i.pair === "btc_usd"))
    && ["buy", "sell"].includes(i.side) && positiveDecimal(i.quantity) && positiveDecimal(i.leverage)
    && sats(i.reserveSats)
    && ((i.orderType === "market" && i.price === null) || (i.orderType === "limit" && positiveDecimal(i.price)));
}

export function createState(mandate: Mandate): ExecutionState {
  if (!text(mandate.accountId) || !sats(mandate.maxReservedSats)
    || !validTime(mandate.expiresAtMs) || !validTime(mandate.maxTickAgeMs)
    || !Array.isArray(mandate.markets) || mandate.markets.length === 0
    || mandate.markets.some((m) => !m || !["inverse_perp", "quanto_perp"].includes(m.instrument) || !text(m.pair))) {
    throw new Error("invalid mandate");
  }
  return { mandate: structuredClone(mandate), orders: new Map() };
}

export function reservedSats(state: ExecutionState): bigint {
  let total = 0n;
  for (const order of state.orders.values()) {
    if (!terminal(order.status)) total += BigInt(order.intent.reserveSats);
  }
  return total;
}

function changed(state: ExecutionState, record: OrderRecord): ExecutionState {
  const orders = new Map(state.orders);
  orders.set(record.intent.operationId, record);
  return { ...state, orders };
}

function gate(state: ExecutionState, intent: OrderIntent, ctx: HostContext): string | null {
  if (!validTime(ctx.nowMs) || ctx.nowMs >= state.mandate.expiresAtMs) return "mandate_expired";
  if (!ctx.capabilities.includes("trade")) return "trade_permission_missing";
  if (!state.mandate.markets.some((m) => m.instrument === intent.instrument && m.pair === intent.pair)) return "market_not_authorized";
  if (!ctx.market || ctx.market.instrument !== intent.instrument || ctx.market.pair !== intent.pair) return "market_data_mismatch";
  if (!ctx.connected || !ctx.authenticated || !ctx.subscribed || !ctx.reconciled) return "stream_not_reconciled";
  if (!validTime(ctx.lastTickMs) || ctx.lastTickMs > ctx.nowMs
    || ctx.nowMs - ctx.lastTickMs > state.mandate.maxTickAgeMs) return "tick_not_fresh";
  return null;
}

/** Decide a send; the caller persists the returned state before any transport call. */
export function prepareOrder(state: ExecutionState, intent: OrderIntent, ctx: HostContext): Decision {
  const refuse = (reason: string): Decision => ({ state, effect: "none", reason });
  if (!validIntent(intent)) return refuse("invalid_intent");
  if (intent.accountId !== state.mandate.accountId) return refuse("account_mismatch");
  const intentHash = sha256(canonical(intent));
  const prior = state.orders.get(intent.operationId);
  if (prior) {
    if (prior.intentHash !== intentHash) return refuse("operation_changed");
    if (prior.status === "reconciliation_required") {
      return ctx.capabilities.includes("read")
        ? { state, effect: "lookup", reason: "reconcile_existing_id" }
        : refuse("read_permission_missing");
    }
    if (prior.status !== "ambiguous") return refuse(terminal(prior.status) ? "operation_terminal" : "operation_already_known");
    if (intent.apiFamily === "futures") return refuse("legacy_client_id_is_only_a_tag");
    const denied = gate(state, intent, ctx);
    if (denied) return refuse(denied);
    return {
      state: changed(state, { ...prior, status: "pending", attempts: prior.attempts + 1 }),
      effect: "retry_same_id", reason: "perp_unique_id_replay",
    };
  }
  // IDs are retained after terminal states and compared across every market.
  if ([...state.orders.values()].some((o) => o.intent.clientId === intent.clientId)) return refuse("client_id_already_used");
  const denied = gate(state, intent, ctx);
  if (denied) return refuse(denied);
  if (reservedSats(state) + BigInt(intent.reserveSats) > BigInt(state.mandate.maxReservedSats)) return refuse("risk_budget_exceeded");
  return {
    state: changed(state, { intent: structuredClone(intent), intentHash, status: "pending", lastObservedStatus: null, attempts: 1, tradeId: null }),
    effect: "submit", reason: "new_approved_operation",
  };
}

function matches(intent: OrderIntent, trade: ObservedTrade): boolean {
  return trade !== null && typeof trade === "object" && text(trade.tradeId)
    && ["open", "running", "closed", "canceled"].includes(trade.status)
    && (!(trade.status === "open" || trade.status === "canceled") || intent.orderType === "limit")
    && ["accountId", "clientId", "instrument", "pair", "side", "orderType", "quantity", "leverage", "price"]
      .every((key) => intent[key as keyof OrderIntent] === trade[key as keyof ObservedTrade]);
}

/** Apply only host-observed outcomes. Model-generated tool text is not evidence. */
export function recordOutcome(state: ExecutionState, operationId: string, outcome: Outcome): Decision {
  const prior = state.orders.get(operationId);
  if (!prior) return { state, effect: "none", reason: "unknown_operation" };
  const keep = (reason: string): Decision => ({ state, effect: "none", reason });
  if (terminal(prior.status)) return keep("terminal_receipt_retained");
  if (outcome.kind === "observed") {
    if (!matches(prior.intent, outcome.trade) || (prior.tradeId !== null && prior.tradeId !== outcome.trade.tradeId)
      || [...state.orders.entries()].some(([id, order]) => id !== operationId && order.tradeId === outcome.trade.tradeId)
      || (prior.lastObservedStatus === "running" && outcome.trade.status === "canceled")) {
      return { state: changed(state, { ...prior, status: "reconciliation_required" }), effect: "none", reason: "receipt_mismatch" };
    }
    // Ignore a delayed 'open' snapshot after a running trade was observed.
    if (prior.lastObservedStatus === "running" && outcome.trade.status === "open") return keep("stale_trade_state");
    return {
      state: changed(state, { ...prior, status: outcome.trade.status, lastObservedStatus: outcome.trade.status, tradeId: outcome.trade.tradeId }),
      effect: "none", reason: "matched_trade_observed",
    };
  }
  // A late transport outcome cannot undo a matched trade receipt.
  if (prior.status === "open" || prior.status === "running") return keep("receipt_already_observed");
  if (outcome.kind === "ambiguous" && prior.status === "pending") {
    return { state: changed(state, { ...prior, status: "ambiguous" }), effect: "none", reason: "acknowledgment_unknown" };
  }
  return {
    state: changed(state, { ...prior, status: "reconciliation_required" }), effect: "none",
    reason: outcome.kind === "conflict" ? "conflict_requires_lookup" : "absence_is_inconclusive",
  };
}
