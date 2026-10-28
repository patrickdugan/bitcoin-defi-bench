import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { atoms, closeout, proofEligibility, U128_MAX } from './tradelayer_zk.ts';
import type { Book, ReserveState, ProofCase, Binding } from './tradelayer_zk.ts';

const state = (): ReserveState => ({ network: 'bitcoin-regtest', asset: 'synthetic:1',
  reserve_atoms: '100000000', last_epoch: 0, used_books: [] });
const book = (): Book => ({ id: 'book-a', network: 'bitcoin-regtest', asset: 'synthetic:1', epoch: 1,
  positions: [
    { owner: 'short', margin_atoms: '25000000', pnl_atoms: '-100000000', maintenance_atoms: '1' },
    { owner: 'long', margin_atoms: '10000000', pnl_atoms: '100000000', maintenance_atoms: '1' },
  ] });
const binding = (): Binding => ({ network: 'bitcoin-regtest', asset: 'BTC', claim_id: 'synthetic:claim-a',
  recipient: 'synthetic:recipient-a', amount_atoms: '1000', unit: 'sats', anchor: 'synthetic:header-a',
  program: 'synthetic:program-a', verifier_key: 'synthetic:key-a', policy: 'synthetic:policy-a', statement: 'synthetic:statement-a' });
const proof = (): ProofCase => ({ origin: 'synthetic', required: ['tx_inclusion', 'recipient_output', 'economic_transition'],
  established: ['tx_inclusion', 'recipient_output', 'economic_transition'], expected: binding(), received: binding(),
  verification: 'synthetic_pass', dev_mode: false, canonical_at_observed_tip: true,
  now_height: 100, expires_height: 120, confirmations: 6, min_confirmations: 6, consumed_claims: [] });
function rejected(s: ReserveState, b: Book, reason: string): void {
  const before = structuredClone(s), input = structuredClone(b), r = closeout(s, b);
  assert.equal(r.admissible, false); assert.equal(r.reason, reason);
  assert.strictEqual(r.state, s); assert.deepEqual(s, before); assert.deepEqual(b, input);
  assert.equal(r.economic_authorization, false);
}

