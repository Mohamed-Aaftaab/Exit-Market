// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ExitRecord, IExitMarket, PayoutProof} from "../interfaces/IExitMarket.sol";
import {ExitAccrual} from "../libraries/ExitAccrual.sol";
import {ExitVault} from "../ExitVault.sol";
import {ExitFixture} from "./utils/ExitFixture.sol";

/// @dev Pure properties of the linear accrual used by ExitVault.totalAssets().
contract ExitAccrualTest is Test {
    function test_valueAt_isCostAtOrBeforePurchaseAndFaceAtOrAfterDeadline() public pure {
        assertEq(ExitAccrual.valueAt(990, 1000, 100, 200, 100), 990);
        assertEq(ExitAccrual.valueAt(990, 1000, 100, 200, 50), 990);
        assertEq(ExitAccrual.valueAt(990, 1000, 100, 200, 200), 1000);
        assertEq(ExitAccrual.valueAt(990, 1000, 100, 200, 10_000), 1000);
    }

    function test_valueAt_accruesLinearlyBetween() public pure {
        assertEq(ExitAccrual.valueAt(900, 1000, 100, 200, 150), 950);
        assertEq(ExitAccrual.valueAt(900, 1000, 100, 200, 110), 910);
        assertEq(ExitAccrual.valueAt(900, 1000, 100, 200, 199), 999);
    }

    function test_valueAt_roundsDown() public pure {
        assertEq(ExitAccrual.valueAt(0, 10, 0, 3, 1), 3); // 10/3
        assertEq(ExitAccrual.valueAt(0, 10, 0, 3, 2), 6); // 20/3
    }

    function test_valueAt_deadlineAtOrBeforePurchaseAccruesEverythingAtOnce() public pure {
        assertEq(ExitAccrual.valueAt(990, 1000, 500, 0, 500), 1000, "confirmed exit (deadline 0)");
        assertEq(ExitAccrual.valueAt(990, 1000, 500, 500, 500), 1000);
        assertEq(ExitAccrual.valueAt(990, 1000, 500, 400, 500), 1000, "node already past its deadline");
    }

    function test_valueAt_noDiscountOrPremiumNeverAccruesBelowCost() public pure {
        assertEq(ExitAccrual.valueAt(1000, 1000, 100, 200, 150), 1000);
        assertEq(ExitAccrual.valueAt(1200, 1000, 100, 200, 150), 1200);
    }

    function testFuzz_valueAt_staysWithinCostAndFace(
        uint128 cost,
        uint128 discount,
        uint64 start,
        uint64 end,
        uint64 nowBlock
    ) public pure {
        uint256 face = uint256(cost) + discount;
        uint256 v = ExitAccrual.valueAt(cost, face, start, end, nowBlock);
        assertGe(v, cost);
        assertLe(v, face);
    }

    function testFuzz_valueAt_isMonotonicInTime(
        uint128 cost,
        uint128 discount,
        uint64 start,
        uint64 end,
        uint64 t1,
        uint64 t2
    ) public pure {
        uint256 face = uint256(cost) + discount;
        (t1, t2) = t1 <= t2 ? (t1, t2) : (t2, t1);
        assertLe(ExitAccrual.valueAt(cost, face, start, end, t1), ExitAccrual.valueAt(cost, face, start, end, t2));
    }

    function testFuzz_valueAt_isExactlyFaceOnceDeadlinePassed(uint128 cost, uint128 discount, uint64 start, uint64 end, uint64 extra)
        public
        pure
    {
        uint256 face = uint256(cost) + discount;
        uint256 nowBlock = uint256(end) + extra;
        assertEq(ExitAccrual.valueAt(cost, face, start, end, nowBlock), face);
    }

    function testFuzz_valueAt_isNeverAheadOfTheLinearShare(uint128 cost, uint128 discount, uint32 start, uint32 span, uint32 elapsed)
        public
        pure
    {
        span = uint32(bound(span, 1, type(uint32).max));
        elapsed = uint32(bound(elapsed, 0, span));
        uint256 face = uint256(cost) + discount;
        uint256 v = ExitAccrual.valueAt(cost, face, start, uint256(start) + span, uint256(start) + elapsed);
        // v - cost = floor(discount * elapsed / span)  <=  discount * elapsed / span
        assertLe((v - cost) * span, uint256(discount) * elapsed);
    }
}

