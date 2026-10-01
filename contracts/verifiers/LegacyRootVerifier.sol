// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILegacyRollup, IOutbox, LegacyNode} from "../interfaces/IArbitrumBridge.sol";
import {IRootVerifier} from "../interfaces/IRootVerifier.sol";

/// @title LegacyRootVerifier
/// @notice Authenticates an Outbox send root for pre-BOLD Arbitrum rollups (RollupCore), which most
///         Orbit L3s run today.
/// @dev A root is valid if it is already confirmed in the Outbox, or if it is committed by an unresolved node
///      whose whole pending chain is uncontested: walking prevNum links from the node up to the latest confirmed
///      node, no node on the way may have a live rival sibling. A rival is how a validator disputes a node, so
///      the moment anyone contests the branch, exits proven against it stop being sellable while pending.
///      The rival test uses what RollupCore stores on the parent (NodeLib.childCreated): `latestChildNumber` is
///      its newest child and `firstChildBlock` the block of its first child. Nodes are numbered in creation
///      order, so every earlier sibling is either from an earlier block (then firstChildBlock is earlier) or
///      from the same block (then it sits in the contiguous run of nodes created in that block, just below).
///      Rejected nodes keep their storage (RollupCore._rejectNextNode only bumps _firstUnresolvedNode); a
///      resolved sibling of a node on a pending chain can only have been rejected, so it does not contest it.
///      Every uncertain case fails closed: the exit then sells only once its root is confirmed.
contract LegacyRootVerifier is IRootVerifier {
    /// @notice Bound on the pending-chain walk (a 7-day window with hourly nodes is ~170 levels).
    uint256 public constant MAX_PENDING_DEPTH = 512;
    /// @notice Bound on the scan for an earlier sibling created in the same parent-chain block.
    uint256 public constant MAX_SAME_BLOCK_SCAN = 16;

    /// @inheritdoc IRootVerifier
    function verifyRoot(address rollup, address outbox, bytes32 sendRoot, uint64 nodeNum, bytes32 blockHash)
        external
        view
        returns (bool valid, bool pending, uint64 deadlineBlock)
    {
        if (IOutbox(outbox).roots(sendRoot) != bytes32(0)) return (true, false, 0);

        ILegacyRollup r = ILegacyRollup(rollup);
        uint64 firstUnresolved = r.firstUnresolvedNode();
        if (nodeNum < firstUnresolved || nodeNum > r.latestNodeCreated()) return (false, true, 0);

        LegacyNode memory node = r.getNode(nodeNum);
        // Legacy nodes commit to their outputs as confirmData = keccak256(blockHash, sendRoot).
        if (node.confirmData != keccak256(abi.encodePacked(blockHash, sendRoot))) return (false, true, 0);
        if (!_uncontestedToConfirmed(r, nodeNum, node, firstUnresolved)) return (false, true, 0);

        return (true, true, node.deadlineBlock);
    }

    /// @inheritdoc IRootVerifier
    function isRootRejected(address rollup, address outbox, bytes32 sendRoot, uint64 nodeNum)
        external
        view
        returns (bool)
    {
        // Confirmed nodes publish their root to the Outbox; a resolved node without it was rejected.
        return IOutbox(outbox).roots(sendRoot) == bytes32(0) && nodeNum < ILegacyRollup(rollup).firstUnresolvedNode();
    }

    /// @dev Walks from the unresolved node `cursor` to the latest confirmed node. Every parent on the way must be
    ///      unresolved (a resolved parent other than the latest confirmed one was rejected, or sits below a
    ///      confirmed sibling of our branch), and no level may have a live rival.
    function _uncontestedToConfirmed(ILegacyRollup r, uint64 cursor, LegacyNode memory node, uint64 firstUnresolved)
        private
        view
        returns (bool)
    {
        uint64 latestConfirmed = r.latestConfirmed();
        for (uint256 depth = 0; depth < MAX_PENDING_DEPTH; ++depth) {
            uint64 parentNum = node.prevNum;
            if (parentNum >= cursor) return false; // malformed link: parents are always older
            if (parentNum != latestConfirmed && parentNum < firstUnresolved) return false;

            LegacyNode memory parent = r.getNode(parentNum);
            if (_hasLiveRival(r, cursor, node.createdAtBlock, parentNum, parent, firstUnresolved)) return false;
            if (parentNum == latestConfirmed) return true;
            (cursor, node) = (parentNum, parent);
        }
        return false;
    }

    /// @dev True if `parent` has, or may have, an unresolved child other than `child`.
    function _hasLiveRival(
        ILegacyRollup r,
        uint64 child,
        uint64 childCreatedAt,
        uint64 parentNum,
        LegacyNode memory parent,
        uint64 firstUnresolved
    ) private view returns (bool) {
        // A newer sibling: nodes resolve in number order and `child` is unresolved, so it is unresolved too.
        if (parent.latestChildNumber != child) return true;
        // An older sibling from an earlier block (number unknown, but below `child`): harmless only if every node
        // below `child` is already resolved, i.e. rejected (see the contract notes).
        if (parent.firstChildBlock != childCreatedAt) return child != firstUnresolved;
        // Older siblings from the same block sit in the contiguous run of nodes created in that block. Nodes resolve
        // in number order, so once the scan reaches a resolved node everything below it is resolved (rejected).
        for (uint256 i = 1; i <= MAX_SAME_BLOCK_SCAN; ++i) {
            uint64 k = child - uint64(i);
            if (k <= parentNum || k < firstUnresolved) return false;
            LegacyNode memory other = r.getNode(k);
            if (other.createdAtBlock != childCreatedAt) return false;
            if (other.prevNum == parentNum) return true;
        }
        return true; // too many nodes in one block to rule a sibling out: fail closed
    }
}
