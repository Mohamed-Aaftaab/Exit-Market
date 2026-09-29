// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ITradeableExitReceiver, LegacyNode} from "../../interfaces/IArbitrumBridge.sol";

/// @dev Test-only token with configurable decimals and open minting.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mirrors nitro-contracts v2.1.3 AbsOutbox hashing, merkle and spent-bitmap logic.
contract MockOutbox {
    mapping(bytes32 => bytes32) public roots;
    mapping(uint256 => bytes32) public spent;

    function setRoot(bytes32 root, bytes32 blockHash) external {
        roots[root] = blockHash;
    }

    function markSpent(uint256 index) external {
        spent[index / 255] |= bytes32(1 << (index % 255));
    }

    function isSpent(uint256 index) external view returns (bool) {
        return ((spent[index / 255] >> (index % 255)) & bytes32(uint256(1))) != bytes32(0);
    }

    function calculateItemHash(
        address l2Sender,
        address to,
        uint256 l2Block,
        uint256 l1Block,
        uint256 l2Timestamp,
        uint256 value,
        bytes calldata data
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(l2Sender, to, l2Block, l1Block, l2Timestamp, value, data));
    }

    function calculateMerkleRoot(bytes32[] memory proof, uint256 path, bytes32 item) public pure returns (bytes32) {
        bytes32 h = keccak256(abi.encodePacked(item));
        for (uint256 i = 0; i < proof.length; i++) {
            h = (path & (1 << i)) == 0
                ? keccak256(abi.encodePacked(h, proof[i]))
                : keccak256(abi.encodePacked(proof[i], h));
        }
        return h;
    }
}

/// @dev Minimal pre-BOLD rollup: stores nodes and exposes the outbox. Rejected nodes are NOT deleted
///      (RollupCore._rejectNextNode only bumps _firstUnresolvedNode).
contract MockLegacyRollup {
    address public outbox;
    uint64 public latestConfirmed;
    uint64 public firstUnresolvedNode = 1;
    uint64 public latestNodeCreated;
    mapping(uint64 => LegacyNode) private _nodes;

    constructor(address outbox_) {
        outbox = outbox_;
    }

    function setNodeConfirmData(uint64 nodeNum, bytes32 confirmData) external {
        _nodes[nodeNum].confirmData = confirmData;
    }

    function setNodeDeadline(uint64 nodeNum, uint64 deadlineBlock) external {
        _nodes[nodeNum].deadlineBlock = deadlineBlock;
    }

    function setFirstUnresolvedNode(uint64 n) external {
        firstUnresolvedNode = n;
    }

    function setLatestNodeCreated(uint64 n) external {
        latestNodeCreated = n;
    }

    function setLatestConfirmed(uint64 n) external {
        latestConfirmed = n;
    }

    function deleteNode(uint64 nodeNum) external {
        delete _nodes[nodeNum];
    }

    function getNode(uint64 nodeNum) external view returns (LegacyNode memory) {
        return _nodes[nodeNum];
    }
}

/// @dev allowedOutboxes defaults to true for the rollup's own outbox unless explicitly overridden.
contract MockBridge {
    address public rollup;
    mapping(address => uint8) private _override; // 0 = default, 1 = allowed, 2 = disallowed

    constructor(address rollup_) {
        rollup = rollup_;
    }

    function setAllowedOutbox(address outbox, bool allowed) external {
        _override[outbox] = allowed ? 1 : 2;
    }

    function allowedOutboxes(address outbox) external view returns (bool) {
        uint8 o = _override[outbox];
        if (o != 0) return o == 1;
        return MockLegacyRollup(rollup).outbox() == outbox;
    }
}

contract MockInbox {
    address public bridge;

    constructor(address bridge_) {
        bridge = bridge_;
    }
}

/// @dev Mirrors L1ArbitrumExtendedGateway (token-bridge-contracts) tradeable-exit logic verbatim,
///      plus a helper that simulates the Outbox executing finalizeInboundTransfer.
contract MockExtendedGateway {
    struct ExitData {
        bool isExit;
        address _newTo;
        bytes _newData;
    }

    address public counterpartGateway;
    address public inbox;
    mapping(bytes32 => ExitData) public redirectedExits;

    event WithdrawRedirected(
        address indexed from, address indexed to, uint256 indexed exitNum, bytes newData, bytes data, bool madeExternalCall
    );

    constructor(address counterpart_, address inbox_) {
        counterpartGateway = counterpart_;
        inbox = inbox_;
    }

    /// @dev Test hook: simulates a proxy upgrade that swaps verification sources.
    function setInbox(address inbox_) external {
        inbox = inbox_;
    }

    function transferExitAndCall(
        uint256 _exitNum,
        address _initialDestination,
        address _newDestination,
        bytes calldata _newData,
        bytes calldata _data
    ) external {
        (address expectedSender,) = getExternalCall(_exitNum, _initialDestination, "");
        require(msg.sender == expectedSender, "NOT_EXPECTED_SENDER");
        require(_newData.length == 0, "NO_DATA_ALLOWED");

        redirectedExits[encodeWithdrawal(_exitNum, _initialDestination)] = ExitData(true, _newDestination, _newData);

        if (_data.length > 0) {
            require(_newDestination.code.length > 0, "TO_NOT_CONTRACT");
            bool success = ITradeableExitReceiver(_newDestination).onExitTransfer(expectedSender, _exitNum, _data);
            require(success, "TRANSFER_HOOK_FAIL");
        }

        emit WithdrawRedirected(expectedSender, _newDestination, _exitNum, _newData, _data, _data.length > 0);
    }

    function getExternalCall(uint256 _exitNum, address _initialDestination, bytes memory _initialData)
        public
        view
        returns (address target, bytes memory data)
    {
        ExitData storage exit = redirectedExits[encodeWithdrawal(_exitNum, _initialDestination)];
        if (exit.isExit) return (exit._newTo, exit._newData);
        return (_initialDestination, _initialData);
    }

    function encodeWithdrawal(uint256 _exitNum, address _initialDestination) public pure returns (bytes32) {
        return keccak256(abi.encode(_exitNum, _initialDestination));
    }

    /// @dev Simulates Outbox -> finalizeInboundTransfer: pays whoever currently owns the exit.
    function simulateExecute(MockOutbox outbox, uint256 index, uint256 exitNum, address initialDest, MockERC20 token, uint256 amount)
        external
    {
        outbox.markSpent(index);
        (address to,) = getExternalCall(exitNum, initialDest, "");
        token.mint(to, amount);
    }
}
