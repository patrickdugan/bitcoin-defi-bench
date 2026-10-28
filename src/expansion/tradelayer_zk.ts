/** Experimental, synthetic-only contracts. Never authorizes funds or verifies a proof.
 * Pinned source mapping and limits: docs/expansion-tradelayer-zk.md.
 * Integer strings keep JSON lossless. No imports, network access or dependencies.
 */
export const U128_MAX = (1n << 128n) - 1n;
export function atoms(value: unknown, signed = false): bigint {
  if (typeof value !== 'string' || value.length > 40 ||
      !(signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value)) {
    throw new Error('noncanonical_atoms');
  }
  const n = BigInt(value);
  if (n > U128_MAX || n < -U128_MAX) throw new Error('overflow');
  return n;
}
function add(a: bigint, b: bigint): bigint {
  const n = a + b;
  if (n > U128_MAX || n < -U128_MAX) throw new Error('overflow');
  return n;
}
function identifier(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_:.\/-]{1,128}$/.test(s);
}
function height(n: unknown): n is number {
  return Number.isSafeInteger(n) && Number(n) >= 0;
}
export interface Position {
  owner: string; margin_atoms: string; pnl_atoms: string; maintenance_atoms: string;
}
export interface Book {
  id: string; network: string; asset: string; epoch: number; positions: Position[];
}
export interface ReserveState {
  network: string; asset: string; reserve_atoms: string; last_epoch: number;
  used_books: string[];
}
export interface CloseoutResult {
  admissible: boolean; reason: string; economic_authorization: false;
  state: ReserveState; insurance_atoms: string; paid_atoms: string;
  remaining_margins: { owner: string; atoms: string }[];
}
/** Recompute at commit time; calling this preview never mutates/reserves anything.
 * Input marks, distress and ownership are caller-supplied simulation assumptions.
 * Signed PnL uses a symmetric +/-U128 bound here; Rust's actual mark math is separate.
 */
export function closeout(state: ReserveState, book: Book): CloseoutResult {
  const reject = (reason: string): CloseoutResult => ({
    admissible: false, reason, economic_authorization: false, state,
    insurance_atoms: '0', paid_atoms: '0', remaining_margins: [],
  });
  try {
    const reserve = atoms(state.reserve_atoms);
    if (![state.network, state.asset, book.id, book.network, book.asset].every(identifier) ||
        !height(state.last_epoch) || !height(book.epoch) ||
        !Array.isArray(state.used_books) || !state.used_books.every(identifier) ||
        new Set(state.used_books).size !== state.used_books.length ||
        !Array.isArray(book.positions) || book.positions.length < 2 || book.positions.length > 256) {
      return reject('malformed');
    }
    if (book.network !== state.network || book.asset !== state.asset) return reject('domain_mismatch');
    if (state.used_books.includes(book.id)) return reject('replay');
    if (book.epoch <= state.last_epoch) return reject('stale_epoch');
    let net = 0n, need = 0n, paid = 0n, debit = 0n, before = reserve, after = 0n;
    let distressed = false;
    const seen = new Set<string>();
    const margins: { owner: string; atoms: string }[] = [];
    // Canonical ordering also fixes checked-arithmetic behavior under permutation.
    const positions = [...book.positions].sort((a, b) => a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0);
    for (const p of positions) {
      if (!identifier(p.owner) || seen.has(p.owner)) return reject('duplicate_or_invalid_owner');
      seen.add(p.owner);
      const margin = atoms(p.margin_atoms), pnl = atoms(p.pnl_atoms, true), maintenance = atoms(p.maintenance_atoms);
      net = add(net, pnl); before = add(before, margin);
      if (add(margin, pnl) < maintenance) distressed = true;
      let remaining = margin;
      if (pnl < 0n) {
        const loss = -pnl, charge = loss < margin ? loss : margin;
        debit = add(debit, charge); need = add(need, loss - charge); remaining -= charge;
      } else {
        paid = add(paid, pnl); remaining = add(remaining, pnl);
      }
      after = add(after, remaining); margins.push({ owner: p.owner, atoms: remaining.toString() });
    }
    if (net !== 0n || add(debit, need) !== paid) return reject('unbalanced_pnl');
    if (!distressed) return reject('no_distress');
    if (need > reserve) return reject('insufficient_insurance');
    if (add(after, reserve - need) !== before) return reject('conservation');
    return {
      admissible: true, reason: 'synthetic_closeout', economic_authorization: false,
      state: { ...state, reserve_atoms: (reserve - need).toString(), last_epoch: book.epoch,
        used_books: [...state.used_books, book.id].sort() },
      insurance_atoms: need.toString(), paid_atoms: paid.toString(), remaining_margins: margins,
    };
  } catch (error) {
    return reject(error instanceof Error ? error.message : 'malformed');
  }
}

