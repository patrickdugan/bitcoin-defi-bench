import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createState, prepareOrder, recordOutcome, reservedSats,
  type ExecutionState, type HostContext, type ObservedTrade, type OrderIntent, type TradeStatus,
} from "./contract.ts";

const order = (overrides: Partial<OrderIntent> = {}): OrderIntent => ({
  kind: "isolated_order", accountId: "synthetic-account", operationId: "operation-1",
  apiFamily: "perp", clientId: "synthetic-order-1", instrument: "inverse_perp", pair: "btc_usd",
  side: "buy", orderType: "limit", quantity: "10", leverage: "2", price: "100000", reserveSats: "5000",
  ...overrides,
});
const context = (overrides: Partial<HostContext> = {}): HostContext => ({
  nowMs: 1000, market: { instrument: "inverse_perp", pair: "btc_usd" },
  capabilities: ["read", "trade"], connected: true, authenticated: true,
  subscribed: true, reconciled: true, lastTickMs: 950, ...overrides,
});
const initial = (budget = "10000"): ExecutionState => createState({
  accountId: "synthetic-account", maxReservedSats: budget, expiresAtMs: 10000, maxTickAgeMs: 100,
  markets: [{ instrument: "inverse_perp", pair: "btc_usd" }, { instrument: "quanto_perp", pair: "xau_usdt" }],
});
const observed = (intent = order(), overrides: Partial<ObservedTrade> = {}): ObservedTrade => ({
  accountId: intent.accountId, clientId: intent.clientId, tradeId: "synthetic-trade-1",
  instrument: intent.instrument, pair: intent.pair, side: intent.side, orderType: intent.orderType,
  quantity: intent.quantity, leverage: intent.leverage, price: intent.price, status: "open", ...overrides,
});
const submit = (state = initial(), intent = order()): ExecutionState => {
  const d = prepareOrder(state, intent, context());
  assert.equal(d.effect, "submit");
  return d.state;
};
const loseAck = (state = submit()): ExecutionState => recordOutcome(state, "operation-1", { kind: "ambiguous" }).state;

// Independent synthetic venue. It models only the documented clientId rules.
// There is no shared reducer, gate, hash, network transport, or real price data.
class SyntheticVenue {
  trades: ObservedTrade[] = [];
  post(intent: OrderIntent): { code: 200; trade: ObservedTrade } | { code: 409 } {
    if (intent.apiFamily === "perp" && this.trades.some((t) => t.accountId === intent.accountId && t.clientId === intent.clientId)) return { code: 409 };
    const trade = observed(intent, { tradeId: `synthetic-trade-${this.trades.length + 1}` });
    this.trades.push(trade);
    return { code: 200, trade };
  }
  get(accountId: string, clientId: string): ObservedTrade | undefined {
    return this.trades.find((t) => t.accountId === accountId && t.clientId === clientId);
  }
}

test("commit then lost acknowledgment: exact /perp replay creates one trade; 409 requires lookup", () => {
  const venue = new SyntheticVenue();
  const intent = order();
  let state = submit();
  assert.equal(venue.post(intent).code, 200); // committed, but acknowledgment is dropped
  state = loseAck(state);
  assert.equal(reservedSats(state), 5000n);
  const retry = prepareOrder(state, intent, context());
  assert.equal(retry.effect, "retry_same_id");
  assert.equal(retry.state.orders.get(intent.operationId)!.attempts, 2);
  assert.equal(venue.post(intent).code, 409);
  state = recordOutcome(retry.state, intent.operationId, { kind: "conflict" }).state;
  assert.equal(state.orders.get(intent.operationId)!.status, "reconciliation_required");
  assert.equal(state.orders.get(intent.operationId)!.tradeId, null);
  assert.equal(prepareOrder(state, intent, context()).effect, "lookup");
  state = recordOutcome(state, intent.operationId, { kind: "observed", trade: venue.get(intent.accountId, intent.clientId)! }).state;
  assert.equal(state.orders.get(intent.operationId)!.status, "open");
  assert.equal(venue.trades.length, 1);
  assert.equal(reservedSats(state), 5000n); // still resting, rather than counted as filled
});

test("lost request before venue commit can safely use the same /perp ID", () => {
  const venue = new SyntheticVenue();
  const d = prepareOrder(loseAck(), order(), context());
  assert.equal(d.effect, "retry_same_id");
  const reply = venue.post(order());
  assert.equal(reply.code, 200);
  assert.equal(venue.trades.length, 1);
});

test("a fresh ID or altered effects cannot retry an ambiguous operation", () => {
  const state = loseAck();
  for (const change of [{ clientId: "new-id" }, { quantity: "11" }, { leverage: "3" }, { price: "99999" },
    { side: "sell" as const }, { pair: "xau_usdt", instrument: "quanto_perp" as const }, { reserveSats: "1" }, { apiFamily: "futures" as const }]) {
    const d = prepareOrder(state, order(change), context());
    assert.equal(d.effect, "none");
    assert.equal(d.reason, "operation_changed");
    assert.equal(d.state, state);
  }
});

