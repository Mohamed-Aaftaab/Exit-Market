//! # ExitProof (Arbitrum Stylus)
//!
//! Rust port of Exit Market's Outbox proof core (`contracts/libraries/ExitLeaf.sol`):
//! rebuilds the Outbox item a token gateway emits for a withdrawal and folds its merkle proof into the
//! send-tree root, with the same minimal-path rules as nitro's `AbsOutbox`.
//!
//! ABI-equivalent to Solidity, so ExitMarket (or anyone) can call it. Stateless.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#![cfg_attr(not(any(test, feature = "export-abi")), no_std)]

#[macro_use]
extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::{Address, Bytes, FixedBytes, U256};
use alloy_sol_types::{sol, SolCall, SolValue};
use stylus_sdk::{crypto::keccak, prelude::*};

/// Outbox rejects proofs of 256+ nodes; the index must fit in the proof length (minimal path).
const MAX_PROOF_LENGTH: usize = 255;

sol! {
    function finalizeInboundTransfer(address token, address from, address to, uint256 amount, bytes data);

    error ProofTooLong(uint256 length);
    error PathNotMinimal(uint256 index, uint256 proofLength);
}

#[derive(SolidityError)]
pub enum ExitProofError {
    ProofTooLong(ProofTooLong),
    PathNotMinimal(PathNotMinimal),
}

sol_storage! {
    #[entrypoint]
    pub struct ExitProof {}
}

/// Outbox item hash of a gateway withdrawal (AbsOutbox.calculateItemHash).
pub fn compute_item_hash(
    child_gateway: Address,
    parent_gateway: Address,
    l1_token: Address,
    from: Address,
    to: Address,
    amount: U256,
    exit_num: U256,
    l2_block: U256,
    l1_block: U256,
    l2_timestamp: U256,
    value: U256,
) -> FixedBytes<32> {
    // abi.encode(exitNum, bytes("")) — child gateways enforce empty extra data.
    let gateway_msg = (exit_num, Bytes::new()).abi_encode_params();
    let data = finalizeInboundTransferCall {
        token: l1_token,
        from,
        to,
        amount,
        data: gateway_msg.into(),
    }
    .abi_encode();

    let mut packed = Vec::with_capacity(20 + 20 + 32 * 4 + data.len());
    packed.extend_from_slice(child_gateway.as_slice());
    packed.extend_from_slice(parent_gateway.as_slice());
    for word in [l2_block, l1_block, l2_timestamp, value] {
        packed.extend_from_slice(&word.to_be_bytes::<32>());
    }
    packed.extend_from_slice(&data);
    keccak(&packed)
}

/// Send-tree root implied by `item` at `index` with sibling path `proof` (AbsOutbox.calculateMerkleRoot).
pub fn compute_root(
    item: FixedBytes<32>,
    proof: &[FixedBytes<32>],
    index: U256,
) -> Result<FixedBytes<32>, ExitProofError> {
    let len = proof.len();
    if len > MAX_PROOF_LENGTH {
        return Err(ExitProofError::ProofTooLong(ProofTooLong { length: U256::from(len) }));
    }
    if (index >> len) != U256::ZERO {
        return Err(ExitProofError::PathNotMinimal(PathNotMinimal { index, proofLength: U256::from(len) }));
    }

    // The Outbox hashes the item once more to mark it as a leaf.
    let mut h = keccak(item.as_slice());
    let mut pair = [0u8; 64];
    for (i, node) in proof.iter().enumerate() {
        if index.bit(i) {
            pair[..32].copy_from_slice(node.as_slice());
            pair[32..].copy_from_slice(h.as_slice());
        } else {
            pair[..32].copy_from_slice(h.as_slice());
            pair[32..].copy_from_slice(node.as_slice());
        }
        h = keccak(pair);
    }
    Ok(h)
}

