// A batch of claims on the unique-exposure relation R_cap of paper/where_the_capital_bound_moves.md
// §4.2, as a Cairo program whose execution Stwo can prove. One claim is
//
//     ((cm, v, nf, root), (s, k, rho, pi)):  cm = Com(s),  rho in S_n via pi,  k satisfies A_rho,
//                                            v_rho >= v,  nf = PRF_k(id_rho)
//
// The program takes the witnesses and returns the statements. The statements are the public
// output of a proof of this program; a verifier compares each root with the settled-set root it
// knows and each nullifier with the registry's set. The witnesses stay in the execution trace.
//
// Instantiation, chosen for proving cost and marked as such in docs/tasks.md §8:
// - Com, PRF, the leaf, and the Merkle hash are all Poseidon over felt252, the native hash.
// - "k satisfies A_rho" is the single-signer model of the bench's registry: the authority is a key
//   image, pk = Poseidon(k), and the leaf binds (id, value, pk). The reference model in
//   vendor/spiral/model/registry.ts uses the same single-signer reading with HMAC in place of
//   Poseidon. A secp256k1 authority would run Shinigami's checker here instead; that is the
//   expensive variant, not measured in v0.
// - The nullifier is keyed by the object's key k and not by the claimant's secret s, which is the
//   point of Proposition S3.
//
// What a proof does not establish, and a verifier must check elsewhere: that `root` is the root
// of the settled set at step n (RAITO can prove that for class U), and that `nf` was not already
// in the registry.

use core::poseidon::poseidon_hash_span;

pub mod Error {
    pub const EMPTY_BATCH: felt252 = 'Batch has no claims';
    pub const OVERCLAIM: felt252 = 'Claimed value exceeds object';
    pub const PATH_DIRECTION: felt252 = 'Path direction must be 0 or 1';
}

// A settled object as the claimant knows it, and the key that satisfies its authority.
#[derive(Drop, Serde)]
pub struct Witness {
    // The claimant's identity secret; cm = Poseidon(s).
    pub s: felt252,
    // The object's authority key; pk = Poseidon(k).
    pub k: felt252,
    pub id: felt252,
    pub value: u64,
    // The value claimed, at most `value`.
    pub claimed: u64,
    // Merkle path from the leaf to the root: sibling hashes and, for each, whether the running
    // hash is the right child (1) or the left (0).
    pub siblings: Array<felt252>,
    pub directions: Array<u8>,
}

#[derive(Drop, Serde)]
pub struct Batch {
    pub claims: Array<Witness>,
}

// One statement (cm, v, nf, root) of the relation.
#[derive(Drop, Debug, PartialEq, Serde)]
pub struct Statement {
    pub cm: felt252,
    pub v: u64,
    pub nf: felt252,
    pub root: felt252,
}

fn hash2(a: felt252, b: felt252) -> felt252 {
    poseidon_hash_span(array![a, b].span())
}

fn hash3(a: felt252, b: felt252, c: felt252) -> felt252 {
    poseidon_hash_span(array![a, b, c].span())
}

// The statement of one claim, from its witness.
pub fn claim(w: Witness) -> Statement {
    assert(w.claimed <= w.value, Error::OVERCLAIM);
    let pk = hash2('pk', w.k);
    let cm = hash2('cm', w.s);
    let nf = hash3('nf', w.k, w.id);
    let mut node = hash3(w.id, w.value.into(), pk);
    let mut i: usize = 0;
    let n = w.siblings.len();
    while i < n {
        let sibling = *w.siblings.at(i);
        let direction = *w.directions.at(i);
        if direction == 0 {
            node = hash2(node, sibling);
        } else if direction == 1 {
            node = hash2(sibling, node);
        } else {
            core::panic_with_felt252(Error::PATH_DIRECTION);
        }
        i += 1;
    }
    Statement { cm, v: w.claimed, nf, root: node }
}

// The statements of a batch, in order. This is the function that gets proven.
#[executable]
pub fn main(batch: Batch) -> Array<Statement> {
    assert(batch.claims.len() > 0, Error::EMPTY_BATCH);
    let mut out: Array<Statement> = array![];
    for w in batch.claims {
        out.append(claim(w));
    }
    out
}

#[cfg(test)]
mod tests;