test("legacy /futures tags demonstrate duplication; the policy refuses automatic replay", () => {
  const intent = order({ apiFamily: "futures" });
  const venue = new SyntheticVenue();
  const state = loseAck(submit(initial(), intent));
  assert.equal(venue.post(intent).code, 200);
  const d = prepareOrder(state, intent, context());
  assert.equal(d.effect, "none");
  assert.equal(d.reason, "legacy_client_id_is_only_a_tag");
  assert.equal(reservedSats(d.state), 5000n);
  assert.equal(venue.post(intent).code, 200); // unsafe counterfactual; policy did not send it
  assert.equal(venue.trades.length, 2);
});

test("clientId remains used across terminal states and markets", () => {
  for (const status of ["closed", "canceled"] as const) {
    const venue = new SyntheticVenue();
    venue.post(order());
    venue.trades[0]!.status = status;
    const state = recordOutcome(submit(), "operation-1", { kind: "observed", trade: venue.trades[0]! }).state;
    assert.equal(reservedSats(state), 0n);
    const otherMarket = order({ operationId: "operation-2", instrument: "quanto_perp", pair: "xau_usdt" });
    assert.equal(venue.post(otherMarket).code, 409);
    assert.equal(prepareOrder(state, otherMarket, context()).reason, "client_id_already_used");
    assert.equal(prepareOrder(state, order(), context()).reason, "operation_terminal");
  }
});

test("a conflicting trade with changed account, market, side, size, price, or ID stays unresolved", () => {
  const conflict = recordOutcome(submit(), "operation-1", { kind: "conflict" }).state;
  for (const change of [{ accountId: "other" }, { clientId: "other" }, { side: "sell" as const }, { quantity: "11" },
    { leverage: "3" }, { pair: "xau_usdt" }, { price: "99999" }, { tradeId: "" }, { status: "filled" as TradeStatus }]) {
    const d = recordOutcome(conflict, "operation-1", { kind: "observed", trade: observed(order(), change) });
    assert.equal(d.reason, "receipt_mismatch");
    assert.equal(d.state.orders.get("operation-1")!.status, "reconciliation_required");
    assert.equal(reservedSats(d.state), 5000n);
  }
});

test("404-style lookup miss keeps the reservation and requires further reconciliation", () => {
  const state = recordOutcome(loseAck(), "operation-1", { kind: "not_found" }).state;
  assert.equal(reservedSats(state), 5000n);
  assert.equal(prepareOrder(state, order(), context()).effect, "lookup");
  assert.equal(prepareOrder(state, order(), context({ capabilities: ["trade"] })).reason, "read_permission_missing");
});

test("pending and ambiguous orders consume the cumulative budget, including exact large integer sats", () => {
  const budget = "9007199254740993";
  const state = submit(initial(budget), order({ reserveSats: budget }));
  assert.equal(reservedSats(state), 9007199254740993n);
  for (const s of [state, loseAck(state)]) {
    const d = prepareOrder(s, order({ operationId: "operation-2", clientId: "id-2", reserveSats: "1" }), context());
    assert.equal(d.reason, "risk_budget_exceeded");
  }
});

test("permission revocation and expiry are checked again before a same-ID replay", () => {
  const state = loseAck();
  for (const capabilities of [[], ["read"], ["withdraw"]] as HostContext["capabilities"][]) {
    assert.equal(prepareOrder(state, order(), context({ capabilities })).reason, "trade_permission_missing");
  }
  assert.equal(prepareOrder(state, order(), context({ nowMs: 10000 })).reason, "mandate_expired");
  assert.equal(state.orders.get("operation-1")!.attempts, 1);
});

test("a trade capability cannot turn the order tool into a withdrawal", () => {
  const request = { ...order(), kind: "withdraw" } as unknown as OrderIntent;
  assert.equal(prepareOrder(initial(), request, context({ capabilities: ["read", "trade", "withdraw"] })).reason, "invalid_intent");
  assert.equal(prepareOrder(initial(), order(), context({ capabilities: ["withdraw"] })).reason, "trade_permission_missing");
});

test("a reconnect requires authentication, subscriptions, and host reconciliation before new risk", () => {
  for (const field of ["connected", "authenticated", "subscribed", "reconciled"] as const) {
    const d = prepareOrder(initial(), order(), context({ [field]: false }));
    assert.equal(d.reason, "stream_not_reconciled");
    assert.equal(d.state.orders.size, 0);
  }
  assert.equal(prepareOrder(initial(), order(), context()).effect, "submit");
});

test("missing, stale, future, and non-finite market timestamps block new orders and retries", () => {
  for (const lastTickMs of [null, 899, 1001, NaN, Infinity]) {
    for (const state of [initial(), loseAck()]) {
      assert.equal(prepareOrder(state, order(), context({ lastTickMs })).reason, "tick_not_fresh");
    }
  }
  assert.equal(prepareOrder(initial(), order(), context({ lastTickMs: 900 })).effect, "submit");
});