#[public]
impl ExitProof {
    /// Outbox item hash of a gateway withdrawal (value 0 for standard/custom gateways, amount for WETH).
    #[allow(clippy::too_many_arguments)]
    pub fn item_hash(
        &self,
        child_gateway: Address,
        parent_gateway: Address,
        l1_token: Address,
        from: Address,
        to: Address,
        amount: U256,
        exit_num: U256,
        l2_block: U256,
        l1_block: U256,
        l2_timestamp: U256,
        value: U256,
    ) -> FixedBytes<32> {
        compute_item_hash(
            child_gateway, parent_gateway, l1_token, from, to, amount, exit_num, l2_block, l1_block,
            l2_timestamp, value,
        )
    }

    /// Send-tree root for `item` at `index` with `proof`; reverts on non-minimal paths.
    pub fn root_from_item(
        &self,
        item: FixedBytes<32>,
        proof: Vec<FixedBytes<32>>,
        index: U256,
    ) -> Result<FixedBytes<32>, ExitProofError> {
        compute_root(item, &proof, index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, b256};

    // Real withdrawal on Xai Testnet (exit #3, outbox index 72), verified against the live Outbox and
    // rollup node 61781 on Arbitrum Sepolia; same golden vector as contracts/test/ExitLeaf.t.sol.
    fn real_item() -> FixedBytes<32> {
        compute_item_hash(
            address!("D840761a09609394FaFA3404bEEAb312059AC558"),
            address!("CcB451C4Df22addCFe1447c58bC6b2f264Bb1256"),
            address!("67e197D575e7A350Ff3dE1A7eAd2aA06b19145B6"),
            address!("2cd28Cda6825C4967372478E87D004637B73F996"),
            address!("2cd28Cda6825C4967372478E87D004637B73F996"),
            U256::from(1_000_000_000_000_000u64),
            U256::from(3u64),
            U256::from(14_217_403u64),
            U256::from(9_173_964u64),
            U256::from(1_757_504_867u64),
            U256::ZERO,
        )
    }

    fn real_proof() -> Vec<FixedBytes<32>> {
        vec![
            b256!("6e2f997569dd82bdb30c0ce25af0633f7331c580d4b6aaf1cd8904f3b4c7113a"),
            b256!("cebc5eda66a599bf0568aae47dde4cefb5f543fbca405016aa3c1490490a2973"),
            FixedBytes::ZERO,
            b256!("3a2d5e8fcce99f0fd08bd609d1303903ab54e9ddfa2730834e14562f11b17dac"),
            FixedBytes::ZERO,
            FixedBytes::ZERO,
            b256!("2355f193840f04fc94aed433f911e03a9935a907db640130efbaf69442f7ddd6"),
        ]
    }

    const REAL_SEND_ROOT: FixedBytes<32> =
        b256!("d8a1c3386ad861c9533e67e76d0f3e403adb04a819775a7ec0ca2404c462b583");

    #[test]
    fn real_xai_withdrawal_reproduces_live_send_root() {
        let root = compute_root(real_item(), &real_proof(), U256::from(72u64)).ok().unwrap();
        assert_eq!(root, REAL_SEND_ROOT);
    }

    #[test]
    fn tampered_index_changes_root() {
        let root = compute_root(real_item(), &real_proof(), U256::from(73u64)).ok().unwrap();
        assert_ne!(root, REAL_SEND_ROOT);
    }

    #[test]
    fn padded_index_is_rejected() {
        let padded = U256::from(72u64 + (1u64 << 7));
        assert!(matches!(
            compute_root(real_item(), &real_proof(), padded),
            Err(ExitProofError::PathNotMinimal(_))
        ));
    }

    #[test]
    fn proof_of_256_nodes_is_rejected() {
        let proof = vec![FixedBytes::<32>::ZERO; 256];
        assert!(matches!(
            compute_root(real_item(), &proof, U256::ZERO),
            Err(ExitProofError::ProofTooLong(_))
        ));
    }
}