/// @dev H2: the purchase discount accrues into NAV block by block, so collect() is not a NAV event.
contract ExitVaultAccrualTest is ExitFixture {
    uint256 private constant LP_DEPOSIT = 100_000e6;

    ExitVault private vault;
    address private lp;
    address private newcomer;

    function setUp() public override {
        super.setUp();
        lp = makeAddr("lp");
        newcomer = makeAddr("newcomer");
        vault = new ExitVault(IERC20(address(usdg)), IExitMarket(address(market)), owner, "V", "V");
        _fund(lp, address(vault), 10 * LP_DEPOSIT);
        _fund(newcomer, address(vault), 10 * LP_DEPOSIT);
        vm.prank(lp);
        vault.deposit(LP_DEPOSIT, lp);
    }

    /// @dev Buys a fresh pending exit at the current block; returns its record and total discount.
    function _buy() private returns (Withdrawal memory w, ExitRecord memory rec, uint256 discount) {
        w = _createWithdrawals(1, seller, AMOUNT)[0];
        _sellTo(w, seller, address(vault), 0);
        rec = _record(w);
        discount = AMOUNT - vault.outstandingCost();
    }

    function _payOut(Withdrawal memory w) private {
        _confirm(w);
        _execute(w);
    }

    function test_totalAssets_accruesLinearlyFromPurchaseToDeadlineThenStops() public {
        (, ExitRecord memory rec, uint256 discount) = _buy();
        // Tests read the chain via vm.getBlockNumber()/getBlockTimestamp(): with viaIR the optimizer may otherwise
        // re-evaluate block.number/timestamp lazily, after a later roll/warp.
        uint256 start = vm.getBlockNumber();
        uint256 span = uint256(rec.deadlineBlock) - start;
        assertEq(span, CONFIRM_BLOCKS);
        assertGt(discount, 0);

        assertEq(vault.totalAssets(), LP_DEPOSIT, "nothing accrued at the purchase block");
        vm.roll(start + span / 2);
        assertApproxEqAbs(vault.totalAssets(), LP_DEPOSIT + discount / 2, 1);
        vm.roll(start + (span * 4) / 5);
        assertApproxEqAbs(vault.totalAssets(), LP_DEPOSIT + (discount * 4) / 5, 1);
        vm.roll(rec.deadlineBlock);
        assertEq(vault.totalAssets(), LP_DEPOSIT + discount, "all of it at the deadline");
        vm.roll(uint256(rec.deadlineBlock) + 10_000);
        assertEq(vault.totalAssets(), LP_DEPOSIT + discount, "capped at face");
    }

    function test_totalAssets_neverExceedsIdlePlusFaceOfOpenExits() public {
        (, ExitRecord memory rec,) = _buy();
        vm.roll(uint256(rec.deadlineBlock) + 500);
        assertEq(vault.totalAssets(), vault.idleAssets() + AMOUNT);
    }

    function test_collect_atTheDeadlineCausesNoNavStep() public {
        (Withdrawal memory w, ExitRecord memory rec,) = _buy();
        vm.roll(rec.deadlineBlock);
        _payOut(w);
        uint256 navBefore = vault.totalAssets();
        uint256 priceBefore = vault.convertToAssets(1e12);

        vault.collect(rec, _ownPayout(w));

        assertEq(vault.totalAssets(), navBefore, "collect is bookkeeping once the discount has accrued");
        assertEq(vault.convertToAssets(1e12), priceBefore);
    }

    function test_collect_longAfterTheDeadlineCausesNoNavStep() public {
        (Withdrawal memory w, ExitRecord memory rec,) = _buy();
        vm.roll(uint256(rec.deadlineBlock) + 45_000);
        _payOut(w);
        uint256 navBefore = vault.totalAssets();

        vault.collect(rec, _ownPayout(w));

        assertEq(vault.totalAssets(), navBefore);
    }

    function test_collect_beforeTheDeadlineStepsOnlyByTheUnaccruedRemainder() public {
        (Withdrawal memory w, ExitRecord memory rec, uint256 discount) = _buy();
        vm.roll(vm.getBlockNumber() + 30); // 20% of 150 blocks (unrealistic early payout; the mock allows it)
        _payOut(w);
        uint256 navBefore = vault.totalAssets();

        vault.collect(rec, _ownPayout(w));

        uint256 remainder = (discount * 4) / 5;
        assertApproxEqAbs(vault.totalAssets() - navBefore, remainder, 1);
        assertEq(vault.totalAssets(), LP_DEPOSIT + discount);
    }

    function test_sharePrice_neverDecreasesWhileAnExitAccruesAndIsCollected() public {
        (Withdrawal memory w, ExitRecord memory rec,) = _buy();
        uint256 last = vault.convertToAssets(1e12);
        for (uint256 i; i < 8; ++i) {
            vm.roll(vm.getBlockNumber() + 17); // 136 of the 150 blocks
            uint256 price = vault.convertToAssets(1e12);
            assertGe(price, last);
            last = price;
        }
        vm.roll(rec.deadlineBlock);
        _payOut(w);
        vault.collect(rec, _ownPayout(w));
        assertGe(vault.convertToAssets(1e12), last);
    }

    function test_confirmedExit_accruesItsBaseFeeAtOnceBecauseThereIsNothingToWaitFor() public {
        Withdrawal memory w = _createWithdrawals(1, seller, AMOUNT)[0];
        _confirm(w);
        _sellTo(w, seller, address(vault), 0);
        uint256 baseFee = (AMOUNT * vault.baseFeeBps()) / BPS;

        assertEq(vault.outstandingCost(), AMOUNT - baseFee);
        assertEq(vault.totalAssets(), LP_DEPOSIT + baseFee);
    }

    function test_overdueUnconfirmedExit_accruesItsBaseFeeAtOnce() public {
        Withdrawal memory w = _createWithdrawals(1, seller, AMOUNT)[0];
        vm.roll(uint256(_record(w).deadlineBlock) + 5); // node past its deadline but not yet confirmed
        _sellTo(w, seller, address(vault), 0);
        uint256 baseFee = (AMOUNT * vault.baseFeeBps()) / BPS;

        assertEq(vault.totalAssets(), LP_DEPOSIT + baseFee);
    }

    function test_positionsAccrueIndependentlyOnTheirOwnDeadlines() public {
        (, ExitRecord memory recA, uint256 discA) = _buy();
        vm.roll(vm.getBlockNumber() + 100);
        Withdrawal memory wB = _createOn(gateway, NODE + 1, 2, 1, seller, AMOUNT)[0];
        uint256 costBefore = vault.outstandingCost();
        _sellTo(wB, seller, address(vault), 0);
        ExitRecord memory recB = _record(wB);
        uint256 discB = AMOUNT - (vault.outstandingCost() - costBefore);
        assertGt(recB.deadlineBlock, recA.deadlineBlock);

        vm.roll(recA.deadlineBlock); // A is done, B is a third of the way (50 of 150 blocks)
        assertApproxEqAbs(vault.totalAssets(), LP_DEPOSIT + discA + discB / 3, 2);
    }

    function test_writtenOffExitStopsAccruingAndTheDiscountReturnsOnlyAtCollect() public {
        (Withdrawal memory w, ExitRecord memory rec, uint256 discount) = _buy();
        vm.roll(vm.getBlockNumber() + 75);
        rollup.setFirstUnresolvedNode(NODE + 1);
        vault.writeOff(rec);
        uint256 cost = AMOUNT - discount;
        assertEq(vault.totalAssets(), LP_DEPOSIT - cost);

        vm.roll(uint256(rec.deadlineBlock) + 100);
        assertEq(vault.totalAssets(), LP_DEPOSIT - cost, "a written-off exit accrues nothing");

        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmed(w);
        _execute(w);
        vault.collect(rec, PayoutProof(rec.index, root2, proof2));
        assertEq(vault.totalAssets(), LP_DEPOSIT + discount);
    }

    // ============================================================ H2 economics

    function test_lateDepositorPaysForTheAccruedHalfAndCarriesOnlyTheRest() public {
        (Withdrawal memory w, ExitRecord memory rec, uint256 discount) = _buy();
        vm.roll(vm.getBlockNumber() + CONFIRM_BLOCKS / 2);
        vm.prank(newcomer);
        uint256 shares = vault.deposit(LP_DEPOSIT, newcomer);

        vm.roll(rec.deadlineBlock);
        _payOut(w);
        vault.collect(rec, _ownPayout(w));
        vm.warp(vm.getBlockTimestamp() + vault.SHARE_LOCK());
        vm.prank(newcomer);
        uint256 out = vault.redeem(shares, newcomer, newcomer);

        uint256 expectedGain = (LP_DEPOSIT * (2 * LP_DEPOSIT + discount)) / (2 * LP_DEPOSIT + discount / 2) - LP_DEPOSIT;
        assertApproxEqAbs(out - LP_DEPOSIT, expectedGain, 5);
        assertApproxEqAbs(expectedGain, discount / 4, 100, "a quarter of the total: half of the second half");
    }

    /// @dev Whenever the sniper joins, the gain he can lock in by depositing and then collecting is at most his
    ///      pro-rata share of the discount that had NOT accrued yet; joining at the deadline earns nothing.
    function testFuzz_depositBeforeCollect_gainIsBoundedByProRataShareOfTheUnaccruedRemainder(
        uint256 blocksIn,
        uint256 amount
    ) public {
        blocksIn = bound(blocksIn, 0, CONFIRM_BLOCKS);
        amount = bound(amount, 1_000e6, 1_000_000e6);
        (Withdrawal memory w, ExitRecord memory rec, uint256 discount) = _buy();
        vm.roll(vm.getBlockNumber() + blocksIn);
        uint256 navBefore = vault.totalAssets();
        uint256 unaccrued = LP_DEPOSIT + discount - navBefore;

        vm.prank(newcomer);
        uint256 shares = vault.deposit(amount, newcomer);
        vm.roll(rec.deadlineBlock);
        _payOut(w);
        vault.collect(rec, _ownPayout(w));
        vm.warp(vm.getBlockTimestamp() + vault.SHARE_LOCK());
        vm.prank(newcomer);
        uint256 out = vault.redeem(shares, newcomer, newcomer);

        uint256 bound_ = (unaccrued * amount) / (navBefore + amount);
        assertLe(out, amount + bound_ + 5, "no more than his pro-rata share of the unaccrued remainder");
        assertGe(out + 5, amount, "and he never loses on a pure carry");
        if (blocksIn == CONFIRM_BLOCKS) assertApproxEqAbs(out, amount, 5);
    }
}