test("fresh data for another market and markets outside the mandate cannot authorize an order", () => {
  const gold = order({ instrument: "quanto_perp", pair: "xau_usdt" });
  assert.equal(prepareOrder(initial(), gold, context()).reason, "market_data_mismatch");
  assert.equal(prepareOrder(initial(), gold, context({ market: { instrument: "quanto_perp", pair: "xau_usdt" } })).effect, "submit");
  const unknown = order({ pair: "synthetic_unsupported" });
  assert.equal(prepareOrder(initial(), unknown, context({ market: { instrument: "inverse_perp", pair: unknown.pair } })).reason, "market_not_authorized");
});

test("unknown fields and malformed numeric effects fail before any state or reservation is added", () => {
  for (const change of [{ quantity: "1e3" }, { quantity: "1.0" }, { quantity: "0" }, { leverage: "-2" },
    { reserveSats: "5.5" }, { reserveSats: "05000" }, { clientId: "x".repeat(65) }, { price: null },
    { side: "hold" }, { extra: "withdraw funds" }]) {
    const d = prepareOrder(initial(), { ...order(), ...change } as OrderIntent, context());
    assert.equal(d.reason, "invalid_intent");
    assert.equal(d.state.orders.size, 0);
  }
  assert.equal(prepareOrder(initial(), order({ accountId: "other" }), context()).reason, "account_mismatch");
});

test("one pending attempt cannot trigger a concurrent send and copied intent resists caller mutation", () => {
  const intent = order();
  const state = submit(initial(), intent);
  intent.quantity = "999";
  assert.equal(state.orders.get(intent.operationId)!.intent.quantity, "10");
  assert.equal(prepareOrder(state, order(), context()).reason, "operation_already_known");
  assert.equal(state.orders.get(intent.operationId)!.attempts, 1);
});

test("matched receipts survive late transport errors and terminal receipts resist stale reopen", () => {
  let state = recordOutcome(submit(), "operation-1", { kind: "observed", trade: observed(order(), { status: "running" }) }).state;
  assert.equal(recordOutcome(state, "operation-1", { kind: "ambiguous" }).state, state);
  assert.equal(recordOutcome(state, "operation-1", { kind: "observed", trade: observed() }).reason, "stale_trade_state");
  state = recordOutcome(state, "operation-1", { kind: "observed", trade: observed(order(), { status: "closed" }) }).state;
  assert.equal(reservedSats(state), 0n);
  assert.equal(recordOutcome(state, "operation-1", { kind: "observed", trade: observed() }).state, state);
});

test("a different trade ID or an impossible cancellation cannot release a running reservation", () => {
  const state = recordOutcome(submit(), "operation-1", { kind: "observed", trade: observed(order(), { status: "running" }) }).state;
  for (const change of [{ tradeId: "different", status: "closed" as const }, { status: "canceled" as const }]) {
    const d = recordOutcome(state, "operation-1", { kind: "observed", trade: observed(order(), change) });
    assert.equal(d.reason, "receipt_mismatch");
    assert.equal(reservedSats(d.state), 5000n);
  }
});

test("reconciliation preserves observed progress after a malformed receipt", () => {
  let state = recordOutcome(submit(), "operation-1", { kind: "observed", trade: observed(order(), { status: "running" }) }).state;
  state = recordOutcome(state, "operation-1", { kind: "observed", trade: observed(order(), { tradeId: "wrong" }) }).state;
  assert.equal(state.orders.get("operation-1")!.status, "reconciliation_required");
  assert.equal(state.orders.get("operation-1")!.lastObservedStatus, "running");
  for (const status of ["open", "canceled"] as const) {
    const d = recordOutcome(state, "operation-1", { kind: "observed", trade: observed(order(), { status }) });
    assert.equal(d.state.orders.get("operation-1")!.status, "reconciliation_required");
    assert.equal(reservedSats(d.state), 5000n);
  }
  const closed = recordOutcome(state, "operation-1", { kind: "observed", trade: observed(order(), { status: "closed" }) });
  assert.equal(reservedSats(closed.state), 0n);
});

test("venue trade identity cannot be assigned to two client operations", () => {
  let state = recordOutcome(submit(), "operation-1", { kind: "observed", trade: observed() }).state;
  const other = order({ operationId: "operation-2", clientId: "id-2" });
  state = submit(state, other);
  const d = recordOutcome(state, "operation-2", { kind: "observed", trade: observed(other) });
  assert.equal(d.reason, "receipt_mismatch");
  assert.equal(reservedSats(d.state), 10000n);
});

test("market orders require normalization of instruction price and valid terminal state", () => {
  const intent = order({ orderType: "market", price: null });
  const state = submit(initial(), intent);
  assert.equal(recordOutcome(state, intent.operationId, { kind: "observed", trade: observed(intent) }).reason, "receipt_mismatch");
  const d = recordOutcome(state, intent.operationId, { kind: "observed", trade: observed(intent, { status: "running" }) });
  assert.equal(d.reason, "matched_trade_observed");
});
