// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IL1ArbitrumExtendedGateway} from "../interfaces/IArbitrumBridge.sol";

/// @title ExitLeaf
/// @notice Rebuilds the child->parent message a token gateway emits for a withdrawal and folds it into
///         the Outbox send-tree root. Byte-for-byte mirror of nitro-contracts AbsOutbox
///         (calculateItemHash / calculateMerkleRoot / recordOutputAsSpent path checks).
library ExitLeaf {
    /// @dev Outbox rejects proofs of 256+ nodes; index must fit in the proof length (minimal path).
    uint256 internal constant MAX_PROOF_LENGTH = 255;

    error ProofTooLong(uint256 length);
    error PathNotMinimal(uint256 index, uint256 proofLength);

    /// @notice Every field that is hashed into a gateway withdrawal leaf.
    /// @dev `extraData` is always empty (child gateways enforce EXTRA_DATA_DISABLED) and the leaf's
    ///      callvalue is always 0 for non-WETH gateways, so neither is caller-controlled.
    struct Leaf {
        address childGateway;
        address parentGateway;
        address l1Token;
        address from;
        address initialDestination;
        uint256 amount;
        uint256 exitNum;
        uint256 l2Block;
        uint256 l1Block;
        uint256 l2Timestamp;
    }

    /// @notice Hash of the Outbox item for `leaf` (AbsOutbox.calculateItemHash).
    function itemHash(Leaf memory leaf) internal pure returns (bytes32) {
        bytes memory data = abi.encodeCall(
            IL1ArbitrumExtendedGateway.finalizeInboundTransfer,
            (leaf.l1Token, leaf.from, leaf.initialDestination, leaf.amount, abi.encode(leaf.exitNum, bytes("")))
        );
        return keccak256(
            abi.encodePacked(
                leaf.childGateway, leaf.parentGateway, leaf.l2Block, leaf.l1Block, leaf.l2Timestamp, uint256(0), data
            )
        );
    }

    /// @notice Send-tree root implied by `leaf` at position `index` with sibling path `proof`.
    /// @dev Reverts on non-minimal paths: MerkleLib ignores index bits above proof.length, but
    ///      Outbox.isSpent reads the full index, so a padded index would check the wrong slot.
    function computeRoot(Leaf memory leaf, bytes32[] memory proof, uint256 index) internal pure returns (bytes32) {
        return rootFromItem(itemHash(leaf), proof, index);
    }

    /// @notice Send-tree root implied by an already-hashed Outbox item (used to re-prove a stored exit).
    function rootFromItem(bytes32 item, bytes32[] memory proof, uint256 index) internal pure returns (bytes32) {
        uint256 len = proof.length;
        if (len > MAX_PROOF_LENGTH) revert ProofTooLong(len);
        if (index >> len != 0) revert PathNotMinimal(index, len);

        // Outbox hashes the item once more to mark it as a leaf.
        bytes32 h = keccak256(abi.encodePacked(item));
        for (uint256 i = 0; i < len; ++i) {
            h = (index >> i) & 1 == 0
                ? keccak256(abi.encodePacked(h, proof[i]))
                : keccak256(abi.encodePacked(proof[i], h));
        }
        return h;
    }
}
