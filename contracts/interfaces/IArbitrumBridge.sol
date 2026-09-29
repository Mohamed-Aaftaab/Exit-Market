// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Parent-chain side of an Arbitrum token gateway (L1ArbitrumExtendedGateway).
/// @dev Every standard, custom, WETH and USDC gateway (incl. Orbit variants) inherits this.
interface IL1ArbitrumExtendedGateway {
    function transferExitAndCall(
        uint256 exitNum,
        address initialDestination,
        address newDestination,
        bytes calldata newData,
        bytes calldata data
    ) external;

    function getExternalCall(uint256 exitNum, address initialDestination, bytes calldata initialData)
        external
        view
        returns (address target, bytes memory data);

    function counterpartGateway() external view returns (address);

    function inbox() external view returns (address);

    function finalizeInboundTransfer(address token, address from, address to, uint256 amount, bytes calldata data)
        external
        payable;
}

/// @notice Hook the gateway calls on the new destination when an exit is transferred with data.
interface ITradeableExitReceiver {
    function onExitTransfer(address sender, uint256 exitNum, bytes calldata data) external returns (bool);
}

interface IInbox {
    function bridge() external view returns (address);
}

interface IBridge {
    function rollup() external view returns (address);
}

interface IOutbox {
    function roots(bytes32 root) external view returns (bytes32);

    function isSpent(uint256 index) external view returns (bool);

    function calculateItemHash(
        address l2Sender,
        address to,
        uint256 l2Block,
        uint256 l1Block,
        uint256 l2Timestamp,
        uint256 value,
        bytes calldata data
    ) external pure returns (bytes32);

    function calculateMerkleRoot(bytes32[] memory proof, uint256 path, bytes32 item) external pure returns (bytes32);
}

/// @notice Node layout of the pre-BOLD rollup (RollupCore), used by most Orbit L3s today.
struct LegacyNode {
    bytes32 stateHash;
    bytes32 challengeHash;
    bytes32 confirmData;
    uint64 prevNum;
    uint64 deadlineBlock;
    uint64 noChildConfirmedBeforeBlock;
    uint64 stakerCount;
    uint64 childStakerCount;
    uint64 firstChildBlock;
    uint64 latestChildNumber;
    uint64 createdAtBlock;
    bytes32 nodeHash;
}

interface ILegacyRollup {
    function outbox() external view returns (address);

    function getNode(uint64 nodeNum) external view returns (LegacyNode memory);

    function latestConfirmed() external view returns (uint64);
}
