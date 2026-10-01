// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LegacyNode} from "../interfaces/IArbitrumBridge.sol";
import {LegacyRootVerifier} from "../verifiers/LegacyRootVerifier.sol";
import {MockLegacyRollup, MockOutbox} from "./mocks/MockArbitrum.sol";

/// @notice The legacy verifier accepts a pending root only while its whole pending chain is uncontested.
/// @dev Node 0 is the latest confirmed node unless a test says otherwise; `_create(p)` makes the next node a child
///      of `p` in the current block (RollupCore numbering), `_nextBlock()` moves to a new parent-chain block.
contract LegacyRootVerifierTest is Test {
    bytes32 private constant BLOCK_HASH = keccak256("child block");
    uint64 private constant CONFIRM_BLOCKS = 150;

    MockOutbox private outbox;
    MockLegacyRollup private rollup;
    LegacyRootVerifier private verifier;

    function setUp() public {
        vm.roll(1_000);
        outbox = new MockOutbox();
        rollup = new MockLegacyRollup(address(outbox));
        verifier = new LegacyRootVerifier();
    }

    // ---------------------------------------------------------------- uncontested chains

    function test_linearPendingChainIsValidAtEveryDepth() public {
        uint64 a = _create(0);
        _nextBlock();
        uint64 b = _create(a);
        _nextBlock();
        uint64 c = _create(b);

        _assertValid(a);
        _assertValid(b);
        _assertValid(c);
        (,, uint64 deadline) = _verify(c);
        assertEq(deadline, rollup.getNode(c).deadlineBlock);
    }

    function test_nodesOfOneChainCreatedInTheSameBlockAreNotRivals() public {
        uint64 a = _create(0);
        uint64 b = _create(a);
        uint64 c = _create(b);
        _assertValid(a);
        _assertValid(b);
        _assertValid(c);
    }

    function test_confirmedRootIsValidWhateverTheNodes() public {
        uint64 a = _create(0);
        _create(0); // a rival, irrelevant once a's root is in the Outbox
        outbox.setRoot(_root(a), BLOCK_HASH);
        (bool valid, bool pending, uint64 deadline) = _verify(a);
        assertTrue(valid);
        assertFalse(pending);
        assertEq(deadline, 0);
    }

    // ---------------------------------------------------------------- rivals

    function test_aNewerSiblingContestsTheNodeAndEveryDescendant() public {
        uint64 a = _create(0);
        _nextBlock();
        uint64 honest = _create(a);
        uint64 child = _create(honest);
        _nextBlock();
        uint64 rival = _create(a);

        _assertValid(a); // the level above the dispute is untouched
        _assertInvalid(honest);
        _assertInvalid(child);
        _assertInvalid(rival);
    }

    function test_anOlderSiblingFromAnEarlierBlockContestsTheNode() public {
        uint64 first = _create(0);
        _nextBlock();
        uint64 second = _create(0);
        _assertInvalid(first);
        _assertInvalid(second);
    }

    function test_anOlderSiblingFromTheSameBlockContestsTheNode() public {
        uint64 first = _create(0);
        uint64 other = _create(first); // same block, not a sibling: the scan must look past it
        uint64 second = _create(0);
        _assertInvalid(first);
        _assertInvalid(other);
        _assertInvalid(second);
    }

    function test_aContestedAncestorInvalidatesTheWholeBranchBelowIt() public {
        uint64 a = _create(0);
        _nextBlock();
        uint64 b = _create(a);
        _nextBlock();
        uint64 c = _create(b);
        uint64 d = _create(c);
        _nextBlock();
        _create(a); // rival of b

        _assertValid(a);
        _assertInvalid(b);
        _assertInvalid(c);
        _assertInvalid(d);
    }

    // ---------------------------------------------------------------- resolution

    function test_onceTheOlderRivalIsRejectedTheSurvivorIsValidAgain() public {
        uint64 fake = _create(0);
        _nextBlock();
        uint64 honest = _create(0);
        _assertInvalid(honest);

        rollup.setFirstUnresolvedNode(fake + 1); // fake rejected
        _assertValid(honest);
        _assertInvalid(fake);
    }

    function test_onceASameBlockRivalIsRejectedTheSurvivorIsValidAgain() public {
        uint64 fake = _create(0);
        uint64 honest = _create(0);
        _assertInvalid(honest);

        rollup.setFirstUnresolvedNode(fake + 1);
        _assertValid(honest);
    }

    /// An older rival from an earlier block has an unknown number, so the survivor is accepted only once every
    /// node below it is resolved. Until then it fails closed (the exit still sells once confirmed).
    function test_anOlderRivalFailsClosedUntilEveryNodeBelowIsResolved() public {
        uint64 a = _create(0);
        _nextBlock();
        uint64 fake = _create(a);
        _nextBlock();
        uint64 fakeChild = _create(fake);
        _nextBlock();
        uint64 honest = _create(a);
        rollup.setLatestConfirmed(a);
        rollup.setFirstUnresolvedNode(fake);
        _assertInvalid(honest); // the rival is unresolved

        rollup.setFirstUnresolvedNode(fakeChild); // fake rejected, its child not yet
        _assertInvalid(honest); // the older rival's number is unknown: fail closed

        rollup.setFirstUnresolvedNode(honest); // everything below honest resolved
        _assertValid(honest);
    }

    function test_aRejectedParentInvalidatesItsChildren() public {
        uint64 a = _create(0);
        _nextBlock();
        uint64 b = _create(a);
        rollup.setFirstUnresolvedNode(a + 1); // a rejected, latest confirmed is still 0
        _assertInvalid(b);
    }

    function test_aBranchBelowAConfirmedSiblingIsDoomed() public {
        uint64 winner = _create(0);
        _nextBlock();
        uint64 loser = _create(0);
        uint64 loserChild = _create(loser);
        rollup.setLatestConfirmed(winner);
        rollup.setFirstUnresolvedNode(winner + 1);
        outbox.setRoot(_root(winner), BLOCK_HASH);

        _assertInvalid(loser);
        _assertInvalid(loserChild);
    }

    function test_resolvedOrUnknownNodesAreInvalid() public {
        uint64 a = _create(0);
        rollup.setFirstUnresolvedNode(a + 1);
        _assertInvalid(a); // resolved without an Outbox root: rejected
        _assertInvalid(a + 1); // never created
    }

    /// The same-block scan stops at the first node from another block: a doomed node created in the parent's block
    /// (a child of an older confirmed node) is no rival of a child created later.
    function test_theSameBlockScanStopsAtANodeFromAnotherBlock() public {
        uint64 confirmed = _create(0);
        rollup.setLatestConfirmed(confirmed);
        rollup.setFirstUnresolvedNode(confirmed + 1);
        _nextBlock();
        uint64 parent = _create(confirmed);
        uint64 doomed = _create(0); // same block as `parent`, on a dead branch
        _nextBlock();
        uint64 child = _create(parent);

        _assertValid(child);
        _assertValid(parent);
        _assertInvalid(doomed);
    }

    function test_isRootRejectedOnlyForAResolvedNodeWhoseRootNeverReachedTheOutbox() public {
        uint64 a = _create(0);
        assertFalse(verifier.isRootRejected(address(rollup), address(outbox), _root(a), a), "unresolved");
        rollup.setFirstUnresolvedNode(a + 1);
        assertTrue(verifier.isRootRejected(address(rollup), address(outbox), _root(a), a), "resolved, no root");
        outbox.setRoot(_root(a), BLOCK_HASH);
        assertFalse(verifier.isRootRejected(address(rollup), address(outbox), _root(a), a), "confirmed");
    }

    /// RollupCore never links a node to a parent that is not older; a rollup reporting one is refused, not looped on.
    function test_aMalformedParentLinkIsRefused() public {
        uint64 a = _create(0);
        LegacyNode memory node = rollup.getNode(a);
        node.prevNum = a; // its own parent
        vm.mockCall(address(rollup), abi.encodeCall(MockLegacyRollup.getNode, (a)), abi.encode(node));
        _assertInvalid(a);
    }

    function test_aWrongCommitmentIsInvalid() public {
        uint64 a = _create(0);
        (bool valid,,) = verifier.verifyRoot(address(rollup), address(outbox), _root(a), a, keccak256("other block"));
        assertFalse(valid);
    }

    // ---------------------------------------------------------------- bounds

    /// Doomed children of an old confirmed node can share a block with a legitimate node. Up to
    /// MAX_SAME_BLOCK_SCAN of them are ruled out one by one; beyond that the verifier fails closed.
    function test_sameBlockScanIsBoundedAndFailsClosed() public {
        uint256 bound = verifier.MAX_SAME_BLOCK_SCAN();
        assertEq(bound, 16);
        uint64 confirmed = _create(0);
        rollup.setLatestConfirmed(confirmed);
        rollup.setFirstUnresolvedNode(confirmed + 1);
        _nextBlock();

        for (uint256 i = 0; i < bound - 1; ++i) {
            _create(0); // doomed: siblings of the confirmed node
        }
        uint64 inBound = _create(confirmed);
        _assertValid(inBound);

        _nextBlock();
        uint64 confirmed2 = inBound;
        rollup.setLatestConfirmed(confirmed2);
        rollup.setFirstUnresolvedNode(confirmed2 + 1);
        for (uint256 i = 0; i < bound; ++i) {
            _create(0);
        }
        uint64 beyond = _create(confirmed2);
        _assertInvalid(beyond);
    }

    function test_pendingChainDepthIsBounded() public {
        uint256 maxDepth = verifier.MAX_PENDING_DEPTH();
        assertEq(maxDepth, 512);
        uint64 parent = 0;
        for (uint256 i = 0; i <= maxDepth; ++i) {
            parent = _create(parent);
        }
        _assertValid(uint64(maxDepth)); // 512 pending levels
        _assertInvalid(uint64(maxDepth + 1)); // 513
    }

    // ---------------------------------------------------------------- property

    /// Random node trees against a brute-force reference. Sound: never valid unless every level from the node to
    /// the latest confirmed one is unresolved and has no other unresolved child. Complete for honest chains:
    /// valid whenever no node on the path ever had a sibling.
    function testFuzz_agreesWithABruteForceModel(uint256 seed, uint8 nodeCount, uint8 target, uint8 confirmedPick, uint8 resolvedPick)
        public
    {
        uint64 n = uint64(bound(nodeCount, 1, 10));
        uint64[] memory parentOf = new uint64[](n + 1);
        for (uint64 k = 1; k <= n; ++k) {
            uint256 r = uint256(keccak256(abi.encode(seed, k)));
            if (r % 3 == 0) _nextBlock();
            // Mostly extend the newest node (honest chains), sometimes fork anywhere.
            uint64 p = (r >> 8) % 4 == 0 ? uint64((r >> 16) % k) : k - 1;
            parentOf[k] = p;
            assertEq(_create(p), k);
        }

        uint64 latestConfirmed = _ancestorPick(parentOf, n, confirmedPick);
        uint64 firstUnresolved = latestConfirmed + 1 + uint64(bound(resolvedPick, 0, n - latestConfirmed));
        rollup.setLatestConfirmed(latestConfirmed);
        rollup.setFirstUnresolvedNode(firstUnresolved);

        uint64 node = uint64(bound(target, 1, n));
        (bool valid,,) = _verify(node);
        (bool modelValid, bool onlyChildren) = _model(parentOf, n, node, latestConfirmed, firstUnresolved);

        if (valid) assertTrue(modelValid, "accepted a contested or doomed node");
        if (modelValid && onlyChildren) assertTrue(valid, "refused an uncontested honest chain");
    }

    // ---------------------------------------------------------------- helpers

    function _create(uint64 parent) private returns (uint64 nodeNum) {
        nodeNum = rollup.latestNodeCreated() + 1;
        rollup.createNode(parent, keccak256(abi.encodePacked(BLOCK_HASH, _root(nodeNum))), uint64(block.number) + CONFIRM_BLOCKS);
    }

    function _nextBlock() private {
        vm.roll(block.number + 1);
    }

    function _root(uint64 nodeNum) private pure returns (bytes32) {
        return keccak256(abi.encode("send root", nodeNum));
    }

    function _verify(uint64 nodeNum) private view returns (bool, bool, uint64) {
        return verifier.verifyRoot(address(rollup), address(outbox), _root(nodeNum), nodeNum, BLOCK_HASH);
    }

    function _assertValid(uint64 nodeNum) private view {
        (bool valid, bool pending,) = _verify(nodeNum);
        assertTrue(valid, "expected valid");
        assertTrue(pending);
    }

    function _assertInvalid(uint64 nodeNum) private view {
        (bool valid,,) = _verify(nodeNum);
        assertFalse(valid, "expected invalid");
    }

    /// @dev A node on the chain of the newest node, so the pick is a plausible latest confirmed node.
    function _ancestorPick(uint64[] memory parentOf, uint64 n, uint8 pick) private pure returns (uint64 node) {
        node = n;
        uint256 steps = uint256(pick) % (n + 1);
        for (uint256 i = 0; i < steps && node != 0; ++i) {
            node = parentOf[node];
        }
        if (node == n) node = parentOf[n]; // keep at least one unresolved node
    }

    /// @return valid the reference answer
    /// @return onlyChildren every level on the path had exactly one child ever (the verifier must accept it)
    function _model(uint64[] memory parentOf, uint64 n, uint64 node, uint64 latestConfirmed, uint64 firstUnresolved)
        private
        pure
        returns (bool valid, bool onlyChildren)
    {
        if (node < firstUnresolved || node > n) return (false, false);
        onlyChildren = true;
        uint64 cursor = node;
        while (true) {
            uint64 p = parentOf[cursor];
            if (p != latestConfirmed && p < firstUnresolved) return (false, false);
            for (uint64 k = 1; k <= n; ++k) {
                if (k == cursor || parentOf[k] != p) continue;
                onlyChildren = false;
                if (k >= firstUnresolved) return (false, false);
            }
            if (p == latestConfirmed) return (true, onlyChildren);
            cursor = p;
        }
    }

}

