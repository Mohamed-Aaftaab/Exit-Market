// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ExitLeaf} from "../libraries/ExitLeaf.sol";
import {ExitClaim, ExitRecord, IExitMarket, IRootVerifier} from "../interfaces/IExitMarket.sol";
import {ExitMarket} from "../ExitMarket.sol";
import {LegacyRootVerifier} from "../verifiers/LegacyRootVerifier.sol";
import {MockBridge, MockERC20, MockExtendedGateway, MockInbox, MockLegacyRollup, MockOutbox} from "./mocks/MockArbitrum.sol";
import {ExitFixture} from "./utils/ExitFixture.sol";
import {TestBuyer} from "./utils/TestBuyers.sol";

contract ExitMarketTest is ExitFixture {
    uint256 private constant PRICE = 9_900e6;

    // ============================================================ 1. proof verification

    function test_list_acceptsGenuineExitAndRecordsListing() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(3, seller, AMOUNT);

        bytes32 id = _list(ws[1], seller, PRICE);

        IExitMarket.Listing memory l = market.getListing(id);
        assertEq(uint8(l.status), uint8(IExitMarket.Status.Listed));
        assertEq(l.seller, seller);
        assertEq(l.price, PRICE);
        assertEq(l.feeBps, FEE_BPS);
        assertEq(l.exit.gateway, address(gateway));
        assertEq(l.exit.exitNum, 2);
        assertEq(l.exit.amount, AMOUNT);
        assertEq(l.exit.index, 1);
        assertEq(l.exit.nodeNum, NODE);
        assertTrue(l.exit.pending);
        assertEq(l.exit.deadlineBlock, rollup.getNode(NODE).deadlineBlock);
        assertEq(_ownerOf(ws[1]), address(market));
    }

    function test_list_worksForEveryLeafInAnUnbalancedTree() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(5, seller, AMOUNT);
        for (uint256 i = 0; i < 5; ++i) {
            _list(ws[i], seller, PRICE);
            assertEq(_ownerOf(ws[i]), address(market));
        }
    }

    function test_list_rejectsInflatedAmount() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        ws[0].claim.amount = AMOUNT + 1;

        vm.expectPartialRevert(IExitMarket.ProofMismatch.selector);
        _list(ws[0], seller, PRICE);
    }

    function test_list_rejectsWrongToken() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        ws[0].claim.l1Token = address(0xBAD);

        vm.expectPartialRevert(IExitMarket.ProofMismatch.selector);
        _list(ws[0], seller, PRICE);
    }

    function test_list_rejectsWrongFrom() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        ws[0].claim.from = stranger;

        vm.expectPartialRevert(IExitMarket.ProofMismatch.selector);
        _list(ws[0], seller, PRICE);
    }

    function test_list_rejectsWrongExitNum() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        // Seller holds exit 2 too, but presents exit 1's claim for it.
        ExitFixture.Withdrawal memory forged = ws[0];
        forged.exitNum = ws[1].exitNum;

        vm.expectPartialRevert(IExitMarket.ProofMismatch.selector);
        _list(forged, seller, PRICE);
    }

    function test_list_rejectsFabricatedLeafFields() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        ws[0].claim.l2Block += 1;
        vm.expectPartialRevert(IExitMarket.ProofMismatch.selector);
        _list(ws[0], seller, PRICE);

        ws[0].claim.l2Block -= 1;
        ws[0].claim.l1Block += 1;
        vm.expectPartialRevert(IExitMarket.ProofMismatch.selector);
        _list(ws[0], seller, PRICE);

        ws[0].claim.l1Block -= 1;
        ws[0].claim.l2Timestamp += 1;
        vm.expectPartialRevert(IExitMarket.ProofMismatch.selector);
        _list(ws[0], seller, PRICE);
    }

    function test_list_rejectsTamperedProofAndSendRoot() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(4, seller, AMOUNT);
        ExitFixture.Withdrawal memory w = ws[2];

        w.claim.proof[0] = bytes32(uint256(1));
        vm.expectPartialRevert(IExitMarket.ProofMismatch.selector);
        _list(w, seller, PRICE);

        ws = _createWithdrawals(4, seller, AMOUNT);
        ws[2].claim.sendRoot = bytes32(uint256(2));
        vm.expectPartialRevert(IExitMarket.ProofMismatch.selector);
        _list(ws[2], seller, PRICE);
    }

    function test_list_rejectsExitTheSellerDoesNotHold() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);

        // A stranger cannot even trigger the hook: the gateway rejects non-owners.
        vm.expectRevert("NOT_EXPECTED_SENDER");
        _list(ws[0], stranger, PRICE);

        // Calling the hook directly through an allowed gateway is impossible; a direct call is rejected.
        vm.expectRevert(abi.encodeWithSelector(IExitMarket.GatewayNotAllowed.selector, stranger));
        vm.prank(stranger);
        market.onExitTransfer(seller, 1, _hookData(IExitMarket.Action.LIST, ws[0].claim, abi.encode(PRICE, uint64(block.timestamp + 1))));
    }

    // ============================================================ 2. padded index

    function test_list_rejectsPaddedIndexWithEmptyProof() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        assertEq(ws[0].claim.proof.length, 0);
        ws[0].claim.index = 1;

        vm.expectRevert(abi.encodeWithSelector(ExitLeaf.PathNotMinimal.selector, 1, 0));
        _list(ws[0], seller, PRICE);
    }

    function test_list_rejectsPaddedIndexWithNonEmptyProof() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(4, seller, AMOUNT);
        uint256 padded = ws[1].claim.index + 4;
        ws[1].claim.index = padded;

        vm.expectRevert(abi.encodeWithSelector(ExitLeaf.PathNotMinimal.selector, padded, 2));
        _list(ws[1], seller, PRICE);
    }

    function test_sellToBuyer_rejectsPaddedIndex() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        TestBuyer tb = new TestBuyer(usdg, 1);
        ws[0].claim.index = ws[0].claim.index + 2;

        vm.expectRevert(abi.encodeWithSelector(ExitLeaf.PathNotMinimal.selector, 2, 1));
        _sellTo(ws[0], seller, address(tb), 0);
    }

    function test_paddedIndexCannotHideAnExecutedExit() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        outbox.markSpent(0);
        // Same merkle path, but index 2**255 would read an unset isSpent slot.
        ws[0].claim.index = uint256(1) << 200;

        vm.expectPartialRevert(ExitLeaf.PathNotMinimal.selector);
        _list(ws[0], seller, PRICE);
    }

    // ============================================================ 3. spent exits

    function test_list_rejectsAlreadySpentExit() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(3, seller, AMOUNT);
        outbox.markSpent(ws[1].claim.index);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ExitAlreadySpent.selector, ws[1].claim.index));
        _list(ws[1], seller, PRICE);
    }

    function test_sellToBuyer_rejectsAlreadySpentExit() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(3, seller, AMOUNT);
        TestBuyer tb = new TestBuyer(usdg, 1);
        usdg.mint(address(tb), 1);
        outbox.markSpent(ws[2].claim.index);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ExitAlreadySpent.selector, ws[2].claim.index));
        _sellTo(ws[2], seller, address(tb), 0);
    }

    // ============================================================ 4. executed while listed

    function test_buy_revertsWhenExitExecutedAfterListing() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _execute(ws[0]);
        _fund(buyer, address(market), PRICE);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ExitAlreadySpent.selector, ws[0].claim.index));
        vm.prank(buyer);
        market.buy(id, PRICE);

        assertEq(usdg.balanceOf(buyer), PRICE);
    }

    function test_settle_paysSellerWhenExitExecutedWhileListed() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        exitToken = other;
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _execute(ws[0]);
        assertEq(other.balanceOf(address(market)), AMOUNT);

        vm.prank(stranger);
        market.settle(id);

        assertEq(other.balanceOf(seller), AMOUNT);
        assertEq(other.balanceOf(address(market)), 0);
        assertEq(uint8(market.getListing(id).status), uint8(IExitMarket.Status.Settled));
    }

    function test_settle_revertsWhenExitNotSpent() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[1], seller, PRICE);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ExitNotSpent.selector, ws[1].claim.index));
        market.settle(id);
    }

    function test_settle_cannotBeCalledTwice() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _execute(ws[0]);
        market.settle(id);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.NotListed.selector, id));
        market.settle(id);
    }

    function test_settle_leavesAccruedFeesUntouchedWhenL1TokenIsPaymentToken() public {
        // l1Token == payment token (USDG): the market's balance mixes fees and exit proceeds.
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 idSold = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), PRICE);
        vm.prank(buyer);
        market.buy(idSold, PRICE);
        uint256 fee = _fee(PRICE);
        assertEq(usdg.balanceOf(address(market)), fee);

        bytes32 idSettled = _list(ws[1], seller, PRICE);
        _execute(ws[1]);
        assertEq(usdg.balanceOf(address(market)), fee + AMOUNT);
        market.settle(idSettled);

        assertEq(usdg.balanceOf(address(market)), fee, "fees must survive settle");
        assertEq(usdg.balanceOf(seller), (PRICE - fee) + AMOUNT);

        market.withdrawFees();
        assertEq(usdg.balanceOf(feeRecipient), fee);
        assertEq(usdg.balanceOf(address(market)), 0);
    }

    function test_cancel_paysSellerWhenExitAlreadyExecuted() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _execute(ws[0]);

        vm.prank(seller);
        market.cancel(id);

        assertEq(usdg.balanceOf(seller), AMOUNT);
        assertEq(uint8(market.getListing(id).status), uint8(IExitMarket.Status.Settled));
    }

    function test_isExitSpentAndLive_trackOutboxState() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _list(ws[0], seller, PRICE);
        ExitRecord memory rec = _record(ws[0]);

        assertTrue(market.isExitLive(rec));
        assertFalse(market.isExitSpent(rec));

        _execute(ws[0]);

        assertFalse(market.isExitLive(rec));
        assertTrue(market.isExitSpent(rec));
    }

    // ============================================================ 5. root authenticity / node rejection

    function test_buy_revertsInvalidRootWhenNodeRejectedAfterListing() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), PRICE);

        rollup.setFirstUnresolvedNode(NODE + 1);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        vm.prank(buyer);
        market.buy(id, PRICE);
    }

    function test_cancel_stillReturnsExitAfterNodeRejected() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        rollup.setFirstUnresolvedNode(NODE + 1);

        vm.prank(seller);
        market.cancel(id);

        assertEq(_ownerOf(ws[0]), seller);
        assertEq(uint8(market.getListing(id).status), uint8(IExitMarket.Status.Cancelled));
        assertFalse(market.isExitLive(_record(ws[0])));
    }

    function test_list_rejectsNodeAlreadyRejectedAtListTime() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        rollup.setFirstUnresolvedNode(NODE + 1);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        _list(ws[0], seller, PRICE);
    }

    function test_list_rejectsNodeBeyondLatestNodeCreated() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        rollup.setLatestNodeCreated(NODE - 1);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        _list(ws[0], seller, PRICE);
    }

    function test_list_rejectsNodeWhoseConfirmDataDoesNotMatch() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        ws[0].claim.blockHash = bytes32(uint256(0xdead));

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        _list(ws[0], seller, PRICE);
    }

    function test_list_rejectsUnrelatedNodeNumber() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        rollup.setLatestNodeCreated(NODE + 5);
        ws[0].claim.nodeNum = NODE + 3; // in range, but its confirmData commits to nothing

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE + 3));
        _list(ws[0], seller, PRICE);
    }

    function test_list_acceptsConfirmedRootWithoutAnyRollupNode() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _confirm(ws[0]);
        rollup.setFirstUnresolvedNode(NODE + 50); // node data is irrelevant once confirmed
        ws[0].claim.nodeNum = 0;
        ws[0].claim.blockHash = bytes32(0);

        bytes32 id = _list(ws[0], seller, PRICE);

        IExitMarket.Listing memory l = market.getListing(id);
        assertFalse(l.exit.pending);
        assertEq(l.exit.deadlineBlock, 0);
        assertEq(_ownerOf(ws[0]), address(market));
    }

    function test_buy_succeedsAfterListedPendingRootLaterConfirms() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _confirm(ws[0]);
        rollup.setFirstUnresolvedNode(NODE + 1); // node resolved and pruned from the unresolved range
        _fund(buyer, address(market), PRICE);

        vm.prank(buyer);
        market.buy(id, PRICE);

        assertEq(_ownerOf(ws[0]), buyer);
    }

    // ============================================================ 6. gateways

    function test_onExitTransfer_rejectsCallerThatIsNotAnAllowedGateway() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes memory data = _hookData(IExitMarket.Action.LIST, ws[0].claim, abi.encode(PRICE, uint64(block.timestamp + 1 days)));

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.GatewayNotAllowed.selector, stranger));
        vm.prank(stranger);
        market.onExitTransfer(seller, 1, data);
    }

    function test_list_rejectsDisallowedGateway() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        vm.prank(owner);
        market.disallowGateway(address(gateway));

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.GatewayNotAllowed.selector, address(gateway)));
        _list(ws[0], seller, PRICE);
    }

    function test_cancelAndSettle_keepWorkingAfterGatewayDisallowed() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 idCancel = _list(ws[0], seller, PRICE);
        bytes32 idSettle = _list(ws[1], seller, PRICE);
        vm.prank(owner);
        market.disallowGateway(address(gateway));

        vm.prank(seller);
        market.cancel(idCancel);
        assertEq(_ownerOf(ws[0]), seller);

        _execute(ws[1]);
        market.settle(idSettle);
        assertEq(usdg.balanceOf(seller), AMOUNT);
        assertFalse(market.getGatewayConfig(address(gateway)).allowed);
        assertTrue(market.getGatewayConfig(address(gateway)).known);
    }

    function test_allowGateway_snapshotsSourcesDerivedFromGateway() public view {
        IExitMarket.GatewayConfig memory cfg = market.getGatewayConfig(address(gateway));

        assertEq(cfg.childGateway, CHILD_GATEWAY);
        assertEq(cfg.outbox, address(outbox));
        assertEq(cfg.rollup, address(rollup));
        assertEq(address(cfg.verifier), address(verifier));
        assertTrue(cfg.allowed);
        assertTrue(cfg.known);
    }

    function test_allowGateway_revertsWhenOutboxNotAllowedByBridge() public {
        MockExtendedGateway gw2 = new MockExtendedGateway(address(0xC2), address(inbox));
        bridge.setAllowedOutbox(address(outbox), false);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.OutboxNotAllowed.selector, address(outbox)));
        vm.prank(owner);
        market.allowGateway(address(gw2), verifier);
    }

    function test_allowGateway_reAllowWithSameSourcesSucceeds() public {
        vm.startPrank(owner);
        market.disallowGateway(address(gateway));
        market.allowGateway(address(gateway), verifier);
        vm.stopPrank();

        assertTrue(market.getGatewayConfig(address(gateway)).allowed);
    }

    function test_allowGateway_reAllowWithDifferentVerifierReverts() public {
        LegacyRootVerifier other = new LegacyRootVerifier();
        vm.startPrank(owner);
        market.disallowGateway(address(gateway));

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.GatewaySourcesChanged.selector, address(gateway)));
        market.allowGateway(address(gateway), IRootVerifier(address(other)));
        vm.stopPrank();
    }

    function test_allowGateway_reAllowAfterInboxSwappedToNewOutboxReverts() public {
        MockOutbox outbox2 = new MockOutbox();
        MockLegacyRollup rollup2 = new MockLegacyRollup(address(outbox2));
        MockBridge bridge2 = new MockBridge(address(rollup2));
        MockInbox inbox2 = new MockInbox(address(bridge2));
        vm.prank(owner);
        market.disallowGateway(address(gateway));
        gateway.setInbox(address(inbox2)); // proxy upgrade swaps verification sources

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.GatewaySourcesChanged.selector, address(gateway)));
        vm.prank(owner);
        market.allowGateway(address(gateway), verifier);
    }

    function test_unknownGateway_isRejectedByViews() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        rec.gateway = stranger;

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.GatewayUnknown.selector, stranger));
        market.isExitSpent(rec);
    }

    // ============================================================ 7. id collisions

    function test_listingIds_doNotCollideAcrossGatewaysWithSameExitNum() public {
        MockExtendedGateway gw2 = new MockExtendedGateway(address(0xC2), address(inbox));
        vm.prank(owner);
        market.allowGateway(address(gw2), verifier);
        ExitFixture.Withdrawal[] memory a = _createOn(gateway, NODE, 1, 1, seller, AMOUNT);
        ExitFixture.Withdrawal[] memory b = _createOn(gw2, NODE + 1, 1, 1, seller, 2 * AMOUNT);
        assertEq(a[0].exitNum, b[0].exitNum);

        bytes32 idA = _list(a[0], seller, PRICE);
        bytes32 idB = _list(b[0], seller, PRICE * 2);

        assertTrue(idA != idB);
        assertEq(market.getListing(idA).exit.gateway, address(gateway));
        assertEq(market.getListing(idB).exit.gateway, address(gw2));
        assertEq(market.getListing(idA).exit.amount, AMOUNT);
        assertEq(market.getListing(idB).exit.amount, 2 * AMOUNT);

        _fund(buyer, address(market), PRICE);
        vm.prank(buyer);
        market.buy(idA, PRICE);
        assertEq(uint8(market.getListing(idA).status), uint8(IExitMarket.Status.Sold));
        assertEq(uint8(market.getListing(idB).status), uint8(IExitMarket.Status.Listed));
    }

    function test_listingId_isKeccakOfGatewayExitNumDestination() public view {
        assertEq(market.listingId(address(gateway), 7, seller), keccak256(abi.encode(address(gateway), uint256(7), seller)));
    }

    // ============================================================ 8. reentrancy

    function test_sellToBuyer_maliciousBuyerReenteringBuyReverts() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 otherId = _list(ws[1], seller, PRICE);
        TestBuyer tb = new TestBuyer(usdg, PRICE);
        usdg.mint(address(tb), PRICE);
        tb.setReentry(address(market), abi.encodeCall(market.buy, (otherId, PRICE)), false);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        _sellTo(ws[0], seller, address(tb), 0);
    }

    function test_sellToBuyer_maliciousBuyerReenteringCancelReverts() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 otherId = _list(ws[1], seller, PRICE);
        TestBuyer tb = new TestBuyer(usdg, PRICE);
        usdg.mint(address(tb), PRICE);
        tb.setReentry(address(market), abi.encodeCall(market.cancel, (otherId)), false);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        _sellTo(ws[0], seller, address(tb), 0);
    }

    function test_sellToBuyer_reentryIsBlockedByGuardEvenWhenBuyerSwallowsTheFailure() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 otherId = _list(ws[1], seller, PRICE);
        TestBuyer tb = new TestBuyer(usdg, PRICE);
        usdg.mint(address(tb), PRICE);
        tb.setReentry(address(market), abi.encodeCall(market.cancel, (otherId)), true);

        _sellTo(ws[0], seller, address(tb), 0);

        assertTrue(tb.reentered());
        assertTrue(tb.reentryBlocked());
        assertEq(tb.reentryError(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(uint8(market.getListing(otherId).status), uint8(IExitMarket.Status.Listed));
    }

    // ============================================================ 10. pricing, fees, admin

    function test_buy_revertsWhenPriceAboveMax() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), PRICE);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.PriceAboveMax.selector, PRICE, PRICE - 1));
        vm.prank(buyer);
        market.buy(id, PRICE - 1);
    }

    function test_buy_revertsForUnknownAndAlreadySoldListings() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), 2 * PRICE);
        vm.prank(buyer);
        market.buy(id, PRICE);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.NotListed.selector, id));
        vm.prank(buyer);
        market.buy(id, PRICE);

        bytes32 bogus = keccak256("bogus");
        vm.expectRevert(abi.encodeWithSelector(IExitMarket.NotListed.selector, bogus));
        vm.prank(buyer);
        market.buy(bogus, PRICE);
    }

    function test_buy_revertsAfterExpiry() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes32 id = _listUntil(ws[0], seller, PRICE, expiry);
        _fund(buyer, address(market), PRICE);
        vm.warp(uint256(expiry) + 1);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ListingExpired.selector, id));
        vm.prank(buyer);
        market.buy(id, PRICE);
    }

    function test_list_revertsOnZeroPriceAndBadExpiry() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);

        vm.expectRevert(IExitMarket.ZeroPrice.selector);
        _list(ws[0], seller, 0);

        vm.expectRevert(IExitMarket.BadExpiry.selector);
        _listUntil(ws[0], seller, PRICE, uint64(block.timestamp));
    }

    function test_buy_usesFeeSnapshotWhenFeeChangesAfterListing() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        vm.prank(owner);
        market.setFee(200, feeRecipient);
        _fund(buyer, address(market), PRICE);

        vm.prank(buyer);
        market.buy(id, PRICE);

        assertEq(usdg.balanceOf(seller), PRICE - _fee(PRICE));
        assertEq(usdg.balanceOf(address(market)), _fee(PRICE));

        bytes32 id2 = _list(ws[1], seller, PRICE);
        assertEq(market.getListing(id2).feeBps, 200);
    }

    function test_setFee_revertsAboveMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(IExitMarket.FeeTooHigh.selector, uint16(201)));
        vm.prank(owner);
        market.setFee(201, feeRecipient);

        assertEq(market.MAX_FEE_BPS(), 200);
        vm.prank(owner);
        market.setFee(200, feeRecipient); // boundary accepted
    }

    function test_constructor_revertsWhenFeeAboveMaximum() public {
        ExitMarketDeployer deployer = new ExitMarketDeployer();
        vm.expectRevert(abi.encodeWithSelector(IExitMarket.FeeTooHigh.selector, uint16(201)));
        deployer.deploy(address(usdg), owner, 201, feeRecipient);
    }

    function test_adminFunctions_revertForNonOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);

        vm.startPrank(stranger);
        vm.expectRevert(err);
        market.allowGateway(address(gateway), verifier);
        vm.expectRevert(err);
        market.disallowGateway(address(gateway));
        vm.expectRevert(err);
        market.setFee(10, stranger);
        vm.stopPrank();
    }

    function test_ownership_transfersOnlyAfterNewOwnerAccepts() public {
        vm.prank(owner);
        market.transferOwnership(stranger);
        assertEq(market.owner(), owner);

        vm.prank(stranger);
        market.acceptOwnership();
        assertEq(market.owner(), stranger);
    }

    function test_withdrawFees_sendsAccruedFeesToRecipientOnly() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), PRICE);
        vm.prank(buyer);
        market.buy(id, PRICE);

        vm.prank(stranger);
        market.withdrawFees();

        assertEq(usdg.balanceOf(feeRecipient), _fee(PRICE));
        assertEq(usdg.balanceOf(stranger), 0);
        assertEq(usdg.balanceOf(address(market)), 0);
    }

    // ============================================================ 11. SELL_TO_BUYER payout protection

    function test_sellToBuyer_paysSellerPriceMinusFeeAndRedirectsExit() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        TestBuyer tb = new TestBuyer(usdg, PRICE);
        usdg.mint(address(tb), PRICE);

        _sellTo(ws[0], seller, address(tb), PRICE);

        assertEq(usdg.balanceOf(seller), PRICE - _fee(PRICE));
        assertEq(usdg.balanceOf(address(market)), _fee(PRICE));
        assertEq(_ownerOf(ws[0]), address(tb));
        assertEq(tb.lastAmount(), AMOUNT);
        market.withdrawFees();
        assertEq(usdg.balanceOf(feeRecipient), _fee(PRICE));
    }

    function test_sellToBuyer_revertsWhenPayoutBelowMin() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        TestBuyer tb = new TestBuyer(usdg, PRICE);
        usdg.mint(address(tb), PRICE);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.PayoutBelowMin.selector, PRICE, PRICE + 1));
        _sellTo(ws[0], seller, address(tb), PRICE + 1);

        assertEq(_ownerOf(ws[0]), seller);
    }

    function test_sellToBuyer_measuresActualBalanceNotBuyerReportedPrice() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        TestBuyer tb = new TestBuyer(usdg, 1_000e6);
        tb.setClaimed(PRICE); // buyer lies about what it paid
        usdg.mint(address(tb), 1_000e6);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.PayoutBelowMin.selector, 1_000e6, PRICE));
        _sellTo(ws[0], seller, address(tb), PRICE);
    }

    // ============================================================ 12. happy paths

    function test_listThenBuy_movesFundsAndMakesBuyerTheExitOwner() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(3, seller, AMOUNT);
        bytes32 id = _list(ws[2], seller, PRICE);
        _fund(buyer, address(market), PRICE);

        vm.prank(buyer);
        market.buy(id, PRICE);

        uint256 fee = _fee(PRICE);
        assertEq(usdg.balanceOf(buyer), 0);
        assertEq(usdg.balanceOf(seller), PRICE - fee);
        assertEq(usdg.balanceOf(address(market)), fee);
        assertEq(_ownerOf(ws[2]), buyer);
        assertEq(uint8(market.getListing(id).status), uint8(IExitMarket.Status.Sold));

        market.withdrawFees();
        assertEq(usdg.balanceOf(feeRecipient), fee);

        // When the outbox executes, the buyer receives the tokens.
        _execute(ws[2]);
        assertEq(usdg.balanceOf(buyer), AMOUNT);
    }

    function test_resale_buyerCanRelistAndAnotherBuyerPurchases() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), PRICE);
        vm.prank(buyer);
        market.buy(id, PRICE);

        uint256 resalePrice = 9_950e6;
        bytes32 id2 = _list(ws[0], buyer, resalePrice); // buyer is now the exit owner
        assertEq(id2, id);
        assertEq(market.getListing(id2).seller, buyer);
        assertEq(_ownerOf(ws[0]), address(market));

        address buyer2 = makeAddr("buyer2");
        _fund(buyer2, address(market), resalePrice);
        vm.prank(buyer2);
        market.buy(id2, resalePrice);

        assertEq(_ownerOf(ws[0]), buyer2);
        assertEq(usdg.balanceOf(buyer), resalePrice - _fee(resalePrice));
    }

    function test_cancel_bySellerReturnsExitOwnershipAndAllowsRelist() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);

        vm.prank(seller);
        market.cancel(id);

        assertEq(_ownerOf(ws[0]), seller);
        assertEq(uint8(market.getListing(id).status), uint8(IExitMarket.Status.Cancelled));

        _list(ws[0], seller, PRICE + 1);
        assertEq(market.getListing(id).price, PRICE + 1);
    }

    function test_cancel_byStrangerBeforeExpiryReverts() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);

        vm.expectRevert(IExitMarket.NotSeller.selector);
        vm.prank(stranger);
        market.cancel(id);
    }

    function test_cancel_byAnyoneAfterExpiryReturnsExitToSeller() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes32 id = _listUntil(ws[0], seller, PRICE, expiry);
        vm.warp(uint256(expiry) + 1);

        vm.prank(stranger);
        market.cancel(id);

        assertEq(_ownerOf(ws[0]), seller);
        assertEq(uint8(market.getListing(id).status), uint8(IExitMarket.Status.Cancelled));
    }

    function test_cancel_revertsWhenNotListed() public {
        bytes32 bogus = keccak256("nothing");
        vm.expectRevert(abi.encodeWithSelector(IExitMarket.NotListed.selector, bogus));
        market.cancel(bogus);
    }
}

/// @dev Lets the test observe a constructor revert through vm.expectRevert.
contract ExitMarketDeployer {
    function deploy(address token, address owner, uint16 feeBps, address recipient) external returns (address) {
        return address(new ExitMarket(token, owner, feeBps, recipient));
    }
}