export const SCOPES = ['isolated_pow', 'tx_inclusion', 'recipient_output', 'batch_binding', 'economic_transition'] as const;
export type Scope = typeof SCOPES[number];
export interface Binding {
  network: string; asset: string; claim_id: string; recipient: string; amount_atoms: string;
  unit: string; anchor: string; program: string; verifier_key: string; policy: string; statement: string;
}
export interface ProofCase {
  origin: 'synthetic'; required: Scope[]; established: Scope[];
  expected: Binding; received: Binding;
  verification: 'synthetic_pass' | 'synthetic_fail' | 'unverified';
  dev_mode: boolean; canonical_at_observed_tip: boolean;
  now_height: number; expires_height: number; confirmations: number; min_confirmations: number;
  consumed_claims: string[];
}
const BINDING_KEYS = ['network', 'asset', 'claim_id', 'recipient', 'amount_atoms', 'unit',
  'anchor', 'program', 'verifier_key', 'policy', 'statement'] as const;
function validBinding(b: Binding): boolean {
  return b !== null && typeof b === 'object' &&
    Object.keys(b).length === BINDING_KEYS.length && BINDING_KEYS.every(k =>
      Object.hasOwn(b, k) && (k === 'amount_atoms' ? atoms(b[k]) > 0n : identifier(b[k])));
}
/** Checks stipulations of a synthetic fixture, NOT untrusted proof/receipt metadata.
 * 'synthetic_pass' and established scopes are supplied by the test generator.
 * A future real adapter must derive them from pinned verifiers outside agent control.
 * Capabilities form a set: batch binding never implies economic execution.
 */
export function proofEligibility(c: ProofCase): {
  admissible: boolean; reason: string; economic_authorization: false;
} {
  const result = (reason: string) => ({ admissible: reason === 'synthetic_eligible', reason,
    economic_authorization: false as const });
  try {
    if (c.origin !== 'synthetic' || !validBinding(c.expected) || !validBinding(c.received) ||
        !Array.isArray(c.required) || c.required.length === 0 || !Array.isArray(c.established) ||
        ![...c.required, ...c.established].every(x => SCOPES.includes(x)) ||
        new Set(c.required).size !== c.required.length || new Set(c.established).size !== c.established.length ||
        ![c.now_height, c.expires_height, c.confirmations, c.min_confirmations].every(height) ||
        !Array.isArray(c.consumed_claims) || !c.consumed_claims.every(identifier)) return result('malformed');
    if (c.verification !== 'synthetic_pass' || c.dev_mode !== false) return result('unverified');
    if (!BINDING_KEYS.every(k => c.expected[k] === c.received[k])) return result('binding_mismatch');
    if (!c.required.every(scope => c.established.includes(scope))) return result('scope_gap');
    if (c.canonical_at_observed_tip !== true) return result('reorg_or_unknown_chain');
    if (c.now_height >= c.expires_height) return result('expired');
    if (c.confirmations < c.min_confirmations) return result('insufficient_confirmations');
    if (c.consumed_claims.includes(c.expected.claim_id)) return result('replay');
    return result('synthetic_eligible');
  } catch { return result('malformed'); }
}
