// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IExitIntentRouter} from "../interfaces/IExitIntentRouter.sol";
import {IntentFixture} from "./utils/IntentFixture.sol";

/// @dev reclaim(): the proven sender can take a router-owned exit back at any time; anyone else only once
///      RECLAIM_GRACE has passed since the withdrawal (so relayers are not griefed by third-party reclaims).
contract ExitIntentRouterReclaimTest is IntentFixture {
    function _lockedError(Withdrawal memory w) private pure returns (bytes memory) {
        return abi.encodeWithSelector(IExitIntentRouter.ReclaimLocked.selector, _unlockTime(w));
    }

    // ================================================================ who may reclaim, and when

    function test_reclaim_graceConstantIsThreeDays() public view {
        assertEq(router.RECLAIM_GRACE(), 3 days);
    }

    function test_reclaim_sellerReclaimsImmediatelyAndIsPaidTheFaceValueOnExecution() public {
        Withdrawal[] memory ws = _intents(3);
        Withdrawal memory w = ws[2];
        bytes32 id = _id(w);
        assertLt(block.timestamp, _unlockTime(w), "still inside the grace period");

        vm.expectEmit(true, true, false, true, address(router));
        emit IExitIntentRouter.ExitReclaimed(id, user);
        _reclaimAs(user, w);

        assertEq(_ownerOf(w), user, "exit now belongs to the proven sender");
        _execute(w); // outbox executes: the user is paid the face value directly
        assertEq(usdg.balanceOf(user), AMOUNT);
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    function test_reclaim_revertsReclaimLockedForThirdPartyBeforeGrace() public {
        Withdrawal[] memory ws = _intents(1);
        bytes memory locked = _lockedError(ws[0]);

        vm.expectRevert(locked);
        _reclaimAs(stranger, ws[0]);
        vm.expectRevert(locked);
        _reclaimAs(attacker, ws[0]);
        vm.expectRevert(locked);
        _reclaimAs(relayer, ws[0]);

        assertEq(_ownerOf(ws[0]), address(router), "a third party cannot cancel the pending order");
    }

    function test_reclaim_thirdPartyLockedAttemptDoesNotStopRelayerSettling() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);
        uint256 received = _received(ws[0]);

        vm.expectRevert(_lockedError(ws[0]));
        _reclaimAs(attacker, ws[0]); // griefing attempt
        uint256 proceeds = _settleAs(relayer, ws[0], o, sig);

        assertEq(proceeds, received - RELAYER_FEE);
        assertEq(_ownerOf(ws[0]), address(vault));
        assertEq(usdg.balanceOf(user), received - RELAYER_FEE);
    }

    function test_reclaim_thirdPartyCanReclaimExactlyAtUnlockTimeAndNotBefore() public {
        Withdrawal[] memory ws = _intents(1);
        uint256 unlock = _unlockTime(ws[0]);
        bytes32 id = _id(ws[0]);

        vm.warp(unlock - 1);
        vm.expectRevert(_lockedError(ws[0]));
        _reclaimAs(stranger, ws[0]);

        vm.warp(unlock);
        vm.expectEmit(true, true, false, true, address(router));
        emit IExitIntentRouter.ExitReclaimed(id, user);
        _reclaimAs(stranger, ws[0]);

        assertEq(_ownerOf(ws[0]), user, "the exit still goes to the proven sender, not the caller");
    }

    function test_reclaim_lockIsPerExitFromItsOwnL2Timestamp() public {
        Withdrawal[] memory ws = _intents(3); // l2Timestamp = base + index, so unlock times differ by one second
        assertLt(_unlockTime(ws[0]), _unlockTime(ws[2]));

        vm.warp(_unlockTime(ws[0]));
        _reclaimAs(stranger, ws[0]);
        vm.expectRevert(_lockedError(ws[2]));
        _reclaimAs(stranger, ws[2]);

        assertEq(_ownerOf(ws[0]), user);
        assertEq(_ownerOf(ws[2]), address(router));
    }

    function test_reclaim_cannotBypassLockByClaimingAnEarlierL2Timestamp() public {
        Withdrawal[] memory ws = _intents(1);
        ws[0].claim.l2Timestamp = 1; // makes unlock time long past, but the leaf commits to the real timestamp

        vm.expectPartialRevert(IExitIntentRouter.ProofMismatch.selector);
        _reclaimAs(stranger, ws[0]);

        assertEq(_ownerOf(ws[0]), address(router));
    }

    function test_reclaim_afterGraceAnyoneCanCancelSoRelayerSettleFails() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        o.deadline = uint64(_unlockTime(ws[0]) + 1 days); // long-lived order still outstanding
        bytes memory sig = _signed(o);
        vm.warp(_unlockTime(ws[0]));
        _reclaimAs(stranger, ws[0]);

        vm.expectRevert("NOT_EXPECTED_SENDER");
        _settleAs(relayer, ws[0], o, sig);

        assertEq(_ownerOf(ws[0]), user);
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    function test_reclaim_settleStillWorksAfterGraceIfNobodyReclaimed() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        o.deadline = uint64(_unlockTime(ws[0]) + 1 days);
        bytes memory sig = _signed(o);
        vm.warp(_unlockTime(ws[0]) + 1);

        _settleAs(relayer, ws[0], o, sig);

        assertEq(_ownerOf(ws[0]), address(vault));
    }

    // ================================================================ proof and state checks

    function test_reclaim_letsSellerSellTheReturnedExitToVaultThemselves() public {
        Withdrawal[] memory ws = _intents(1);
        uint256 price = vault.quote(_record(ws[0]));
        _reclaimAs(user, ws[0]);

        _sellTo(ws[0], user, address(vault), price);

        assertEq(usdg.balanceOf(user), price - _fee(price));
        assertEq(_ownerOf(ws[0]), address(vault));
    }

    function test_reclaim_worksForWethStyleLeaf() public {
        wethLeaves = true;
        Withdrawal[] memory ws = _intents(2);

        _reclaimAs(user, ws[1]);

        assertEq(_ownerOf(ws[1]), user);
    }

    function test_reclaim_worksWithConfirmedRootEvenAfterNodeIsNoLongerUnresolved() public {
        Withdrawal[] memory ws = _intents(2);
        _confirm(ws[0]);
        rollup.setFirstUnresolvedNode(NODE + 50);

        _reclaimAs(user, ws[0]);

        assertEq(_ownerOf(ws[0]), user);
    }

    function test_reclaim_worksAfterMarketDisallowsTheGateway() public {
        Withdrawal[] memory ws = _intents(1);
        vm.prank(owner);
        market.disallowGateway(address(gateway));

        _reclaimAs(user, ws[0]);

        assertEq(_ownerOf(ws[0]), user, "rescue must keep working for a known-but-disallowed gateway");
    }

    function test_reclaim_revertsProofMismatchWhenFromIsForged() public {
        Withdrawal[] memory forged = _intents(2);
        forged[1].claim.from = attacker; // try to redirect the victim's exit to the attacker

        vm.expectPartialRevert(IExitIntentRouter.ProofMismatch.selector);
        _reclaimAs(attacker, forged[1]); // the forged sender passes the sender check, the proof stops it

        vm.warp(_unlockTime(forged[1]));
        vm.expectPartialRevert(IExitIntentRouter.ProofMismatch.selector);
        _reclaimAs(stranger, forged[1]); // and so does a third party after the grace period

        assertEq(_ownerOf(forged[1]), address(router));
    }

    function test_reclaim_revertsProofMismatchWhenAmountOrExitNumIsTampered() public {
        Withdrawal[] memory ws = _intents(2);
        Withdrawal[] memory bigger = _intents(2);
        bigger[0].claim.amount = AMOUNT * 10;

        vm.expectPartialRevert(IExitIntentRouter.ProofMismatch.selector);
        _reclaimAs(user, bigger[0]);

        vm.expectPartialRevert(IExitIntentRouter.ProofMismatch.selector);
        vm.prank(user);
        router.reclaim(ws[0].gateway, ws[1].exitNum, ws[0].claim); // proof of exit 1 presented as exit 2
    }

    function test_reclaim_revertsInvalidRootWhenNodeWasRejected() public {
        Withdrawal[] memory ws = _intents(1);
        rollup.setFirstUnresolvedNode(NODE + 1);

        vm.expectRevert(
            abi.encodeWithSelector(IExitIntentRouter.InvalidRoot.selector, ws[0].claim.sendRoot, ws[0].claim.nodeNum)
        );
        _reclaimAs(user, ws[0]);

        assertEq(_ownerOf(ws[0]), address(router));
    }

    function test_reclaim_revertsInvalidRootWhenNodeCommitmentDoesNotMatch() public {
        Withdrawal[] memory ws = _intents(1);
        ws[0].claim.blockHash = keccak256("not the committed block hash");

        vm.expectRevert(
            abi.encodeWithSelector(IExitIntentRouter.InvalidRoot.selector, ws[0].claim.sendRoot, ws[0].claim.nodeNum)
        );
        _reclaimAs(user, ws[0]);
    }

    function test_reclaim_revertsGatewayUnknownForNeverAllowedGateway() public {
        Withdrawal[] memory ws = _intents(1);
        address unknown = makeAddr("unknownGateway");

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.GatewayUnknown.selector, unknown));
        vm.prank(user);
        router.reclaim(unknown, ws[0].exitNum, ws[0].claim);
    }

    function test_reclaim_revertsNotRouterExitForClaimOwnedByUser() public {
        Withdrawal[] memory ws = _createWithdrawals(1, user, AMOUNT);

        vm.expectRevert(IExitIntentRouter.NotRouterExit.selector);
        _reclaimAs(user, ws[0]);
    }

    function test_reclaim_revertsOnceTheExitWasSoldOrAlreadyReclaimed() public {
        Withdrawal[] memory ws = _intents(2);
        _settleSigned(ws[0], _order(ws[0], 0, RELAYER_FEE));
        _reclaimAs(user, ws[1]);

        vm.expectRevert("NOT_EXPECTED_SENDER"); // sold: the vault owns it now
        _reclaimAs(user, ws[0]);
        vm.expectRevert("NOT_EXPECTED_SENDER"); // already reclaimed
        _reclaimAs(user, ws[1]);

        assertEq(_ownerOf(ws[0]), address(vault));
        assertEq(_ownerOf(ws[1]), user);
    }

    function test_reclaim_revertsSettleOnceSellerReclaimed() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);
        _reclaimAs(user, ws[0]); // the seller cancels their own order

        vm.expectRevert("NOT_EXPECTED_SENDER");
        _settleAs(relayer, ws[0], o, sig);

        assertEq(_ownerOf(ws[0]), user);
        assertEq(usdg.balanceOf(address(router)), 0);
    }
}
