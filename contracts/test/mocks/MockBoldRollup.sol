// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BoldAssertionNode, BoldAssertionState, IBoldRollup} from "../../interfaces/IBoldRollup.sol";

interface IMockOutboxRoots {
    function setRoot(bytes32 root, bytes32 blockHash) external;
}

/// @dev Minimal BOLD rollup (nitro-contracts v3 RollupCore view surface) for verifier and market tests.
///      Assertions can be authored two ways:
///        - `createAssertion`: hashes the preimage exactly like RollupLib.assertionHash and behaves like the
///          real rollup (Pending status, createdAtBlock = block.number, first/second child bookkeeping on the
///          parent, and `confirmAssertion` publishing the send root to the Outbox);
///        - `setAssertion` / `setStatus` / `setSecondChildBlock`: raw setters for edge states that the real
///          rollup would not produce in one step (e.g. Confirmed while the Outbox holds no root).
///      A losing sibling stays Pending forever, as in the real rollup (BOLD never marks losers).
contract MockBoldRollup is IBoldRollup {
    uint8 public constant STATUS_NONE = 0;
    uint8 public constant STATUS_PENDING = 1;
    uint8 public constant STATUS_CONFIRMED = 2;

    address public outbox;
    uint64 public confirmPeriodBlocks;
    bytes32 public latestConfirmed;

    struct Committed {
        bytes32 blockHash;
        bytes32 sendRoot;
        bool known;
    }

    mapping(bytes32 assertionHash => BoldAssertionNode) private _nodes;
    mapping(bytes32 assertionHash => Committed) private _committed;

    constructor(address outbox_, uint64 confirmPeriodBlocks_) {
        outbox = outbox_;
        confirmPeriodBlocks = confirmPeriodBlocks_;
    }

    // ---------------------------------------------------------------- IBoldRollup

    function getAssertion(bytes32 assertionHash) external view returns (BoldAssertionNode memory) {
        return _nodes[assertionHash];
    }

    // ---------------------------------------------------------------- hashing

    /// @dev RollupLib.assertionHash: keccak256(abi.encodePacked(parent, keccak256(abi.encode(afterState)), inboxAcc)).
    function assertionHashOf(bytes32 parentAssertionHash, BoldAssertionState memory afterState, bytes32 inboxAcc)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(parentAssertionHash, keccak256(abi.encode(afterState)), inboxAcc));
    }

    // ---------------------------------------------------------------- realistic authoring

    /// @notice Post a new Pending assertion under `parentAssertionHash` (which need not be a known assertion,
    ///         e.g. a test-only genesis hash). Mirrors AssertionChain.childCreated on the parent.
    function createAssertion(bytes32 parentAssertionHash, BoldAssertionState calldata afterState, bytes32 inboxAcc)
        external
        returns (bytes32 assertionHash)
    {
        assertionHash = assertionHashOf(parentAssertionHash, afterState, inboxAcc);
        require(_nodes[assertionHash].status == STATUS_NONE, "ASSERTION_ALREADY_EXISTS");

        BoldAssertionNode storage parent = _nodes[parentAssertionHash];
        bool isFirst = parent.firstChildBlock == 0;
        if (isFirst) parent.firstChildBlock = uint64(block.number);
        else if (parent.secondChildBlock == 0) parent.secondChildBlock = uint64(block.number);

        _nodes[assertionHash] = BoldAssertionNode({
            firstChildBlock: 0,
            secondChildBlock: 0,
            createdAtBlock: uint64(block.number),
            isFirstChild: isFirst,
            status: STATUS_PENDING,
            configHash: keccak256(abi.encode("config", assertionHash))
        });
        _committed[assertionHash] = Committed({
            blockHash: afterState.globalState.bytes32Vals[0],
            sendRoot: afterState.globalState.bytes32Vals[1],
            known: true
        });
    }

    /// @notice Confirm a created assertion: Pending -> Confirmed and outbox.updateSendRoot(sendRoot, blockHash),
    ///         which is what RollupUserLogic.confirmAssertion does. Does not touch siblings.
    function confirmAssertion(bytes32 assertionHash) external {
        Committed memory c = _committed[assertionHash];
        require(c.known, "NOT_CREATED_HERE");
        require(_nodes[assertionHash].status == STATUS_PENDING, "NOT_PENDING");
        _nodes[assertionHash].status = STATUS_CONFIRMED;
        latestConfirmed = assertionHash;
        IMockOutboxRoots(outbox).setRoot(c.sendRoot, c.blockHash);
    }

    // ---------------------------------------------------------------- raw setters

    function setAssertion(bytes32 assertionHash, uint8 status, uint64 createdAtBlock, uint64 secondChildBlock)
        external
    {
        BoldAssertionNode storage n = _nodes[assertionHash];
        n.status = status;
        n.createdAtBlock = createdAtBlock;
        n.secondChildBlock = secondChildBlock;
    }

    function setStatus(bytes32 assertionHash, uint8 status) external {
        _nodes[assertionHash].status = status;
    }

    function setCreatedAtBlock(bytes32 assertionHash, uint64 createdAtBlock) external {
        _nodes[assertionHash].createdAtBlock = createdAtBlock;
    }

    function setSecondChildBlock(bytes32 assertionHash, uint64 secondChildBlock) external {
        _nodes[assertionHash].secondChildBlock = secondChildBlock;
    }

    function setConfirmPeriodBlocks(uint64 blocks_) external {
        confirmPeriodBlocks = blocks_;
    }

    function setOutbox(address outbox_) external {
        outbox = outbox_;
    }
}
