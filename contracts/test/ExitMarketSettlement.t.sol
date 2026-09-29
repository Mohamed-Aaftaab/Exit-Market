// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitClaim, ExitRecord, IExitMarket} from "../interfaces/IExitMarket.sol";
import {MockERC20} from "./mocks/MockArbitrum.sol";
import {ExitFixture} from "./utils/ExitFixture.sol";

/// @dev Exits executed while the market holds them: settle / cancel payout rules.
contract ExitMarketSettlementTest is ExitFixture {
    uint256 private constant PRICE = 9_900e6;

    function _status(bytes32 id) private view returns (uint8) {
        return uint8(market.getListing(id).status);
    }

    // ------------------------------------------------------------ buy vs executed

    function test_buy_revertsWhenExitExecutedAfterListing() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _execute(ws[0]);
        _fund(buyer, address(market), PRICE);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ExitAlreadySpent.selector, ws[0].claim.index));
        vm.prank(buyer);
        market.buy(id, PRICE);

        assertEq(usdg.balanceOf(buyer), PRICE);
    }

    // ------------------------------------------------------------ honest settle

    function test_settle_paysSellerWhenExitExecutedAfterItsNodeConfirms() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        exitToken = other;
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _confirm(ws[0]); // node confirmed: root now canonical in the Outbox
        _execute(ws[0]);
        assertEq(other.balanceOf(address(market)), AMOUNT);

        vm.expectEmit(true, false, false, true, address(market));
        emit IExitMarket.ListingSettled(id, AMOUNT);
        vm.prank(stranger);
        market.settle(id, ws[0].claim.sendRoot, _noProof());

        assertEq(other.balanceOf(seller), AMOUNT);
        assertEq(other.balanceOf(address(market)), 0);
        assertEq(_status(id), uint8(IExitMarket.Status.Settled));
    }

    function test_settle_paysSellerViaSiblingRootWhenOriginalNodeRejected() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[1], seller, PRICE);
        rollup.setFirstUnresolvedNode(NODE + 1); // original node rejected
        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmed(ws[1]);
        _execute(ws[1]); // executed under the canonical root at the same index

        market.settle(id, root2, proof2);

        assertEq(usdg.balanceOf(seller), AMOUNT);
        assertEq(_status(id), uint8(IExitMarket.Status.Settled));
    }

    function test_settle_revertsWithWrongProofForSiblingRoot() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[1], seller, PRICE);
        rollup.setFirstUnresolvedNode(NODE + 1);
        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmed(ws[1]);
        _execute(ws[1]);
        proof2[0] = bytes32(uint256(0xbad));

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ExitNotPaidOut.selector, ws[1].claim.index));
        market.settle(id, root2, proof2);
        assertEq(usdg.balanceOf(seller), 0);
    }

    function test_settle_revertsWhenExitNotSpent() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[1], seller, PRICE);
        _confirm(ws[1]);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ExitNotPaidOut.selector, ws[1].claim.index));
        market.settle(id, ws[1].claim.sendRoot, _noProof());
    }

    function test_settle_revertsWhenSpentButRootNotConfirmed() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _execute(ws[0]); // root still only pending

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ExitNotPaidOut.selector, ws[0].claim.index));
        market.settle(id, ws[0].claim.sendRoot, _noProof());
    }

    function test_settle_cannotBeCalledTwice() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _confirm(ws[0]);
        _execute(ws[0]);
        market.settle(id, ws[0].claim.sendRoot, _noProof());

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.NotListed.selector, id));
        market.settle(id, ws[0].claim.sendRoot, _noProof());
    }

    function test_settle_leavesAccruedFeesUntouchedWhenL1TokenIsPaymentToken() public {
        // l1Token == payment token (USDG): the market balance mixes fees and exit proceeds.
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 idSold = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), PRICE);
        vm.prank(buyer);
        market.buy(idSold, PRICE);
        uint256 fee = _fee(PRICE);
        assertEq(usdg.balanceOf(address(market)), fee);

        bytes32 idSettled = _list(ws[1], seller, PRICE);
        _confirm(ws[1]);
        _execute(ws[1]);
        assertEq(usdg.balanceOf(address(market)), fee + AMOUNT);
        market.settle(idSettled, ws[1].claim.sendRoot, _noProof());

        assertEq(usdg.balanceOf(address(market)), fee, "fees must survive settle");
        assertEq(usdg.balanceOf(seller), (PRICE - fee) + AMOUNT);

        market.withdrawFees();
        assertEq(usdg.balanceOf(feeRecipient), fee);
        assertEq(usdg.balanceOf(address(market)), 0);
    }

    // ------------------------------------------------------------ cancel on a spent slot

    function test_cancel_paysSellerWhenPaidOutUnderConfirmedOriginalRoot() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _confirm(ws[0]);
        _execute(ws[0]);

        vm.prank(seller);
        market.cancel(id);

        assertEq(usdg.balanceOf(seller), AMOUNT);
        assertEq(_status(id), uint8(IExitMarket.Status.Settled));
    }

    function test_cancel_revertsExitNeedsSettlementWhenSpentButRootUnconfirmed() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _execute(ws[0]);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ExitNeedsSettlement.selector, ws[0].claim.index));
        vm.prank(seller);
        market.cancel(id);
        assertEq(_status(id), uint8(IExitMarket.Status.Listed));
    }

    function test_cancel_revertsExitNeedsSettlementWhenSlotSpentUnderSiblingRoot() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[1], seller, PRICE);
        rollup.setFirstUnresolvedNode(NODE + 1);
        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmed(ws[1]);
        _execute(ws[1]);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ExitNeedsSettlement.selector, ws[1].claim.index));
        vm.prank(seller);
        market.cancel(id);

        market.settle(id, root2, proof2); // the honest route still works
        assertEq(usdg.balanceOf(seller), AMOUNT);
    }

    // ------------------------------------------------------------ views

    function test_isExitLiveAndPaidOut_trackOutboxState() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _list(ws[0], seller, PRICE);
        ExitRecord memory rec = _record(ws[0]);

        assertTrue(market.isExitLive(rec));
        assertFalse(market.isExitPaidOut(rec, rec.sendRoot, _noProof()));

        _execute(ws[0]);
        assertFalse(market.isExitLive(rec));
        assertFalse(market.isExitPaidOut(rec, rec.sendRoot, _noProof()), "unconfirmed root is not a payout");

        _confirm(ws[0]);
        assertTrue(market.isExitPaidOut(rec, rec.sendRoot, _noProof()));
        assertFalse(market.isExitPaidOut(rec, bytes32(uint256(1)), _noProof()));
    }

    // ------------------------------------------------------------ isExitDisproven

    /// @dev Fake exit 10 (node 101) and a confirmed canonical leaf for the same exitNum with other content.
    function _fakeAndCanonical() private returns (ExitRecord memory fake, ExitClaim memory canon) {
        Withdrawal[] memory f = _createOn(gateway, 101, 10, 1, stranger, AMOUNT);
        Withdrawal[] memory c = _createOn(gateway, 102, 10, 1, seller, AMOUNT);
        _confirm(c[0]);
        fake = _record(f[0]);
        canon = c[0].claim;
    }

    function test_isExitDisproven_trueWhenConfirmedRootHoldsDifferentItemForSameExitNum() public {
        (ExitRecord memory fake, ExitClaim memory canon) = _fakeAndCanonical();
        assertTrue(canon.initialDestination != fake.initialDestination);

        assertTrue(market.isExitDisproven(fake, canon));
    }

    function test_isExitDisproven_falseWhenCanonicalIsTheExitsOwnItem() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _confirm(ws[1]);

        assertFalse(market.isExitDisproven(_record(ws[1]), ws[1].claim));
    }

    function test_isExitDisproven_falseForSiblingRootHoldingTheSameItem() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmed(ws[1]);
        ExitClaim memory sibling = ws[1].claim;
        sibling.sendRoot = root2;
        sibling.proof = proof2;

        assertFalse(market.isExitDisproven(_record(ws[1]), sibling));
    }

    function test_isExitDisproven_falseWhenCanonicalRootUnconfirmed() public {
        (ExitRecord memory fake, ExitClaim memory canon) = _fakeAndCanonical();
        canon.sendRoot = bytes32(uint256(0xabc));

        assertFalse(market.isExitDisproven(fake, canon));
    }

    function test_isExitDisproven_falseWhenProofDoesNotMatchConfirmedRoot() public {
        Withdrawal[] memory f = _createOn(gateway, 101, 11, 1, stranger, AMOUNT);
        Withdrawal[] memory c = _createOn(gateway, 102, 10, 2, seller, AMOUNT); // exitNums 10, 11
        _confirm(c[0]);
        ExitClaim memory canon = c[1].claim;
        canon.proof[0] = bytes32(uint256(1));

        assertFalse(market.isExitDisproven(_record(f[0]), canon));
    }

    function test_isExitDisproven_falseForClaimOfADifferentExitNum() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _confirm(ws[0]);

        assertFalse(market.isExitDisproven(_record(ws[1]), ws[0].claim));
    }

    function test_isExitDisproven_revertsForUnknownGateway() public {
        (ExitRecord memory fake, ExitClaim memory canon) = _fakeAndCanonical();
        fake.gateway = stranger;

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.GatewayUnknown.selector, stranger));
        market.isExitDisproven(fake, canon);
    }
}
