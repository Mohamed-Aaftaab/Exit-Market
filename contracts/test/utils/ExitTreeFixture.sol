// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitLeaf} from "../../libraries/ExitLeaf.sol";
import {ExitClaim} from "../../interfaces/IExitMarket.sol";
import {ExitFixture} from "./ExitFixture.sol";

/// @dev ExitFixture extension for stateful tests: ONE send tree over withdrawals that differ in sender,
///      initial destination, token and amount (ExitFixture._createFrom fixes all of them per call). A single
///      tree keeps Outbox indexes unique, like a real child chain's send tree (the spent bitmap is keyed by
///      index only).
abstract contract ExitTreeFixture is ExitFixture {
    /// @dev What a child-chain user withdrew: `from` sent it, `dest` is the initial owner on the parent chain.
    struct LeafSpec {
        address from;
        address dest;
        address token;
        uint256 amount;
    }

    /// @dev Builds withdrawals exitNum 1..n (index 0..n-1) on `gateway`, one merkle tree, published as the
    ///      unresolved rollup node `nodeNum`. Result i has exitNum i + 1 and index i.
    function _createMixed(uint64 nodeNum, LeafSpec[] memory specs) internal returns (Withdrawal[] memory ws) {
        uint256 n = specs.length;
        bytes32[] memory items = new bytes32[](n);
        ExitClaim[] memory claims = new ExitClaim[](n);
        for (uint256 i = 0; i < n; ++i) {
            ExitLeaf.Leaf memory leaf = ExitLeaf.Leaf({
                childGateway: gateway.counterpartGateway(),
                parentGateway: address(gateway),
                l1Token: specs[i].token,
                from: specs[i].from,
                initialDestination: specs[i].dest,
                amount: specs[i].amount,
                exitNum: i + 1,
                l2Block: 1000 + i,
                l1Block: 500 + i,
                l2Timestamp: 1_700_000_000 + i
            });
            items[i] = _leafHash(leaf);
            claims[i] = ExitClaim({
                initialDestination: specs[i].dest,
                l1Token: specs[i].token,
                from: specs[i].from,
                amount: specs[i].amount,
                l2Block: leaf.l2Block,
                l1Block: leaf.l1Block,
                l2Timestamp: leaf.l2Timestamp,
                index: i,
                proof: new bytes32[](0),
                sendRoot: bytes32(0),
                nodeNum: nodeNum,
                blockHash: BLOCK_HASH
            });
        }

        (bytes32 root, bytes32[][] memory proofs) = _buildTree(items);
        _publishPending(root, nodeNum);

        ws = new Withdrawal[](n);
        for (uint256 i = 0; i < n; ++i) {
            claims[i].proof = proofs[i];
            claims[i].sendRoot = root;
            ws[i] = Withdrawal({gateway: address(gateway), exitNum: i + 1, claim: claims[i]});
        }
    }
}
