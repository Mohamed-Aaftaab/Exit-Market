// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PayoutProof} from "../interfaces/IExitMarket.sol";
import {IExitIntentRouter} from "../interfaces/IExitIntentRouter.sol";
import {MockERC20} from "./mocks/MockArbitrum.sol";
import {IntentFixture} from "./utils/IntentFixture.sol";

/// @dev recoverExecuted(): an exit executed through the Outbox while the router still owned it pays the router;
///      anyone may forward exactly that exit's tokens to its proven sender, once, and only with a payout proof
///      that binds the spent slot to THIS item under a confirmed root.
contract ExitIntentRouterRecoverTest is IntentFixture {
    // ================================================================ helpers

    function _payout(Withdrawal memory w) private pure returns (PayoutProof memory) {
        return PayoutProof(w.claim.index, w.claim.sendRoot, w.claim.proof);
    }

    function _recoverAs(address who, Withdrawal memory w, PayoutProof memory p) private {
        vm.prank(who);
        router.recoverExecuted(w.gateway, w.exitNum, w.claim, p);
    }

    function _itemOf(Withdrawal memory w) private view returns (bytes32) {
        return _record(w).itemHash;
    }

    /// @dev Root becomes confirmed and the Outbox executes `w` while the router still owns it.
    function _confirmAndExecute(Withdrawal memory w) private {
        _confirm(w);
        _execute(w);
    }

    function _notPaidOut(uint256 index) private pure returns (bytes memory) {
        return abi.encodeWithSelector(IExitIntentRouter.ExitNotPaidOut.selector, index);
    }

    // ================================================================ happy paths

    function test_recoverExecuted_forwardsExactlyTheClaimAmountToProvenSenderForAnyCaller() public {
        Withdrawal[] memory ws = _intents(3);
        _confirmAndExecute(ws[0]); // one confirmed root covers the whole tree
        _execute(ws[1]);
        assertEq(usdg.balanceOf(address(router)), 2 * AMOUNT, "both executed exits paid the router");
        bytes32 id = _id(ws[1]);
        bytes32 item = _itemOf(ws[1]);
        bytes32 otherItem = _itemOf(ws[0]);

        vm.expectEmit(true, true, false, true, address(router));
        emit IExitIntentRouter.ExecutedExitRecovered(id, user, address(usdg), AMOUNT);
        _recoverAs(stranger, ws[1], _payout(ws[1]));

        assertEq(usdg.balanceOf(user), AMOUNT, "sender receives exactly the exit amount");
        assertEq(usdg.balanceOf(address(router)), AMOUNT, "only this exit's amount left the router");
        assertEq(usdg.balanceOf(stranger), 0, "the caller earns nothing");
        assertTrue(router.recovered(item));
        assertFalse(router.recovered(otherItem));

        _recoverAs(user, ws[0], _payout(ws[0])); // the other exit is independent
        assertEq(usdg.balanceOf(user), 2 * AMOUNT);
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    function test_recoverExecuted_revertsAlreadyRecoveredOnSecondCallFromAnyone() public {
        Withdrawal[] memory ws = _intents(3);
        _confirmAndExecute(ws[1]);
        _execute(ws[0]); // bait: the router holds more than this exit's amount
        bytes32 item = _itemOf(ws[1]);
        _recoverAs(stranger, ws[1], _payout(ws[1]));

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.AlreadyRecovered.selector, item));
        _recoverAs(stranger, ws[1], _payout(ws[1]));
        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.AlreadyRecovered.selector, item));
        _recoverAs(relayer, ws[1], _payout(ws[1]));

        assertEq(usdg.balanceOf(user), AMOUNT);
        assertEq(usdg.balanceOf(address(router)), AMOUNT, "bait balance untouched");
    }

    function test_recoverExecuted_worksForWethStyleLeaf() public {
        wethLeaves = true;
        Withdrawal[] memory ws = _intents(2);
        _confirmAndExecute(ws[1]);

        _recoverAs(stranger, ws[1], _payout(ws[1]));

        assertEq(usdg.balanceOf(user), AMOUNT);
        assertEq(usdg.balanceOf(address(router)), 0);
        assertTrue(router.recovered(_itemOf(ws[1])));
    }

    function test_recoverExecuted_forwardsTheClaimTokenNotTheMarketPaymentToken() public {
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        exitToken = other;
        Withdrawal[] memory ws = _intents(1);
        _confirmAndExecute(ws[0]);
        usdg.mint(address(router), 5e6); // unrelated payment-token balance

        _recoverAs(stranger, ws[0], _payout(ws[0]));

        assertEq(other.balanceOf(user), AMOUNT);
        assertEq(other.balanceOf(address(router)), 0);
        assertEq(usdg.balanceOf(address(router)), 5e6);
        assertEq(usdg.balanceOf(user), 0);
    }

    function test_recoverExecuted_worksWhenCanonicalIndexDiffersFromProvenIndex() public {
        Withdrawal[] memory ws = _intents(2);
        Withdrawal memory w = ws[1];
        // The item also sits at index 4 under a different, confirmed root, and THAT slot is the one executed.
        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmedAt(w, 4);
        gateway.simulateExecute(outbox, 4, w.exitNum, address(router), usdg, AMOUNT);
        assertFalse(outbox.isSpent(w.claim.index), "the index the claim was proven at is not spent");

        vm.expectRevert(_notPaidOut(w.claim.index));
        _recoverAs(stranger, w, PayoutProof(w.claim.index, root2, proof2));

        _recoverAs(stranger, w, PayoutProof(4, root2, proof2));

        assertEq(usdg.balanceOf(user), AMOUNT);
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    function test_recoverExecuted_worksWithClaimReprovenAgainstCanonicalRootAfterOriginalNodeRejected() public {
        Withdrawal[] memory ws = _intents(2);
        Withdrawal memory w = ws[1];
        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmedAt(w, 4);
        rollup.setFirstUnresolvedNode(NODE + 1); // original node rejected
        gateway.simulateExecute(outbox, 4, w.exitNum, address(router), usdg, AMOUNT);
        bytes memory staleClaimError =
            abi.encodeWithSelector(IExitIntentRouter.InvalidRoot.selector, w.claim.sendRoot, w.claim.nodeNum);

        vm.expectRevert(staleClaimError); // the stale claim can no longer be proven
        _recoverAs(stranger, w, PayoutProof(4, root2, proof2));

        w.claim.sendRoot = root2;
        w.claim.index = 4;
        w.claim.proof = proof2;
        _recoverAs(stranger, w, PayoutProof(4, root2, proof2));

        assertEq(usdg.balanceOf(user), AMOUNT);
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    function test_recoverExecuted_worksAfterMarketDisallowsTheGateway() public {
        Withdrawal[] memory ws = _intents(1);
        _confirmAndExecute(ws[0]);
        vm.prank(owner);
        market.disallowGateway(address(gateway));

        _recoverAs(stranger, ws[0], _payout(ws[0]));

        assertEq(usdg.balanceOf(user), AMOUNT);
    }

    // ================================================================ payout proof

    function test_recoverExecuted_revertsExitNotPaidOutWhenExitIsUnspent() public {
        Withdrawal[] memory ws = _intents(2);
        _confirm(ws[1]);
        usdg.mint(address(router), AMOUNT); // bait: router holds tokens, but this exit was never executed

        vm.expectRevert(_notPaidOut(ws[1].claim.index));
        _recoverAs(stranger, ws[1], _payout(ws[1]));

        assertEq(usdg.balanceOf(user), 0);
        assertEq(usdg.balanceOf(address(router)), AMOUNT);
        assertFalse(router.recovered(_itemOf(ws[1])));
    }

    function test_recoverExecuted_revertsExitNotPaidOutWhenSpentButRootIsNotConfirmed() public {
        Withdrawal[] memory ws = _intents(2);
        _execute(ws[1]); // slot spent, but the root the claim was proven against is still only pending

        vm.expectRevert(_notPaidOut(ws[1].claim.index));
        _recoverAs(stranger, ws[1], _payout(ws[1]));

        assertEq(usdg.balanceOf(user), 0);
        assertEq(usdg.balanceOf(address(router)), AMOUNT);
    }

    function test_recoverExecuted_revertsExitNotPaidOutForFakeLeafAliasingARealSpentSlot() public {
        Withdrawal[] memory real = _intents(1);
        // Attacker's fake exit sits at the same index 0 of a different, still-pending node.
        Withdrawal[] memory fake = _createFrom(gateway, NODE + 1, 50, 1, attacker, address(router), AMOUNT);
        _confirmAndExecute(real[0]); // real slot 0 is spent and confirmed; AMOUNT sits in the router
        assertEq(fake[0].claim.index, real[0].claim.index);

        vm.expectRevert(_notPaidOut(0));
        _recoverAs(attacker, fake[0], PayoutProof(0, real[0].claim.sendRoot, real[0].claim.proof));
        vm.expectRevert(_notPaidOut(0));
        _recoverAs(attacker, fake[0], _payout(fake[0])); // its own root is not confirmed

        assertEq(usdg.balanceOf(attacker), 0);
        assertEq(usdg.balanceOf(address(router)), AMOUNT);
        _recoverAs(stranger, real[0], _payout(real[0])); // the real sender still recovers
        assertEq(usdg.balanceOf(user), AMOUNT);
    }

    function test_recoverExecuted_revertsExitNotPaidOutWhenPayoutBelongsToAnotherExitOrIsTampered() public {
        Withdrawal[] memory ws = _intents(2);
        _confirmAndExecute(ws[0]);
        _execute(ws[1]);
        bytes32[] memory badProof = new bytes32[](ws[1].claim.proof.length);
        badProof[0] = bytes32(uint256(1));

        vm.expectRevert(_notPaidOut(ws[0].claim.index));
        _recoverAs(stranger, ws[1], _payout(ws[0])); // exit 0's spent slot presented for exit 1
        vm.expectRevert(_notPaidOut(ws[1].claim.index));
        _recoverAs(stranger, ws[1], PayoutProof(ws[1].claim.index, ws[1].claim.sendRoot, badProof));

        assertEq(usdg.balanceOf(user), 0);
        assertEq(usdg.balanceOf(address(router)), 2 * AMOUNT);
    }

    // ================================================================ ownership and claim checks

    function test_recoverExecuted_revertsNotRouterExitOnceSoldAndLeavesOtherFunds() public {
        Withdrawal[] memory ws = _intents(2);
        _settleSigned(ws[0], _order(ws[0], 0, RELAYER_FEE)); // vault owns exit 0 now
        _confirmAndExecute(ws[0]); // pays the vault
        _execute(ws[1]); // pays the router
        uint256 userBefore = usdg.balanceOf(user);

        vm.expectRevert(IExitIntentRouter.NotRouterExit.selector);
        _recoverAs(stranger, ws[0], _payout(ws[0]));

        assertEq(usdg.balanceOf(address(router)), AMOUNT, "exit 1's funds are not usable for exit 0");
        assertEq(usdg.balanceOf(user), userBefore);
        _recoverAs(stranger, ws[1], _payout(ws[1]));
        assertEq(usdg.balanceOf(user), userBefore + AMOUNT);
    }

    function test_recoverExecuted_revertsNotRouterExitOnceReclaimedAndLeavesOtherFunds() public {
        Withdrawal[] memory ws = _intents(2);
        _reclaimAs(user, ws[0]); // seller owns exit 0 now
        _confirmAndExecute(ws[0]); // pays the seller directly
        _execute(ws[1]); // pays the router
        assertEq(usdg.balanceOf(user), AMOUNT);

        vm.expectRevert(IExitIntentRouter.NotRouterExit.selector);
        _recoverAs(stranger, ws[0], _payout(ws[0]));

        assertEq(usdg.balanceOf(address(router)), AMOUNT);
        assertEq(usdg.balanceOf(user), AMOUNT, "no double payment for exit 0");
    }

    function test_recoverExecuted_revertsNotRouterExitForClaimOwnedByUser() public {
        Withdrawal[] memory ws = _createWithdrawals(1, user, AMOUNT);
        _confirmAndExecute(ws[0]);

        vm.expectRevert(IExitIntentRouter.NotRouterExit.selector);
        _recoverAs(stranger, ws[0], _payout(ws[0]));
    }

    function test_recoverExecuted_revertsGatewayUnknownForNeverAllowedGateway() public {
        Withdrawal[] memory ws = _intents(1);
        _confirmAndExecute(ws[0]);
        address unknown = makeAddr("unknownGateway");
        PayoutProof memory p = _payout(ws[0]);

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.GatewayUnknown.selector, unknown));
        vm.prank(stranger);
        router.recoverExecuted(unknown, ws[0].exitNum, ws[0].claim, p);
    }

    function test_recoverExecuted_revertsProofMismatchWhenFromIsForged() public {
        Withdrawal[] memory real = _intents(2);
        _confirmAndExecute(real[1]); // stranded AMOUNT in the router
        Withdrawal[] memory forged = _intents(2);
        forged[1].claim.from = attacker; // steal attempt: same leaf, other beneficiary

        vm.expectPartialRevert(IExitIntentRouter.ProofMismatch.selector);
        _recoverAs(attacker, forged[1], _payout(forged[1]));

        assertEq(usdg.balanceOf(attacker), 0);
        assertEq(usdg.balanceOf(address(router)), AMOUNT);
    }

    function test_recoverExecuted_revertsProofMismatchWhenAmountIsInflated() public {
        Withdrawal[] memory ws = _intents(2);
        _confirmAndExecute(ws[1]);
        usdg.mint(address(router), 10 * AMOUNT); // plenty of bait
        ws[1].claim.amount = AMOUNT * 10;

        vm.expectPartialRevert(IExitIntentRouter.ProofMismatch.selector);
        _recoverAs(stranger, ws[1], _payout(ws[1]));

        assertEq(usdg.balanceOf(user), 0);
    }

    function test_recoverExecuted_revertsInvalidRootWhenNodeRejectedAndRootNotConfirmed() public {
        Withdrawal[] memory ws = _intents(2);
        _execute(ws[1]);
        rollup.setFirstUnresolvedNode(NODE + 1);

        vm.expectRevert(
            abi.encodeWithSelector(IExitIntentRouter.InvalidRoot.selector, ws[1].claim.sendRoot, ws[1].claim.nodeNum)
        );
        _recoverAs(stranger, ws[1], _payout(ws[1]));

        assertEq(usdg.balanceOf(address(router)), AMOUNT);
    }

    // ================================================================ fuzz

    function testFuzz_recoverExecuted_paysExactlyTheAmountAndLeavesOtherRouterFunds(uint256 amount, uint256 donation)
        public
    {
        amount = bound(amount, 1, 1_000_000e6);
        donation = bound(donation, 0, 1_000_000e6);
        Withdrawal[] memory ws = _createFrom(gateway, NODE, 1, 1, user, address(router), amount);
        usdg.mint(address(router), donation);
        _confirmAndExecute(ws[0]);

        _recoverAs(stranger, ws[0], _payout(ws[0]));

        assertEq(usdg.balanceOf(user), amount);
        assertEq(usdg.balanceOf(address(router)), donation);
    }
}
