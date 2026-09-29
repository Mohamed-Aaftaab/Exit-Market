// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BoldAssertionState, BoldGlobalState} from "../interfaces/IBoldRollup.sol";
import {BoldRootVerifier} from "../verifiers/BoldRootVerifier.sol";
import {MockBoldRollup} from "./mocks/MockBoldRollup.sol";
import {BoldFixture} from "./utils/BoldFixture.sol";
import {ArbOneExitFixture as RealAssertion} from "./fork/ArbOneExitFixture.sol";

/// @dev Unit tests for BoldRootVerifier registration and root verification (including the pending-ancestor
///      walk) against a mock BOLD rollup. Rejection proofs live in BoldRootVerifierRejection.t.sol.
contract BoldRootVerifierTest is BoldFixture {
    // ================================================================ hashing

    function test_assertionHash_matchesRealArbitrumOneAssertion() public view {
        // Arrange / Act: preimage captured from a live Arbitrum One AssertionCreated event
        bytes32 h = rollup.assertionHashOf(
            RealAssertion.PARENT_ASSERTION_HASH, RealAssertion.afterState(), RealAssertion.INBOX_ACC
        );

        // Assert
        assertEq(h, RealAssertion.ASSERTION_HASH);
    }

    function test_register_recomputesTheRealArbitrumOneHash() public {
        // Arrange: the rollup knows ONLY the real hash, so registration succeeds iff the verifier's formula is right
        rollup.setAssertion(RealAssertion.ASSERTION_HASH, PENDING, uint64(block.number), 0);

        // Act
        bytes32 h = verifier.register(
            address(rollup), RealAssertion.PARENT_ASSERTION_HASH, RealAssertion.afterState(), RealAssertion.INBOX_ACC
        );

        // Assert
        assertEq(h, RealAssertion.ASSERTION_HASH);
        (, bytes32 sendRoot, bytes32 blockHash, bool exists) =
            verifier.assertions(address(rollup), RealAssertion.ASSERTION_HASH);
        assertTrue(exists);
        assertEq(sendRoot, RealAssertion.afterState().globalState.bytes32Vals[1]);
        assertEq(blockHash, RealAssertion.afterState().globalState.bytes32Vals[0]);
    }

    // ================================================================ register

    function test_register_recomputesHashAndStoresPreimageFields() public {
        Posted memory p = _post(GENESIS, ROOT_A, 1);

        bytes32 h = _register(p);

        assertEq(h, p.hash);
        (bytes32 parent, bytes32 sendRoot, bytes32 blockHash, bool exists) =
            verifier.assertions(address(rollup), p.hash);
        assertEq(parent, GENESIS);
        assertEq(sendRoot, ROOT_A);
        assertEq(blockHash, p.state.globalState.bytes32Vals[0]);
        assertTrue(exists);
    }

    function test_register_emitsAssertionRegistered() public {
        Posted memory p = _post(GENESIS, ROOT_A, 1);

        vm.expectEmit(true, true, false, true, address(verifier));
        emit BoldRootVerifier.AssertionRegistered(address(rollup), p.hash, ROOT_A);
        _register(p);
    }

    function test_register_revertsUnknownAssertionWhenRollupHasNeverSeenTheHash() public {
        Posted memory p = _post(GENESIS, ROOT_A, 1);
        MockBoldRollup other = new MockBoldRollup(address(outbox), CONFIRM_PERIOD);

        vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.UnknownAssertion.selector, p.hash));
        verifier.register(address(other), p.parent, p.state, p.inboxAcc);
        (,,, bool exists) = verifier.assertions(address(other), p.hash);
        assertFalse(exists);
    }

    function test_register_revertsUnknownAssertionWhenAnyPreimageFieldIsTampered() public {
        Posted memory p = _post(GENESIS, ROOT_A, 1);

        for (uint256 field = 0; field < 8; ++field) {
            (bytes32 parent, BoldAssertionState memory s, bytes32 acc) = _tamper(p, field);
            bytes32 tamperedHash = rollup.assertionHashOf(parent, s, acc);

            vm.expectRevert(abi.encodeWithSelector(BoldRootVerifier.UnknownAssertion.selector, tamperedHash));
            verifier.register(address(rollup), parent, s, acc);
        }
    }

    function test_register_acceptsPendingAndConfirmedAssertions() public {
        Posted memory pending = _post(GENESIS, ROOT_A, 1);
        Posted memory confirmed = _post(GENESIS, ROOT_B, 2);
        rollup.confirmAssertion(confirmed.hash);

        _register(pending);
        _register(confirmed);

        (,,, bool pendingExists) = verifier.assertions(address(rollup), pending.hash);
        (,,, bool confirmedExists) = verifier.assertions(address(rollup), confirmed.hash);
        assertTrue(pendingExists);
        assertTrue(confirmedExists);
    }

    function test_register_isPermissionlessAndIdempotent() public {
        Posted memory p = _post(GENESIS, ROOT_A, 1);

        vm.prank(stranger);
        bytes32 first = _register(p);
        bytes32 second = _register(p);

        assertEq(first, second);
        (bytes32 parent, bytes32 sendRoot,, bool exists) = verifier.assertions(address(rollup), p.hash);
        assertEq(parent, GENESIS);
        assertEq(sendRoot, ROOT_A);
        assertTrue(exists);
    }

    function test_register_isKeyedByRollupSoAnotherRollupCannotVouchForIt() public {
        // Arrange: a lookalike rollup that also "knows" the same preimage
        MockBoldRollup lookalike = new MockBoldRollup(address(outbox), CONFIRM_PERIOD);
        lookalike.setAssertion(GENESIS, CONFIRMED, uint64(block.number), 0);
        Posted memory p = _post(GENESIS, ROOT_A, 1);
        lookalike.createAssertion(p.parent, p.state, p.inboxAcc);

        // Act: registered under the lookalike only
        verifier.register(address(lookalike), p.parent, p.state, p.inboxAcc);

        // Assert: the real rollup does not trust it, the lookalike does
        _assertVerdict(ROOT_A, p.hash, false, true, 0);
        (bool valid,,) = verifier.verifyRoot(address(lookalike), address(outbox), ROOT_A, 0, p.hash);
        assertTrue(valid);
    }

    function testFuzz_register_recomputedHashMatchesRollupForAnyPreimage(
        bytes32 parent,
        bytes32 blockHash,
        bytes32 sendRoot,
        uint64 inboxPosition,
        uint64 positionInMessage,
        uint8 machineStatus,
        bytes32 endHistoryRoot,
        bytes32 inboxAcc
    ) public {
        BoldAssertionState memory s = BoldAssertionState({
            globalState: BoldGlobalState({
                bytes32Vals: [blockHash, sendRoot], u64Vals: [inboxPosition, positionInMessage]
            }),
            machineStatus: machineStatus,
            endHistoryRoot: endHistoryRoot
        });
        bytes32 expected = keccak256(abi.encodePacked(parent, keccak256(abi.encode(s)), inboxAcc));
        rollup.createAssertion(parent, s, inboxAcc);

        bytes32 h = verifier.register(address(rollup), parent, s, inboxAcc);

        assertEq(h, expected);
        (bytes32 storedParent, bytes32 storedRoot, bytes32 storedBlock, bool exists) =
            verifier.assertions(address(rollup), h);
        assertEq(storedParent, parent);
        assertEq(storedRoot, sendRoot);
        assertEq(storedBlock, blockHash);
        assertTrue(exists);
    }

    // ================================================================ verifyRoot: confirmed roots

    function test_verifyRoot_confirmedRootIsValidRegardlessOfWitness() public {
        outbox.setRoot(ROOT_A, keccak256("l2 block"));

        _assertVerdict(ROOT_A, bytes32(0), true, false, 0);
        _assertVerdict(ROOT_A, keccak256("garbage witness"), true, false, 0);
        // witness of an unrelated registered assertion changes nothing
        Posted memory other = _post(GENESIS, ROOT_B, 1);
        _register(other);
        _assertVerdict(ROOT_A, other.hash, true, false, 0);
    }

    function test_verifyRoot_confirmedRootStaysValidEvenIfAlsoMarkedRejected() public {
        // Arrange: ours (ROOT_A) lost to a sibling, then the SAME root is confirmed through another assertion
        (Posted memory ours, Posted memory sibling) = _losingSiblingSetup();
        verifier.markRejected(address(rollup), ours.hash, ours.hash, sibling.hash);
        outbox.setRoot(ROOT_A, keccak256("l2 block"));

        _assertVerdict(ROOT_A, ours.hash, true, false, 0);
    }

    function testFuzz_verifyRoot_confirmedRootIgnoresWitnessAndNodeNum(bytes32 root, bytes32 witness, uint64 nodeNum)
        public
    {
        outbox.setRoot(root, keccak256("l2 block"));

        (bool valid, bool pending, uint64 deadline) =
            verifier.verifyRoot(address(rollup), address(outbox), root, nodeNum, witness);

        assertTrue(valid);
        assertFalse(pending);
        assertEq(deadline, 0);
    }

    function testFuzz_verifyRoot_unknownRootWithUnknownWitnessIsNeverValid(
        bytes32 root,
        bytes32 witness,
        uint64 nodeNum
    ) public view {
        (bool valid, bool pending, uint64 deadline) =
            verifier.verifyRoot(address(rollup), address(outbox), root, nodeNum, witness);

        assertFalse(valid);
        assertTrue(pending);
        assertEq(deadline, 0);
    }

    // ================================================================ verifyRoot: pending assertions

    function test_verifyRoot_registeredUnchallengedPendingAssertionIsValidWithDeadline() public {
        Posted memory p = _post(GENESIS, ROOT_A, 1);
        _register(p);
        vm.roll(block.number + 500); // deadline is anchored to creation, not to "now"

        _assertVerdict(ROOT_A, p.hash, true, true, uint64(START_BLOCK) + CONFIRM_PERIOD);
    }

    function test_verifyRoot_deadlineFollowsRollupConfirmPeriod() public {
        Posted memory p = _post(GENESIS, ROOT_A, 1);
        _register(p);
        rollup.setConfirmPeriodBlocks(1_000);

        _assertVerdict(ROOT_A, p.hash, true, true, uint64(START_BLOCK) + 1_000);
    }

    function testFuzz_verifyRoot_deadlineIsCreatedAtPlusConfirmPeriod(uint40 createdAt, uint40 period) public {
        Posted memory p = _post(GENESIS, ROOT_A, 1);
        _register(p);
        rollup.setCreatedAtBlock(p.hash, createdAt);
        rollup.setConfirmPeriodBlocks(period);

        _assertVerdict(ROOT_A, p.hash, true, true, uint64(createdAt) + uint64(period));
    }

    function test_verifyRoot_ignoresNodeNum() public {
        Posted memory p = _post(GENESIS, ROOT_A, 1);
        _register(p);

        (bool v0, bool p0, uint64 d0) = verifier.verifyRoot(address(rollup), address(outbox), ROOT_A, 0, p.hash);
        (bool v1, bool p1, uint64 d1) =
            verifier.verifyRoot(address(rollup), address(outbox), ROOT_A, type(uint64).max, p.hash);

        assertEq(v0, v1);
        assertEq(p0, p1);
        assertEq(d0, d1);
        assertTrue(v0);
    }

    function test_verifyRoot_unregisteredWitnessIsInvalidEvenIfRollupHasIt() public {
        Posted memory p = _post(GENESIS, ROOT_A, 1); // pending on the rollup, but never registered

        _assertVerdict(ROOT_A, p.hash, false, true, 0);
    }

    function test_verifyRoot_witnessRegisteredForADifferentSendRootIsInvalid() public {
        // The attack this blocks: pass a genuine, unchallenged assertion hash to vouch for a forged root.
        Posted memory real = _post(GENESIS, ROOT_A, 1);
        _register(real);

        _assertVerdict(ROOT_B, real.hash, false, true, 0);
    }

    function test_verifyRoot_confirmedStatusWithoutOutboxRootIsInvalid() public {
        Posted memory p = _post(GENESIS, ROOT_A, 1);
        _register(p);
        rollup.setStatus(p.hash, CONFIRMED); // edge: confirmed but the Outbox never got the root

        _assertVerdict(ROOT_A, p.hash, false, true, 0);
    }

    function test_verifyRoot_noAssertionStatusIsInvalid() public {
        Posted memory p = _post(GENESIS, ROOT_A, 1);
        _register(p);
        rollup.setStatus(p.hash, NONE);

        _assertVerdict(ROOT_A, p.hash, false, true, 0);
    }

    // ================================================================ verifyRoot: disputes

    function test_verifyRoot_assertionWithRivalSiblingIsInvalidWhileDisputed() public {
        Posted memory ours = _post(GENESIS, ROOT_A, 1);
        _register(ours);
        _assertVerdict(ROOT_A, ours.hash, true, true, uint64(START_BLOCK) + CONFIRM_PERIOD);

        _post(GENESIS, ROOT_B, 2); // rival child of the same parent appears

        _assertVerdict(ROOT_A, ours.hash, false, true, 0);
    }

    function test_verifyRoot_parentSecondChildBlockAloneMakesItInvalid() public {
        Posted memory ours = _post(GENESIS, ROOT_A, 1);
        _register(ours);

        rollup.setSecondChildBlock(GENESIS, 1);

        _assertVerdict(ROOT_A, ours.hash, false, true, 0);
    }

    function test_verifyRoot_disputeResolvedByConfirmingOursIsValidAndConfirmed() public {
        Posted memory ours = _post(GENESIS, ROOT_A, 1);
        Posted memory rival = _post(GENESIS, ROOT_B, 2);
        _register(ours);
        _register(rival);
        _assertVerdict(ROOT_A, ours.hash, false, true, 0);

        rollup.confirmAssertion(ours.hash);

        _assertVerdict(ROOT_A, ours.hash, true, false, 0);
        _assertVerdict(ROOT_A, bytes32(0), true, false, 0);
    }

    function test_verifyRoot_disputeResolvedByConfirmingRivalKeepsOursInvalid() public {
        Posted memory ours = _post(GENESIS, ROOT_A, 1);
        Posted memory rival = _post(GENESIS, ROOT_B, 2);
        _register(ours);
        _register(rival);

        rollup.confirmAssertion(rival.hash);

        _assertVerdict(ROOT_A, ours.hash, false, true, 0);
        _assertVerdict(ROOT_B, rival.hash, true, false, 0);
    }

    function test_verifyRoot_secondSiblingCreatedFirstStillPoisonsBothChildren() public {
        Posted memory first = _post(GENESIS, ROOT_A, 1);
        Posted memory second = _post(GENESIS, ROOT_B, 2);
        _register(first);
        _register(second);

        _assertVerdict(ROOT_A, first.hash, false, true, 0);
        _assertVerdict(ROOT_B, second.hash, false, true, 0);
    }

    // ================================================================ verifyRoot: pending-ancestor walk

    function test_verifyRoot_multiLevelUnchallengedChainIsValidAtEveryLevel() public {
        // absolute rolls: the optimizer may fold repeated `block.number` reads inside one function
        Posted memory a1 = _postRegistered(GENESIS, ROOT_A, 1);
        vm.roll(START_BLOCK + 100);
        Posted memory a2 = _postRegistered(a1.hash, ROOT_B, 2);
        vm.roll(START_BLOCK + 200);
        Posted memory a3 = _postRegistered(a2.hash, ROOT_C, 3);

        // each deadline is anchored to that assertion's own creation block
        _assertVerdict(ROOT_A, a1.hash, true, true, uint64(START_BLOCK) + CONFIRM_PERIOD);
        _assertVerdict(ROOT_B, a2.hash, true, true, uint64(START_BLOCK) + 100 + CONFIRM_PERIOD);
        _assertVerdict(ROOT_C, a3.hash, true, true, uint64(START_BLOCK) + 200 + CONFIRM_PERIOD);
    }

    function test_verifyRoot_descendantOfDisputedAncestorIsRejected() public {
        // Arrange: GENESIS -> loser P -> child C; C itself has no rival, so it was acceptable until P's level forked
        Posted memory loser = _postRegistered(GENESIS, ROOT_A, 1);
        Posted memory child = _postRegistered(loser.hash, ROOT_C, 3);
        _assertVerdict(ROOT_C, child.hash, true, true, uint64(START_BLOCK) + CONFIRM_PERIOD);

        // Act: a rival to P appears, then wins
        Posted memory winner = _postRegistered(GENESIS, ROOT_B, 2);
        _assertVerdict(ROOT_A, loser.hash, false, true, 0);
        _assertVerdict(ROOT_C, child.hash, false, true, 0);
        rollup.confirmAssertion(winner.hash);

        // Assert: still rejected after the dispute is decided against P
        _assertVerdict(ROOT_C, child.hash, false, true, 0);
        _assertVerdict(ROOT_B, winner.hash, true, false, 0);
    }

    function test_verifyRoot_disputeAtAnyLevelInvalidatesEverythingBelowIt() public {
        Posted memory a1 = _postRegistered(GENESIS, ROOT_A, 1);
        Posted memory a2 = _postRegistered(a1.hash, ROOT_B, 2);
        Posted memory a3 = _postRegistered(a2.hash, ROOT_C, 3);

        // rival of a3: only a3 is affected
        _post(a2.hash, keccak256("rival of a3"), 40);
        _assertVerdict(ROOT_A, a1.hash, true, true, uint64(START_BLOCK) + CONFIRM_PERIOD);
        _assertVerdict(ROOT_B, a2.hash, true, true, uint64(START_BLOCK) + CONFIRM_PERIOD);
        _assertVerdict(ROOT_C, a3.hash, false, true, 0);

        // rival of a2: a2 and a3 are affected
        _post(a1.hash, keccak256("rival of a2"), 41);
        _assertVerdict(ROOT_A, a1.hash, true, true, uint64(START_BLOCK) + CONFIRM_PERIOD);
        _assertVerdict(ROOT_B, a2.hash, false, true, 0);
        _assertVerdict(ROOT_C, a3.hash, false, true, 0);

        // rival of a1: everything is affected
        _post(GENESIS, keccak256("rival of a1"), 42);
        _assertVerdict(ROOT_A, a1.hash, false, true, 0);
        _assertVerdict(ROOT_B, a2.hash, false, true, 0);
        _assertVerdict(ROOT_C, a3.hash, false, true, 0);
    }

    function test_verifyRoot_descendantBecomesValidOnceTheDisputedAncestorIsConfirmed() public {
        Posted memory ours = _postRegistered(GENESIS, ROOT_A, 1);
        Posted memory child = _postRegistered(ours.hash, ROOT_C, 3);
        _post(GENESIS, ROOT_B, 2); // rival to ours: the whole branch is on hold
        _assertVerdict(ROOT_C, child.hash, false, true, 0);

        rollup.confirmAssertion(ours.hash); // our branch wins

        // the walk now ends at a confirmed parent whose own children are unrivaled
        _assertVerdict(ROOT_C, child.hash, true, true, uint64(START_BLOCK) + CONFIRM_PERIOD);
        _assertVerdict(ROOT_A, ours.hash, true, false, 0);
    }

    function test_verifyRoot_everyPendingAncestorMustBeRegistered() public {
        bytes32[] memory h = _postChain(GENESIS, 3, false);
        uint64 deadline = uint64(START_BLOCK) + CONFIRM_PERIOD;

        _register(_posted(h, 2, GENESIS));
        _assertVerdict(_chainRoot(2), h[2], false, true, 0); // leaf only

        _register(_posted(h, 0, GENESIS));
        _assertVerdict(_chainRoot(2), h[2], false, true, 0); // leaf + top, middle link missing

        _register(_posted(h, 1, GENESIS));
        _assertVerdict(_chainRoot(2), h[2], true, true, deadline); // complete chain
    }

    function test_verifyRoot_confirmedAncestorNeedsNoRegistration() public {
        Posted memory a1 = _post(GENESIS, ROOT_A, 1); // never registered
        rollup.confirmAssertion(a1.hash);
        Posted memory a2 = _postRegistered(a1.hash, ROOT_B, 2);

        _assertVerdict(ROOT_B, a2.hash, true, true, uint64(START_BLOCK) + CONFIRM_PERIOD);
    }

    function test_verifyRoot_parentWithNoAssertionStatusIsInvalid() public {
        Posted memory a1 = _postRegistered(GENESIS, ROOT_A, 1);
        Posted memory a2 = _postRegistered(a1.hash, ROOT_B, 2);
        rollup.setStatus(a1.hash, NONE);

        _assertVerdict(ROOT_B, a2.hash, false, true, 0);
    }

    function test_verifyRoot_pendingChainDepthIsBoundedByMaxPendingDepth() public {
        uint256 maxDepth = verifier.MAX_PENDING_DEPTH();
        assertEq(maxDepth, 512);
        uint64 deadline = uint64(START_BLOCK) + CONFIRM_PERIOD;

        bytes32[] memory h = _postChain(GENESIS, maxDepth + 1, true);

        _assertVerdict(_chainRoot(0), h[0], true, true, deadline);
        _assertVerdict(_chainRoot(maxDepth - 1), h[maxDepth - 1], true, true, deadline); // 512 pending levels: ok
        _assertVerdict(_chainRoot(maxDepth), h[maxDepth], false, true, 0); // 513 pending levels: refused
    }

    /// @dev Real Arbitrum One data: the captured chain of pending assertions (latest confirmed -> target) is
    ///      hash-linked, the mock accepts it, and the verifier walks the whole real chain.
    function test_verifyRoot_realArbitrumOnePendingChainIsWalkedToTheTarget() public {
        RealAssertion.ChainLink[] memory links = RealAssertion.chain();
        assertGt(links.length, 1);
        rollup.setAssertion(links[0].parent, CONFIRMED, uint64(block.number), 0);

        bytes32 previous = links[0].parent;
        for (uint256 i = 0; i < links.length; ++i) {
            assertEq(links[i].parent, previous, "chain must be hash-linked");
            previous = rollup.createAssertion(links[i].parent, links[i].afterState, links[i].inboxAcc);
            verifier.register(address(rollup), links[i].parent, links[i].afterState, links[i].inboxAcc);
        }
        assertEq(previous, RealAssertion.ASSERTION_HASH);

        bytes32 realRoot = RealAssertion.claim().sendRoot;
        _assertVerdict(realRoot, RealAssertion.ASSERTION_HASH, true, true, uint64(START_BLOCK) + CONFIRM_PERIOD);
    }

    // ================================================================ helpers

    function _chainRoot(uint256 i) private pure returns (bytes32) {
        return keccak256(abi.encode("chain root", i));
    }

    /// @dev Posts `length` linked pending assertions under `parent` (link i commits `_chainRoot(i)`), optionally
    ///      registering each. Returns their hashes, oldest first.
    function _postChain(bytes32 parent, uint256 length, bool register) private returns (bytes32[] memory hashes) {
        hashes = new bytes32[](length);
        bytes32 cursor = parent;
        for (uint256 i = 0; i < length; ++i) {
            Posted memory p = _post(cursor, _chainRoot(i), 1000 + i);
            if (register) _register(p);
            hashes[i] = p.hash;
            cursor = p.hash;
        }
    }

    /// @dev Rebuilds the Posted record of `_postChain` link `i` (needed to register it later).
    function _posted(bytes32[] memory hashes, uint256 i, bytes32 chainParent) private view returns (Posted memory p) {
        p.parent = i == 0 ? chainParent : hashes[i - 1];
        p.sendRoot = _chainRoot(i);
        p.state = _state(p.sendRoot, 1000 + i);
        p.inboxAcc = keccak256(abi.encode("inbox", 1000 + i));
        p.hash = hashes[i];
        require(rollup.assertionHashOf(p.parent, p.state, p.inboxAcc) == p.hash, "chain link mismatch");
    }

    /// @dev Returns the preimage of `p` with exactly one field changed (0..7 covers every field).
    function _tamper(Posted memory p, uint256 field)
        private
        pure
        returns (bytes32 parent, BoldAssertionState memory s, bytes32 acc)
    {
        // Deep copy: memory structs are references, and each field must be tampered in isolation.
        parent = p.parent;
        s = BoldAssertionState({
            globalState: BoldGlobalState({
                bytes32Vals: [p.state.globalState.bytes32Vals[0], p.state.globalState.bytes32Vals[1]],
                u64Vals: [p.state.globalState.u64Vals[0], p.state.globalState.u64Vals[1]]
            }),
            machineStatus: p.state.machineStatus,
            endHistoryRoot: p.state.endHistoryRoot
        });
        acc = p.inboxAcc;
        if (field == 0) parent = ~parent;
        else if (field == 1) s.globalState.bytes32Vals[0] = ~s.globalState.bytes32Vals[0];
        else if (field == 2) s.globalState.bytes32Vals[1] = ~s.globalState.bytes32Vals[1];
        else if (field == 3) s.globalState.u64Vals[0] += 1;
        else if (field == 4) s.globalState.u64Vals[1] += 1;
        else if (field == 5) s.machineStatus += 1;
        else if (field == 6) s.endHistoryRoot = ~s.endHistoryRoot;
        else acc = ~acc;
    }
}
