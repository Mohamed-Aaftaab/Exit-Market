// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Checks that an Outbox send root is authentic for a rollup (legacy now, BOLD later).
interface IRootVerifier {
    /// @param rollup rollup contract of the child chain
    /// @param outbox Outbox of the child chain
    /// @param sendRoot claimed send root
    /// @param nodeNum node committing `sendRoot` (ignored if the root is already confirmed)
    /// @param blockHash child block hash committed next to `sendRoot` (ignored if confirmed)
    /// @return valid root is confirmed, or belongs to a node that is still unresolved
    /// @return pending true if the root is not yet confirmed
    /// @return deadlineBlock L1 block after which the node can be confirmed (0 if confirmed)
    function verifyRoot(address rollup, address outbox, bytes32 sendRoot, uint64 nodeNum, bytes32 blockHash)
        external
        view
        returns (bool valid, bool pending, uint64 deadlineBlock);
}
