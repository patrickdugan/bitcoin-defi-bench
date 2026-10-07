use core::poseidon::poseidon_hash_span;
use super::{Batch, Statement, Witness, claim, main};

fn h2(a: felt252, b: felt252) -> felt252 {
    poseidon_hash_span(array![a, b].span())
}

fn h3(a: felt252, b: felt252, c: felt252) -> felt252 {
    poseidon_hash_span(array![a, b, c].span())
}

fn witness(s: felt252, k: felt252, id: felt252, value: u64, claimed: u64, siblings: Array<felt252>, directions: Array<u8>) -> Witness {
    Witness { s, k, id, value, claimed, siblings, directions }
}

#[test]
fn single_leaf_tree_has_the_leaf_as_root() {
    let st = claim(witness(11, 22, 33, 1000, 1000, array![], array![]));
    let pk = h2('pk', 22);
    assert_eq!(st.cm, h2('cm', 11));
    assert_eq!(st.nf, h3('nf', 22, 33));
    assert_eq!(st.v, 1000);
    assert_eq!(st.root, h3(33, 1000, pk));
}

#[test]
fn merkle_path_follows_directions() {
    // Leaf on the left, sibling on the right; then the pair on the right under a second sibling.
    let leaf = h3(33, 1000, h2('pk', 22));
    let st = claim(witness(11, 22, 33, 1000, 400, array![7, 8], array![0, 1]));
    assert_eq!(st.root, h2(8, h2(leaf, 7)));
    assert_eq!(st.v, 400);
}

#[test]
fn nullifier_depends_on_the_object_key_not_the_claimant_secret() {
    let a = claim(witness(11, 22, 33, 1000, 1000, array![], array![]));
    let b = claim(witness(99, 22, 33, 1000, 1000, array![], array![]));
    assert_eq!(a.nf, b.nf);
    assert!(a.cm != b.cm);
    let c = claim(witness(11, 23, 33, 1000, 1000, array![], array![]));
    assert!(a.nf != c.nf);
}

#[test]
#[should_panic(expected: 'Claimed value exceeds object')]
fn overclaim_panics() {
    claim(witness(11, 22, 33, 1000, 1001, array![], array![]));
}

#[test]
#[should_panic(expected: 'Batch has no claims')]
fn empty_batch_panics() {
    main(Batch { claims: array![] });
}

#[test]
fn batch_returns_one_statement_per_claim_in_order() {
    let out: Array<Statement> = main(Batch { claims: array![
        witness(1, 2, 3, 10, 10, array![], array![]),
        witness(4, 5, 6, 20, 5, array![9], array![1]),
    ] });
    assert_eq!(out.len(), 2);
    assert_eq!(*out.at(0).v, 10);
    assert_eq!(*out.at(1).v, 5);
    assert_eq!(*out.at(1).root, h2(9, h3(6, 20, h2('pk', 5))));
}