test('canonical integer strings preserve values above JS safe integer range', () => {
  assert.equal(atoms('9007199254740993'), 9007199254740993n);
  assert.equal(atoms(U128_MAX.toString()), U128_MAX);
  for (const x of [1, 1.5, '', '01', '-0', '+1', '1e3', '1.0', ' 1', '-1', (U128_MAX + 1n).toString()]) {
    assert.throws(() => atoms(x));
  }
});
test('funded source example conserves 135m atoms and pays 100m', () => {
  const s = state(), b = book(), before = structuredClone({ s, b }), r = closeout(s, b);
  assert.equal(r.admissible, true); assert.equal(r.insurance_atoms, '75000000');
  assert.equal(r.paid_atoms, '100000000'); assert.equal(r.state.reserve_atoms, '25000000');
  assert.deepEqual(r.remaining_margins, [{ owner: 'long', atoms: '110000000' }, { owner: 'short', atoms: '0' }]);
  assert.equal(BigInt(r.state.reserve_atoms) + r.remaining_margins.reduce((a, p) => a + BigInt(p.atoms), 0n), 135000000n);
  assert.deepEqual({ s, b }, before); assert.equal(r.economic_authorization, false);
});
test('preview does not reserve and commit requires the current shared reserve', () => {
  const s = state(), b = book();
  assert.deepEqual(closeout(s, b), closeout(s, b));
  const first = closeout(s, b), second = { ...b, id: 'book-b', epoch: 2 };
  rejected(first.state, second, 'insufficient_insurance');
});
test('insufficient insurance and wrong domains leave state unchanged', () => {
  rejected({ ...state(), reserve_atoms: '50000000' }, book(), 'insufficient_insurance');
  rejected(state(), { ...book(), network: 'litecoin-regtest' }, 'domain_mismatch');
  rejected(state(), { ...book(), asset: 'synthetic:2' }, 'domain_mismatch');
});
test('nonzero net PnL and ordinary healthy positions reject', () => {
  const b = book(); b.positions[1].pnl_atoms = '99999999'; rejected(state(), b, 'unbalanced_pnl');
  const healthy = book(); healthy.positions[0].margin_atoms = '200000000';
  rejected(state(), healthy, 'no_distress');
});
test('duplicate owner, replay and stale epoch reject', () => {
  const b = book(); b.positions[1].owner = 'short'; rejected(state(), b, 'duplicate_or_invalid_owner');
  const first = closeout(state(), book()); rejected(first.state, book(), 'replay');
  rejected(first.state, { ...book(), id: 'new-book' }, 'stale_epoch');
});
test('overflow and malformed integers reject before commit', () => {
  const b = book(); b.positions[1].margin_atoms = U128_MAX.toString(); rejected(state(), b, 'overflow');
  const malformed = book(); malformed.positions[0].margin_atoms = '1.2';
  rejected(state(), malformed, 'noncanonical_atoms');
});
test('permutation does not change canonical closeout output', () => {
  const b = book(); b.positions.reverse(); assert.deepEqual(closeout(state(), b), closeout(state(), book()));
});
test('empty, malformed and duplicate history reject', () => {
  rejected(state(), { ...book(), positions: [] }, 'malformed');
  rejected({ ...state(), used_books: ['a', 'a'] }, book(), 'malformed');
  rejected(state(), { ...book(), epoch: 1.5 }, 'malformed');
});
test('a synthetic eligible proof fixture still authorizes no economic action', () => {
  assert.deepEqual(proofEligibility(proof()), { admissible: true, reason: 'synthetic_eligible', economic_authorization: false });
});
test('metadata, isolated PoW, inclusion and batch binding cannot substitute for transition execution', () => {
  for (const established of [[], ['isolated_pow'], ['batch_binding'], ['tx_inclusion', 'recipient_output']]) {
    const p = proof(); p.established = established as ProofCase['established'];
    assert.equal(proofEligibility(p).reason, 'scope_gap');
  }
});
test('every binding field is checked, including key/program, network, units and recipient', () => {
  for (const k of Object.keys(binding()) as (keyof Binding)[]) {
    const p = proof(); p.received[k] = k === 'amount_atoms' ? '1001' : `${p.received[k]}-other`;
    assert.equal(proofEligibility(p).reason, 'binding_mismatch', k);
  }
});
test('failed, unverified and dev-mode proof fixtures reject', () => {
  for (const verification of ['synthetic_fail', 'unverified'] as const) {
    assert.equal(proofEligibility({ ...proof(), verification }).reason, 'unverified');
  }
  assert.equal(proofEligibility({ ...proof(), dev_mode: true }).reason, 'unverified');
});
test('reorg, expiry boundary, confirmations and replay are independent gates', () => {
  assert.equal(proofEligibility({ ...proof(), canonical_at_observed_tip: false }).reason, 'reorg_or_unknown_chain');
  assert.equal(proofEligibility({ ...proof(), now_height: 120 }).reason, 'expired');
  assert.equal(proofEligibility({ ...proof(), confirmations: 5 }).reason, 'insufficient_confirmations');
  assert.equal(proofEligibility({ ...proof(), consumed_claims: ['synthetic:claim-a'] }).reason, 'replay');
});
test('unknown or duplicated scope, empty policy, malformed amount and extra binding fields reject', () => {
  const cases = [proof(), proof(), proof(), proof(), proof(), proof()];
  cases[0].required = []; cases[1].established.push('batch_binding', 'batch_binding');
  cases[2].established = ['all'] as unknown as ProofCase['established'];
  cases[3].received.amount_atoms = '01'; cases[4].expected.policy = '';
  Object.assign(cases[5].received, { bypass: true });
  for (const p of cases) assert.equal(proofEligibility(p).reason, 'malformed');
});
test('live evidence objects cannot enter the synthetic evaluator', () => {
  assert.equal(proofEligibility({ ...proof(), origin: 'live' } as unknown as ProofCase).reason, 'malformed');
});
test('eight development seeds conserve exact balances and catch reused insurance', () => {
  for (let seed = 0; seed < 8; seed++) {
    const h = createHash('sha256').update(`bitcoin-defi-bench/expansion-v1|development|${seed}|amount`).digest();
    const scale = BigInt(h.readUInt32BE(0) % 1000 + 1), s = state(), b = book();
    s.reserve_atoms = (100n * scale).toString();
    b.positions[0].margin_atoms = (25n * scale).toString(); b.positions[0].pnl_atoms = (-100n * scale).toString();
    b.positions[1].margin_atoms = (10n * scale).toString(); b.positions[1].pnl_atoms = (100n * scale).toString();
    const r = closeout(s, b); assert.equal(r.admissible, true);
    assert.equal(r.insurance_atoms, (75n * scale).toString());
    assert.equal(BigInt(r.state.reserve_atoms) + r.remaining_margins.reduce((a, p) => a + BigInt(p.atoms), 0n), 135n * scale);
    rejected(r.state, { ...b, id: 'next-book', epoch: 2 }, 'insufficient_insurance');
  }
});
