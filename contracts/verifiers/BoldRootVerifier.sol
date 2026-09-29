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
///      Conservative rule: a pending assertion is accepted only if EVERY pending ancestor up to the latest
///      confirmed one is registered and unchallenged (no rival child at any level). BOLD lets assertions build
///      on pending parents, so checking only the immediate parent would accept descendants of a losing branch.
contract BoldRootVerifier is IRootVerifier {
    uint8 private constant STATUS_NONE = 0;
    uint8 private constant STATUS_PENDING = 1;
    uint8 private constant STATUS_CONFIRMED = 2;
    /// @notice Bound on pending-chain walks. Arbitrum One keeps ~150 pending assertions (6.4 days, ~hourly).
    uint256 public constant MAX_PENDING_DEPTH = 512;

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
    error NotDescendant(bytes32 assertionHash, bytes32 ancestor);

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

    /// @notice Prove an assertion is on a losing branch: it is (or descends from) a pending `losingAncestor`
    ///         whose registered sibling `confirmedSibling` (same parent) is confirmed.
    /// @param losingAncestor may equal `assertionHash`
    function markRejected(address rollup, bytes32 assertionHash, bytes32 losingAncestor, bytes32 confirmedSibling)
        external
    {
        Registered storage a = assertions[rollup][assertionHash];
        Registered storage l = assertions[rollup][losingAncestor];
        Registered storage s = assertions[rollup][confirmedSibling];
        if (!a.exists) revert NotRegistered(assertionHash);
        if (!l.exists) revert NotRegistered(losingAncestor);
        if (!s.exists) revert NotRegistered(confirmedSibling);
        if (losingAncestor == confirmedSibling || l.parent != s.parent) revert NotSiblings(losingAncestor, confirmedSibling);
        if (!_descendsFrom(rollup, assertionHash, losingAncestor)) revert NotDescendant(assertionHash, losingAncestor);

        IBoldRollup r = IBoldRollup(rollup);
        if (r.getAssertion(confirmedSibling).status != STATUS_CONFIRMED) revert SiblingNotConfirmed(confirmedSibling);
        if (r.getAssertion(losingAncestor).status != STATUS_PENDING) revert NotPending(losingAncestor);

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
        if (!_unchallengedToConfirmed(r, rollup, witness)) return (false, true, 0);

        return (true, true, node.createdAtBlock + r.confirmPeriodBlocks());
    }

    /// @dev Walks pending ancestors (all must be registered) until a confirmed one; every level must have no
    ///      rival child. Fails closed on unregistered links, non-pending/non-confirmed states or excess depth.
    function _unchallengedToConfirmed(IBoldRollup r, address rollup, bytes32 cursor) private view returns (bool) {
        for (uint256 depth = 0; depth < MAX_PENDING_DEPTH; ++depth) {
            Registered storage link = assertions[rollup][cursor];
            if (!link.exists) return false;
            if (r.getAssertion(link.parent).secondChildBlock != 0) return false; // dispute at this level
            uint8 parentStatus = r.getAssertion(link.parent).status;
            if (parentStatus == STATUS_CONFIRMED) return true;
            if (parentStatus != STATUS_PENDING) return false;
            cursor = link.parent;
        }
        return false;
    }

    /// @dev True if `ancestor` is `node` or reachable from it through registered parent links (bounded).
    function _descendsFrom(address rollup, bytes32 node, bytes32 ancestor) private view returns (bool) {
        for (uint256 depth = 0; depth < MAX_PENDING_DEPTH; ++depth) {
            if (node == ancestor) return true;
            Registered storage link = assertions[rollup][node];
            if (!link.exists) return false;
            node = link.parent;
        }
        return false;
    }

    /// @inheritdoc IRootVerifier
    function isRootRejected(address rollup, address outbox, bytes32 sendRoot, uint64) external view returns (bool) {
        return IOutbox(outbox).roots(sendRoot) == bytes32(0) && rejectedRoots[rollup][sendRoot];
    }
}
