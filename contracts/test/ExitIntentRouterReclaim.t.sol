// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IExitIntentRouter} from "../interfaces/IExitIntentRouter.sol";
import {IntentFixture} from "./utils/IntentFixture.sol";

/// @dev reclaim(): permissionless return of a router-owned exit to its proven child-chain sender.
contract ExitIntentRouterReclaimTest is IntentFixture {
    function test_reclaim_returnsExitToProvenSenderWhenCalledByAnyone() public {
        Withdrawal[] memory ws = _intents(3);
        Withdrawal memory w = ws[2];
        bytes32 id = _id(w);

        vm.expectEmit(true, true, false, true, address(router));
        emit IExitIntentRouter.ExitReclaimed(id, user);
        vm.prank(stranger);
        router.reclaim(w.gateway, w.exitNum, w.claim);

        assertEq(_ownerOf(w), user, "exit now belongs to the proven sender");
        _execute(w); // outbox executes: the user is paid the face value directly
        assertEq(usdg.balanceOf(user), AMOUNT);
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    function test_reclaim_letsSellerSellTheReturnedExitToVaultThemselves() public {
        Withdrawal[] memory ws = _intents(1);
        uint256 price = vault.quote(_record(ws[0]));
        router.reclaim(ws[0].gateway, ws[0].exitNum, ws[0].claim);

        _sellTo(ws[0], user, address(vault), price);

        assertEq(usdg.balanceOf(user), price - _fee(price));
        assertEq(_ownerOf(ws[0]), address(vault));
    }

    function test_reclaim_worksForWethStyleLeaf() public {
        wethLeaves = true;
        Withdrawal[] memory ws = _intents(2);

        router.reclaim(ws[1].gateway, ws[1].exitNum, ws[1].claim);

        assertEq(_ownerOf(ws[1]), user);
    }

    function test_reclaim_worksWithConfirmedRootEvenAfterNodeIsNoLongerUnresolved() public {
        Withdrawal[] memory ws = _intents(2);
        _confirm(ws[0]);
        rollup.setFirstUnresolvedNode(NODE + 50);

        router.reclaim(ws[0].gateway, ws[0].exitNum, ws[0].claim);

        assertEq(_ownerOf(ws[0]), user);
    }

    function test_reclaim_worksAfterMarketDisallowsTheGateway() public {
        Withdrawal[] memory ws = _intents(1);
        vm.prank(owner);
        market.disallowGateway(address(gateway));

        router.reclaim(ws[0].gateway, ws[0].exitNum, ws[0].claim);

        assertEq(_ownerOf(ws[0]), user, "rescue must keep working for a known-but-disallowed gateway");
    }

    function test_reclaim_revertsProofMismatchWhenFromIsForged() public {
        Withdrawal[] memory forged = _intents(2);
        forged[1].claim.from = attacker; // try to redirect the victim's exit to the attacker

        vm.expectPartialRevert(IExitIntentRouter.ProofMismatch.selector);
        vm.prank(attacker);
        router.reclaim(forged[1].gateway, forged[1].exitNum, forged[1].claim);

        assertEq(_ownerOf(forged[1]), address(router));
    }

    function test_reclaim_revertsProofMismatchWhenAmountOrExitNumIsTampered() public {
        Withdrawal[] memory ws = _intents(2);
        Withdrawal[] memory bigger = _intents(2);
        bigger[0].claim.amount = AMOUNT * 10;

        vm.expectPartialRevert(IExitIntentRouter.ProofMismatch.selector);
        router.reclaim(bigger[0].gateway, bigger[0].exitNum, bigger[0].claim);

        vm.expectPartialRevert(IExitIntentRouter.ProofMismatch.selector);
        router.reclaim(ws[0].gateway, ws[1].exitNum, ws[0].claim); // proof of exit 1 presented as exit 2
    }

    function test_reclaim_revertsInvalidRootWhenNodeWasRejected() public {
        Withdrawal[] memory ws = _intents(1);
        rollup.setFirstUnresolvedNode(NODE + 1);

        vm.expectRevert(
            abi.encodeWithSelector(IExitIntentRouter.InvalidRoot.selector, ws[0].claim.sendRoot, ws[0].claim.nodeNum)
        );
        router.reclaim(ws[0].gateway, ws[0].exitNum, ws[0].claim);

        assertEq(_ownerOf(ws[0]), address(router));
    }

    function test_reclaim_revertsInvalidRootWhenNodeCommitmentDoesNotMatch() public {
        Withdrawal[] memory ws = _intents(1);
        ws[0].claim.blockHash = keccak256("not the committed block hash");

        vm.expectRevert(
            abi.encodeWithSelector(IExitIntentRouter.InvalidRoot.selector, ws[0].claim.sendRoot, ws[0].claim.nodeNum)
        );
        router.reclaim(ws[0].gateway, ws[0].exitNum, ws[0].claim);
    }

    function test_reclaim_revertsGatewayUnknownForNeverAllowedGateway() public {
        Withdrawal[] memory ws = _intents(1);
        address unknown = makeAddr("unknownGateway");

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.GatewayUnknown.selector, unknown));
        router.reclaim(unknown, ws[0].exitNum, ws[0].claim);
    }

    function test_reclaim_revertsNotRouterExitForClaimOwnedByUser() public {
        Withdrawal[] memory ws = _createWithdrawals(1, user, AMOUNT);

        vm.expectRevert(IExitIntentRouter.NotRouterExit.selector);
        router.reclaim(ws[0].gateway, ws[0].exitNum, ws[0].claim);
    }

    function test_reclaim_revertsOnceTheExitWasSoldOrAlreadyReclaimed() public {
        Withdrawal[] memory ws = _intents(2);
        _settleSigned(ws[0], _order(ws[0], 0, RELAYER_FEE));
        router.reclaim(ws[1].gateway, ws[1].exitNum, ws[1].claim);

        vm.expectRevert("NOT_EXPECTED_SENDER"); // sold: the vault owns it now
        router.reclaim(ws[0].gateway, ws[0].exitNum, ws[0].claim);
        vm.expectRevert("NOT_EXPECTED_SENDER"); // already reclaimed
        router.reclaim(ws[1].gateway, ws[1].exitNum, ws[1].claim);

        assertEq(_ownerOf(ws[0]), address(vault));
        assertEq(_ownerOf(ws[1]), user);
    }

    function test_settle_revertsOnceAnyoneReclaimedTheExit() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);
        vm.prank(stranger);
        router.reclaim(ws[0].gateway, ws[0].exitNum, ws[0].claim); // permissionless cancel: no funds at risk

        vm.expectRevert("NOT_EXPECTED_SENDER");
        _settleAs(relayer, ws[0], o, sig);

        assertEq(_ownerOf(ws[0]), user);
        assertEq(usdg.balanceOf(address(router)), 0);
    }
}
