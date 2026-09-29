// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BoldRootVerifier} from "../verifiers/BoldRootVerifier.sol";
import {MockBoldRollup} from "./mocks/MockBoldRollup.sol";
import {BoldFixture} from "./utils/BoldFixture.sol";

/// @dev Unit tests for BoldRootVerifier.markRejected (direct and through a losing ancestor) and isRootRejected.
contract BoldRootVerifierRejectionTest is BoldFixture {
    // ================================================================ rejected-root behavior

    /// @dev Documents current behavior: a re-commit of a root whose earlier assertion lost is refused while it is
    ///      pending (rejectedRoots is keyed by sendRoot, not by assertion), and accepted once confirmed.
    function test_verifyRoot_pendingReCommitOfRejectedRootIsRefusedUntilConfirmed() public {
        (Posted memory lost, Posted memory winner) = _losingSiblingSetup();
        verifier.markRejected(address(rollup), lost.hash, lost.hash, winner.hash);
        // The honest chain re-commits ROOT_A on top of the winner (fresh, unchallenged parent).
        Posted memory recommit = _post(winner.hash, ROOT_A, 3);
        _register(recommit);

        _assertVerdict(ROOT_A, recommit.hash, false, true, 0);

        rollup.confirmAssertion(recommit.hash);
        _assertVerdict(ROOT_A, recommit.hash, true, false, 0);
    }

    // ================================================================ markRejected

    function test_markRejected_provesLossAgainstConfirmedSiblingAndEmits() public {
        (Posted memory ours, Posted memory sibling) = _losingSiblingSetup();

        vm.expectEmit(true, true, false, true, address(verifier));
        emit BoldRootVerifier.AssertionRejected(address(rollup), ours.hash, sibling.hash);
        vm.prank(stranger);
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);

        assertTrue(verifier.rejectedRoots(address(rollup), ROOT_A));
        assertFalse(verifier.rejectedRoots(address(rollup), ROOT_B));
    }

    function test_markRejected_revertsNotRegisteredWhenOursIsUnregistered() public {
        Posted memory ours = _post(GENESIS, ROOT_A, 1);
        Posted memory sibling = _post(GENESIS, ROOT_B, 2);
        _register(sibling);
        rollup.confirmAssertion(sibling.hash);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotRegistered.selector, ours.hash));
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);
    }

    function test_markRejected_revertsNotRegisteredWhenSiblingIsUnregistered() public {
        Posted memory ours = _post(GENESIS, ROOT_A, 1);
        Posted memory sibling = _post(GENESIS, ROOT_B, 2);
        _register(ours);
        rollup.confirmAssertion(sibling.hash);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotRegistered.selector, sibling.hash));
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);
    }

    function test_markRejected_revertsNotRegisteredForCompletelyUnknownHashes() public {
        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotRegistered.selector, bytes32(uint256(1))));
        verifier.markRejected(address(rollup), bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_markRejected_revertsNotSiblingsWhenParentsDiffer() public {
        Posted memory ours = _post(GENESIS, ROOT_A, 1);
        bytes32 otherParent = keccak256("another confirmed parent");
        rollup.setAssertion(otherParent, CONFIRMED, uint64(block.number), 0);
        Posted memory cousin = _post(otherParent, ROOT_B, 2);
        _register(ours);
        _register(cousin);
        rollup.confirmAssertion(cousin.hash);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotSiblings.selector, ours.hash, cousin.hash));
        verifier.markRejected(address(rollup), ours.hash, ours.hash, cousin.hash);
        assertFalse(verifier.rejectedRoots(address(rollup), ROOT_A));
    }

    function test_markRejected_revertsNotSiblingsWhenSameAssertion() public {
        Posted memory ours = _post(GENESIS, ROOT_A, 1);
        _register(ours);
        rollup.confirmAssertion(ours.hash);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotSiblings.selector, ours.hash, ours.hash));
        verifier.markRejected(address(rollup), ours.hash, ours.hash, ours.hash);
    }

    function test_markRejected_revertsSiblingNotConfirmedWhenSiblingIsPending() public {
        Posted memory ours = _post(GENESIS, ROOT_A, 1);
        Posted memory sibling = _post(GENESIS, ROOT_B, 2);
        _register(ours);
        _register(sibling);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.SiblingNotConfirmed.selector, sibling.hash));
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);
        assertFalse(verifier.rejectedRoots(address(rollup), ROOT_A));
    }

    function test_markRejected_revertsSiblingNotConfirmedWhenSiblingStatusIsNone() public {
        (Posted memory ours, Posted memory sibling) = _losingSiblingSetup();
        rollup.setStatus(sibling.hash, NONE);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.SiblingNotConfirmed.selector, sibling.hash));
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);
    }

    function test_markRejected_revertsNotPendingWhenOursIsAlreadyConfirmed() public {
        // Both flagged Confirmed can never happen on a real rollup; it still must not reject a confirmed assertion.
        (Posted memory ours, Posted memory sibling) = _losingSiblingSetup();
        rollup.setStatus(ours.hash, CONFIRMED);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotPending.selector, ours.hash));
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);
        assertFalse(verifier.rejectedRoots(address(rollup), ROOT_A));
    }

    function test_markRejected_revertsNotPendingWhenOursHasNoAssertionStatus() public {
        (Posted memory ours, Posted memory sibling) = _losingSiblingSetup();
        rollup.setStatus(ours.hash, NONE);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotPending.selector, ours.hash));
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);
    }

    function test_markRejected_canBeRepeatedWithoutChangingState() public {
        (Posted memory ours, Posted memory sibling) = _losingSiblingSetup();

        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);

        assertTrue(verifier.rejectedRoots(address(rollup), ROOT_A));
    }

    function test_markRejected_isKeyedByRollup() public {
        (Posted memory ours, Posted memory sibling) = _losingSiblingSetup();
        MockBoldRollup other = new MockBoldRollup(address(outbox), CONFIRM_PERIOD);

        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);

        assertTrue(verifier.rejectedRoots(address(rollup), ROOT_A));
        assertFalse(verifier.rejectedRoots(address(other), ROOT_A));
        assertFalse(verifier.isRootRejected(address(other), address(outbox), ROOT_A, 0));
    }

    function test_markRejected_rejectsDescendantThroughLosingAncestorAndEmits() public {
        (Posted memory loser, Posted memory winner) = _losingSiblingSetup();
        Posted memory child = _postRegistered(loser.hash, ROOT_C, 3);
        Posted memory grandchild = _postRegistered(child.hash, keccak256("grandchild root"), 4);

        vm.expectEmit(true, true, false, true, address(verifier));
        emit BoldRootVerifier.AssertionRejected(address(rollup), grandchild.hash, winner.hash);
        verifier.markRejected(address(rollup), grandchild.hash, loser.hash, winner.hash);

        assertTrue(verifier.rejectedRoots(address(rollup), grandchild.sendRoot));
        assertFalse(verifier.rejectedRoots(address(rollup), ROOT_A), "only the named assertion's root is marked");
        assertFalse(verifier.rejectedRoots(address(rollup), ROOT_C));
        assertTrue(verifier.isRootRejected(address(rollup), address(outbox), grandchild.sendRoot, 0));
        _assertVerdict(grandchild.sendRoot, grandchild.hash, false, true, 0);
    }

    function test_markRejected_revertsNotRegisteredWhenLosingAncestorIsUnregistered() public {
        Posted memory loser = _post(GENESIS, ROOT_A, 1); // never registered
        Posted memory winner = _postRegistered(GENESIS, ROOT_B, 2);
        Posted memory child = _postRegistered(loser.hash, ROOT_C, 3);
        rollup.confirmAssertion(winner.hash);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotRegistered.selector, loser.hash));
        verifier.markRejected(address(rollup), child.hash, loser.hash, winner.hash);
    }

    function test_markRejected_revertsNotSiblingsWhenLosingAncestorIsTheConfirmedSibling() public {
        (Posted memory loser, Posted memory winner) = _losingSiblingSetup();
        Posted memory child = _postRegistered(winner.hash, ROOT_C, 3);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotSiblings.selector, winner.hash, winner.hash));
        verifier.markRejected(address(rollup), child.hash, winner.hash, winner.hash);
        assertFalse(verifier.rejectedRoots(address(rollup), ROOT_C));
        assertFalse(verifier.rejectedRoots(address(rollup), loser.sendRoot));
    }

    function test_markRejected_revertsNotSiblingsWhenLosingAncestorAndSiblingHaveDifferentParents() public {
        (Posted memory loser,) = _losingSiblingSetup();
        Posted memory child = _postRegistered(loser.hash, ROOT_C, 3);
        bytes32 otherParent = keccak256("another confirmed parent");
        rollup.setAssertion(otherParent, CONFIRMED, uint64(block.number), 0);
        Posted memory cousin = _postRegistered(otherParent, keccak256("cousin root"), 5);
        rollup.confirmAssertion(cousin.hash);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotSiblings.selector, loser.hash, cousin.hash));
        verifier.markRejected(address(rollup), child.hash, loser.hash, cousin.hash);
    }

    function test_markRejected_revertsNotDescendantForAnAssertionOnTheWinningBranch() public {
        // The attack this blocks: reject a winner's own descendant by naming the loser as its "ancestor".
        (Posted memory loser, Posted memory winner) = _losingSiblingSetup();
        Posted memory winnersChild = _postRegistered(winner.hash, ROOT_C, 3);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotDescendant.selector, winnersChild.hash, loser.hash));
        verifier.markRejected(address(rollup), winnersChild.hash, loser.hash, winner.hash);
        assertFalse(verifier.rejectedRoots(address(rollup), ROOT_C));
    }

    function test_markRejected_revertsNotDescendantWhenAssertionIsTheConfirmedSiblingItself() public {
        (Posted memory loser, Posted memory winner) = _losingSiblingSetup();

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotDescendant.selector, winner.hash, loser.hash));
        verifier.markRejected(address(rollup), winner.hash, loser.hash, winner.hash);
    }

    function test_markRejected_revertsNotDescendantWhenTheAncestorIsBelowTheAssertion() public {
        // Arrange: P -> {C (losing), C' (confirmed)}; try to reject P by naming its own child as the ancestor
        Posted memory p = _postRegistered(GENESIS, ROOT_A, 1);
        Posted memory c = _postRegistered(p.hash, ROOT_B, 2);
        Posted memory cPrime = _postRegistered(p.hash, ROOT_C, 3);
        rollup.confirmAssertion(cPrime.hash);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotDescendant.selector, p.hash, c.hash));
        verifier.markRejected(address(rollup), p.hash, c.hash, cPrime.hash);
        assertFalse(verifier.rejectedRoots(address(rollup), ROOT_A));
    }

    function test_markRejected_revertsNotDescendantWhenAnIntermediateLinkIsUnregistered() public {
        (Posted memory loser, Posted memory winner) = _losingSiblingSetup();
        Posted memory middle = _post(loser.hash, ROOT_B, 6); // pending, never registered
        Posted memory leaf = _postRegistered(middle.hash, ROOT_C, 3);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotDescendant.selector, leaf.hash, loser.hash));
        verifier.markRejected(address(rollup), leaf.hash, loser.hash, winner.hash);

        _register(middle); // once the chain is complete the proof goes through
        verifier.markRejected(address(rollup), leaf.hash, loser.hash, winner.hash);
        assertTrue(verifier.rejectedRoots(address(rollup), ROOT_C));
    }

    function test_markRejected_revertsSiblingNotConfirmedForADescendantRejection() public {
        Posted memory loser = _postRegistered(GENESIS, ROOT_A, 1);
        Posted memory rival = _postRegistered(GENESIS, ROOT_B, 2); // still pending
        Posted memory child = _postRegistered(loser.hash, ROOT_C, 3);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.SiblingNotConfirmed.selector, rival.hash));
        verifier.markRejected(address(rollup), child.hash, loser.hash, rival.hash);
    }

    function test_markRejected_revertsNotPendingNamingTheLosingAncestor() public {
        (Posted memory loser, Posted memory winner) = _losingSiblingSetup();
        Posted memory child = _postRegistered(loser.hash, ROOT_C, 3);
        rollup.setStatus(loser.hash, CONFIRMED);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotPending.selector, loser.hash));
        verifier.markRejected(address(rollup), child.hash, loser.hash, winner.hash);
    }

    function test_markRejected_descendantProofIsBoundedByMaxPendingDepth() public {
        uint256 maxDepth = verifier.MAX_PENDING_DEPTH();
        bytes32[] memory h = _postChain(GENESIS, maxDepth + 1, true);
        Posted memory winner = _postRegistered(GENESIS, ROOT_B, 2);
        rollup.confirmAssertion(winner.hash);

        // the leaf is one link further from h[0] than the walk may go
        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.NotDescendant.selector, h[maxDepth], h[0]));
        verifier.markRejected(address(rollup), h[maxDepth], h[0], winner.hash);

        verifier.markRejected(address(rollup), h[maxDepth - 1], h[0], winner.hash);
        assertTrue(verifier.rejectedRoots(address(rollup), _chainRoot(maxDepth - 1)));
    }

    // ================================================================ isRootRejected

    function test_isRootRejected_falseUntilProvenRejected() public {
        _losingSiblingSetup();

        assertFalse(verifier.isRootRejected(address(rollup), address(outbox), ROOT_A, 0));
        assertFalse(verifier.isRootRejected(address(rollup), address(outbox), ROOT_A, 42));
    }

    function test_isRootRejected_trueOnlyForRejectedRootThatIsNotConfirmed() public {
        (Posted memory ours, Posted memory sibling) = _losingSiblingSetup();

        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);

        assertTrue(verifier.isRootRejected(address(rollup), address(outbox), ROOT_A, 0));
        assertFalse(verifier.isRootRejected(address(rollup), address(outbox), ROOT_B, 0)); // winner's root
        assertFalse(verifier.isRootRejected(address(rollup), address(outbox), ROOT_C, 0)); // unrelated root
    }

    function test_isRootRejected_falseWhenTheSameSendRootLaterConfirms() public {
        (Posted memory ours, Posted memory sibling) = _losingSiblingSetup();
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);
        assertTrue(verifier.isRootRejected(address(rollup), address(outbox), ROOT_A, 0));

        outbox.setRoot(ROOT_A, keccak256("l2 block")); // re-committed by the honest chain and confirmed

        assertFalse(verifier.isRootRejected(address(rollup), address(outbox), ROOT_A, 0));
    }

    function test_isRootRejected_falseWhenLoserAndWinnerShareTheSameSendRoot() public {
        // Arrange: siblings differing only in blockHash/history commit the same send root; the winner confirms it
        Posted memory ours = _post(GENESIS, ROOT_A, 1);
        Posted memory sibling = _post(GENESIS, ROOT_A, 2);
        _register(ours);
        _register(sibling);
        rollup.confirmAssertion(sibling.hash); // publishes ROOT_A to the Outbox

        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);

        assertTrue(verifier.rejectedRoots(address(rollup), ROOT_A));
        assertFalse(verifier.isRootRejected(address(rollup), address(outbox), ROOT_A, 0));
        _assertVerdict(ROOT_A, ours.hash, true, false, 0);
    }

    function test_isRootRejected_afterRejectionVerifyRootRefusesTheLosingAssertion() public {
        (Posted memory ours, Posted memory sibling) = _losingSiblingSetup();
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);

        _assertVerdict(ROOT_A, ours.hash, false, true, 0);
    }

    function testFuzz_isRootRejected_ignoresNodeNum(uint64 nodeNum) public {
        (Posted memory ours, Posted memory sibling) = _losingSiblingSetup();
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);

        assertTrue(verifier.isRootRejected(address(rollup), address(outbox), ROOT_A, nodeNum));
    }
}
