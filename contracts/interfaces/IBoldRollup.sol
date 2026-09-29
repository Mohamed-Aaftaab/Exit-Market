// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal view of a BOLD rollup (nitro-contracts v3 RollupCore): Arbitrum One/Nova since 2025,
///         Arbitrum Sepolia, and Orbit chains created with RollupCreator v3.x.
struct BoldGlobalState {
    bytes32[2] bytes32Vals; // [blockHash, sendRoot]
    uint64[2] u64Vals; // [inboxPosition, positionInMessage]
}

struct BoldAssertionState {
    BoldGlobalState globalState;
    uint8 machineStatus; // MachineStatus enum: RUNNING, FINISHED, ERRORED
    bytes32 endHistoryRoot;
}

/// @dev AssertionStatus: 0 NoAssertion, 1 Pending, 2 Confirmed.
struct BoldAssertionNode {
    uint64 firstChildBlock;
    uint64 secondChildBlock;
    uint64 createdAtBlock;
    bool isFirstChild;
    uint8 status;
    bytes32 configHash;
}

interface IBoldRollup {
    function getAssertion(bytes32 assertionHash) external view returns (BoldAssertionNode memory);

    function confirmPeriodBlocks() external view returns (uint64);

    function latestConfirmed() external view returns (bytes32);

    function outbox() external view returns (address);
}
