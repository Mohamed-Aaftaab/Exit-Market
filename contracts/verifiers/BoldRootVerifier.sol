// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOutbox} from "../interfaces/IArbitrumBridge.sol";
import {BoldAssertionNode, BoldAssertionState, IBoldRollup} from "../interfaces/IBoldRollup.sol";
import {IRootVerifier} from "../interfaces/IRootVerifier.sol";

/// @title BoldRootVerifier
/// @notice Authenticates Outbox send roots for BOLD rollups (Arbitrum One/Nova, Arbitrum Sepolia, new Orbit
///         chains) through the same IRootVerifier interface ExitMarket already uses.
/// @dev BOLD stores only assertion hashes, so a pending assertion's send root is proven by registering its
///      preimage once: assertionHash = keccak256(parent, keccak256(abi.encode(afterState)), inboxAcc)
///      (RollupLib.assertionHash, verified against live Arbitrum Sepolia assertions). Registration is
///      permissionless and trustless. In an ExitClaim for a BOLD chain, `blockHash` carries the assertion
///      hash and `nodeNum` is ignored.
///      Conservative rule: a pending assertion is accepted only while its parent has no rival child, i.e. it
///      is unchallenged. During a dispute nothing from that level is accepted until it resolves.
contract BoldRootVerifier is IRootVerifier {
    uint8 private constant STATUS_NONE = 0;
    uint8 private constant STATUS_PENDING = 1;
    uint8 private constant STATUS_CONFIRMED = 2;

    struct Registered {
        bytes32 parent;
        bytes32 sendRoot;
        bytes32 blockHash;
        bool exists;
    }

    mapping(address rollup => mapping(bytes32 assertionHash => Registered)) public assertions;
    /// @notice Send roots proven to belong to a losing branch (a confirmed sibling exists).
    mapping(address rollup => mapping(bytes32 sendRoot => bool)) public rejectedRoots;

    event AssertionRegistered(address indexed rollup, bytes32 indexed assertionHash, bytes32 sendRoot);
    event AssertionRejected(address indexed rollup, bytes32 indexed assertionHash, bytes32 confirmedSibling);

    error UnknownAssertion(bytes32 assertionHash);
    error NotRegistered(bytes32 assertionHash);
    error NotSiblings(bytes32 a, bytes32 b);
    error SiblingNotConfirmed(bytes32 sibling);
    error NotPending(bytes32 assertionHash);

    /// @notice Register a BOLD assertion from its preimage (as emitted in AssertionCreated).
    /// @return assertionHash the recomputed hash, which the rollup must know
    function register(
        address rollup,
        bytes32 parentAssertionHash,
        BoldAssertionState calldata afterState,
        bytes32 inboxAcc
    ) external returns (bytes32 assertionHash) {
        assertionHash = keccak256(abi.encodePacked(parentAssertionHash, keccak256(abi.encode(afterState)), inboxAcc));
        if (IBoldRollup(rollup).getAssertion(assertionHash).status == STATUS_NONE) {
            revert UnknownAssertion(assertionHash);
        }
        bytes32 sendRoot = afterState.globalState.bytes32Vals[1];
        assertions[rollup][assertionHash] = Registered({
            parent: parentAssertionHash,
            sendRoot: sendRoot,
            blockHash: afterState.globalState.bytes32Vals[0],
            exists: true
        });
        emit AssertionRegistered(rollup, assertionHash, sendRoot);
    }

    /// @notice Prove a pending assertion lost: a registered sibling (same parent) is confirmed.
    function markRejected(address rollup, bytes32 assertionHash, bytes32 confirmedSibling) external {
        Registered storage a = assertions[rollup][assertionHash];
        Registered storage s = assertions[rollup][confirmedSibling];
        if (!a.exists) revert NotRegistered(assertionHash);
        if (!s.exists) revert NotRegistered(confirmedSibling);
        if (assertionHash == confirmedSibling || a.parent != s.parent) revert NotSiblings(assertionHash, confirmedSibling);

        IBoldRollup r = IBoldRollup(rollup);
        if (r.getAssertion(confirmedSibling).status != STATUS_CONFIRMED) revert SiblingNotConfirmed(confirmedSibling);
        if (r.getAssertion(assertionHash).status != STATUS_PENDING) revert NotPending(assertionHash);

        rejectedRoots[rollup][a.sendRoot] = true;
        emit AssertionRejected(rollup, assertionHash, confirmedSibling);
    }

    /// @inheritdoc IRootVerifier
    /// @dev `witness` is the assertion hash (carried in ExitClaim.blockHash); the nodeNum argument is unused.
    function verifyRoot(address rollup, address outbox, bytes32 sendRoot, uint64, bytes32 witness)
        external
        view
        returns (bool valid, bool pending, uint64 deadlineBlock)
    {
        if (IOutbox(outbox).roots(sendRoot) != bytes32(0)) return (true, false, 0);

        Registered memory a = assertions[rollup][witness];
        if (!a.exists || a.sendRoot != sendRoot || rejectedRoots[rollup][sendRoot]) return (false, true, 0);

        IBoldRollup r = IBoldRollup(rollup);
        BoldAssertionNode memory node = r.getAssertion(witness);
        if (node.status != STATUS_PENDING) return (false, true, 0);
        // Unchallenged only: a rival child of the same parent means a dispute is in progress.
        if (r.getAssertion(a.parent).secondChildBlock != 0) return (false, true, 0);

        return (true, true, node.createdAtBlock + r.confirmPeriodBlocks());
    }

    /// @inheritdoc IRootVerifier
    function isRootRejected(address rollup, address outbox, bytes32 sendRoot, uint64) external view returns (bool) {
        return IOutbox(outbox).roots(sendRoot) == bytes32(0) && rejectedRoots[rollup][sendRoot];
    }
}
