// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILegacyRollup, IOutbox, LegacyNode} from "../interfaces/IArbitrumBridge.sol";
import {IRootVerifier} from "../interfaces/IRootVerifier.sol";

/// @title LegacyRootVerifier
/// @notice Authenticates an Outbox send root for pre-BOLD Arbitrum rollups (RollupCore), which most
///         Orbit L3s run today.
/// @dev A root is valid if it is already confirmed in the Outbox, or if it is committed by a node that
///      is still unresolved. Rejected nodes keep their storage (RollupCore._rejectNextNode only bumps
///      _firstUnresolvedNode), so the node range check is what excludes them.
contract LegacyRootVerifier is IRootVerifier {
    /// @inheritdoc IRootVerifier
    function verifyRoot(address rollup, address outbox, bytes32 sendRoot, uint64 nodeNum, bytes32 blockHash)
        external
        view
        returns (bool valid, bool pending, uint64 deadlineBlock)
    {
        if (IOutbox(outbox).roots(sendRoot) != bytes32(0)) return (true, false, 0);

        ILegacyRollup r = ILegacyRollup(rollup);
        if (nodeNum < r.firstUnresolvedNode() || nodeNum > r.latestNodeCreated()) return (false, true, 0);

        LegacyNode memory node = r.getNode(nodeNum);
        // Legacy nodes commit to their outputs as confirmData = keccak256(blockHash, sendRoot).
        if (node.confirmData != keccak256(abi.encodePacked(blockHash, sendRoot))) return (false, true, 0);

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
}
