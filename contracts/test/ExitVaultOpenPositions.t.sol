// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ExitRecord, IExitMarket, PayoutProof} from "../interfaces/IExitMarket.sol";
import {IExitVault} from "../interfaces/IExitVault.sol";
import {ExitVault} from "../ExitVault.sol";
import {MockExtendedGateway} from "./mocks/MockArbitrum.sol";
import {RejectionRevertsVerifier} from "./mocks/MockVerifiers.sol";
import {ExitFixture} from "./utils/ExitFixture.sol";

/// @dev H1: NAV values a rejected exit at zero on its own (no writeOff needed) and the open set is bounded.
contract ExitVaultOpenPositionsTest is ExitFixture {
    uint256 private constant LP_DEPOSIT = 500_000e6;
    uint256 private constant PRICE_UNIT = 1e12; // shares; convertToAssets(PRICE_UNIT) is the share price

    ExitVault private vault;
    address private lp;
    address private newcomer;

    function setUp() public override {
        super.setUp();
        lp = makeAddr("lp");
        newcomer = makeAddr("newcomer");
        vault = new ExitVault(IERC20(address(usdg)), IExitMarket(address(market)), owner, "V", "V");
        _fund(lp, address(vault), 2 * LP_DEPOSIT);
        _fund(newcomer, address(vault), LP_DEPOSIT);
        vm.prank(lp);
        vault.deposit(LP_DEPOSIT, lp);
    }

    /// @dev `n` exits, each under its OWN node (nodeNum firstNode+i, exitNum firstExit+i), bought by the vault.
    function _buyOnOwnNodes(uint256 n, uint64 firstNode, uint256 firstExit) private returns (Withdrawal[] memory ws) {
        ws = new Withdrawal[](n);
        for (uint256 i; i < n; ++i) {
            ws[i] = _createOn(gateway, firstNode + uint64(i), firstExit + i, 1, seller, AMOUNT)[0];
            _sellTo(ws[i], seller, address(vault), 0);
        }
    }

    function _collect(Withdrawal memory w) private {
        _confirm(w);
        _execute(w);
        vault.collect(_record(w), _ownPayout(w));
    }

    function _sharePrice() private view returns (uint256) {
        return vault.convertToAssets(PRICE_UNIT);
    }

    // ============================================================ H1: rejected exits are worth zero

    function test_totalAssets_valuesRejectedExitAtZeroBeforeAnyWriteOff() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _sellTo(ws[0], seller, address(vault), 0);
        ExitRecord memory rec = _record(ws[0]);
        uint256 cost = vault.outstandingCost();
        assertEq(vault.totalAssets(), LP_DEPOSIT, "pending, unrejected: carried at cost");

        rollup.setFirstUnresolvedNode(NODE + 1);

        assertTrue(market.isExitRejected(rec));
        assertEq(vault.totalAssets(), LP_DEPOSIT - cost, "rejected: worth zero the moment the node is rejected");
        assertEq(vault.outstandingCost(), cost, "still open until somebody writes it off");
        assertEq(vault.openPositionCount(), 1);
    }

    function test_totalAssets_zeroesOnlyTheRejectedNode() public {
        Withdrawal[] memory ws = _buyOnOwnNodes(2, NODE, 1);
        uint256 costEach = vault.outstandingCost() / 2;

        rollup.setFirstUnresolvedNode(NODE + 1); // node NODE rejected, NODE+1 still unresolved

        assertTrue(market.isExitRejected(_record(ws[0])));
        assertFalse(market.isExitRejected(_record(ws[1])));
        assertEq(vault.totalAssets(), LP_DEPOSIT - costEach);
    }

    function test_totalAssets_confirmedRootIsNotRejectedEvenIfItsNodeIsResolved() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _sellTo(ws[0], seller, address(vault), 0);
        _confirm(ws[0]);
        rollup.setFirstUnresolvedNode(NODE + 1); // node resolved by CONFIRMING

        assertFalse(market.isExitRejected(_record(ws[0])));
        assertGe(vault.totalAssets(), LP_DEPOSIT, "still carried");
        assertEq(vault.maxDeposit(newcomer), type(uint256).max);
    }

    function test_writeOff_movesNoSharePriceBecauseNavAlreadyExcludedTheExit() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _sellTo(ws[0], seller, address(vault), 0);
        rollup.setFirstUnresolvedNode(NODE + 1);
        uint256 priceBefore = _sharePrice();
        uint256 navBefore = vault.totalAssets();

        vault.writeOff(_record(ws[0]));

        assertEq(_sharePrice(), priceBefore);
        assertEq(vault.totalAssets(), navBefore);
        assertEq(vault.openPositionCount(), 0);
        assertEq(vault.outstandingCost(), 0);
    }

    function test_redeem_afterRejectionPaysPostLossNavWhetherOrNotWrittenOff() public {
        vm.warp(vm.getBlockTimestamp() + vault.SHARE_LOCK());
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _sellTo(ws[0], seller, address(vault), 0);
        uint256 cost = vault.outstandingCost();
        rollup.setFirstUnresolvedNode(NODE + 1);
        uint256 shares = vault.balanceOf(lp) / 2;
        uint256 expected = vault.previewRedeem(shares);
        assertApproxEqAbs(expected, (LP_DEPOSIT - cost) / 2, 1);

        vm.prank(lp);
        uint256 out = vault.redeem(shares, lp, lp);
        assertEq(out, expected);
        vault.writeOff(_record(ws[0]));
        uint256 rest = vault.maxRedeem(lp); // the virtual offset leaves a few shares unredeemable at NAV == idle
        vm.prank(lp);
        uint256 out2 = vault.redeem(rest, lp, lp);

        assertApproxEqAbs(out2, out, 1, "second half is priced the same: the write-off changed nothing");
    }

    function test_withdraw_afterRejectionBurnsSharesAtPostLossNav() public {
        vm.warp(vm.getBlockTimestamp() + vault.SHARE_LOCK());
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _sellTo(ws[0], seller, address(vault), 0);
        rollup.setFirstUnresolvedNode(NODE + 1);
        uint256 assets = 1_000e6;
        uint256 expectedShares = vault.previewWithdraw(assets);

        vm.prank(lp);
        uint256 burned = vault.withdraw(assets, lp, lp);

        assertEq(burned, expectedShares);
        assertGt(burned, assets * 1e6, "post-loss NAV: a share is worth less than one asset unit / 1e6");
    }

    // ============================================================ deposits pause on an open rejected exit

    function test_deposits_pauseAsSoonAsAnOpenExitIsRejectedEvenBeforeWriteOff() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _sellTo(ws[0], seller, address(vault), 0);
        assertGt(vault.maxDeposit(newcomer), 0);

        rollup.setFirstUnresolvedNode(NODE + 1);

        assertEq(vault.impairedExits(), 0, "nobody wrote it off");
        assertEq(vault.maxDeposit(newcomer), 0);
        assertEq(vault.maxMint(newcomer), 0);
        vm.expectPartialRevert(ERC4626.ERC4626ExceededMaxDeposit.selector);
        vm.prank(newcomer);
        vault.deposit(1_000e6, newcomer);
        vm.expectPartialRevert(ERC4626.ERC4626ExceededMaxMint.selector);
        vm.prank(newcomer);
        vault.mint(1e12, newcomer);
    }

    function test_deposits_stayPausedAcrossWriteOffAndResumeOnlyAfterTheWindow() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _sellTo(ws[0], seller, address(vault), 0);
        ExitRecord memory rec = _record(ws[0]);
        rollup.setFirstUnresolvedNode(NODE + 1);
        vault.writeOff(rec);
        assertEq(vault.maxDeposit(newcomer), 0, "written off and impaired");

        vm.warp(vm.getBlockTimestamp() + vault.IMPAIRMENT_WINDOW());
        vault.finalizeWriteOff(rec);

        assertGt(vault.maxDeposit(newcomer), 0);
    }

    function test_rejectedExit_honestRecommitCollectedBeforeWriteOff_restoresNavAndUnpauses() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _sellTo(ws[1], seller, address(vault), 0);
        ExitRecord memory rec = _record(ws[1]);
        uint256 cost = vault.outstandingCost();
        rollup.setFirstUnresolvedNode(NODE + 1);
        assertEq(vault.totalAssets(), LP_DEPOSIT - cost);
        assertEq(vault.maxDeposit(newcomer), 0);

        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmed(ws[1]);
        _execute(ws[1]);
        vault.collect(rec, PayoutProof(rec.index, root2, proof2));

        assertEq(vault.totalAssets(), LP_DEPOSIT + (AMOUNT - cost), "recovered incl. the discount");
        assertEq(vault.openPositionCount(), 0);
        assertEq(vault.impairedExits(), 0);
        assertGt(vault.maxDeposit(newcomer), 0);
        assertEq(vault.idleAssets(), usdg.balanceOf(address(vault)));
    }

    function test_withdrawals_neverPauseOnRejection() public {
        vm.warp(vm.getBlockTimestamp() + vault.SHARE_LOCK());
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _sellTo(ws[0], seller, address(vault), 0);
        rollup.setFirstUnresolvedNode(NODE + 1);

        assertGt(vault.maxWithdraw(lp), 0);
        assertGt(vault.maxRedeem(lp), 0);
    }

    // ============================================================ rejection check failing (fail safe, not brick)

    function test_totalAssets_keepsCarryingAtCostWhenTheRejectionCheckReverts() public {
        MockExtendedGateway gw2 = new MockExtendedGateway(address(0xBEEF), address(inbox));
        RejectionRevertsVerifier brokenVerifier = new RejectionRevertsVerifier(verifier);
        vm.prank(owner);
        market.allowGateway(address(gw2), brokenVerifier);
        Withdrawal[] memory ws = _createOn(gw2, 101, 1, 1, seller, AMOUNT);
        _sellTo(ws[0], seller, address(vault), 0);
        ExitRecord memory rec = _record(ws[0]);
        rollup.setFirstUnresolvedNode(102);
        vm.expectRevert("rollup upgraded");
        market.isExitRejected(rec);

        uint256 nav = vault.totalAssets(); // must not revert: deposits and redemptions keep working
        assertEq(nav, LP_DEPOSIT, "carried at cost, like before the rejection check existed");
        assertGt(vault.maxDeposit(newcomer), 0);
        vm.prank(newcomer);
        vault.deposit(1_000e6, newcomer);
    }

    // ============================================================ bounded open set

    function test_buyExit_revertsAtMaxOpenPositionsAndTheSellerKeepsTheExit() public {
        uint256 max = vault.MAX_OPEN_POSITIONS();
        assertEq(max, 32);
        _buyOnOwnNodes(max, NODE, 1);
        assertEq(vault.openPositionCount(), max);
        Withdrawal memory extra = _createOn(gateway, NODE + 100, 1_000, 2, seller, AMOUNT)[1]; // index 1: index 0 is spent by _collect
        uint256 idleBefore = vault.idleAssets();
        uint256 sellerBefore = usdg.balanceOf(seller);

        vm.expectRevert(abi.encodeWithSelector(IExitVault.TooManyOpenPositions.selector, max));
        _sellTo(extra, seller, address(vault), 0);

        assertEq(_ownerOf(extra), seller, "exit never left the seller: nothing stranded");
        assertEq(usdg.balanceOf(seller), sellerBefore);
        assertEq(vault.idleAssets(), idleBefore);
        assertEq(vault.openPositionCount(), max);
    }

    function test_buyExit_resumesOnceACollectFreesASlot() public {
        uint256 max = vault.MAX_OPEN_POSITIONS();
        Withdrawal[] memory ws = _buyOnOwnNodes(max, NODE, 1);
        Withdrawal memory extra = _createOn(gateway, NODE + 100, 1_000, 2, seller, AMOUNT)[1]; // index 1: index 0 is spent by _collect
        vm.expectRevert(abi.encodeWithSelector(IExitVault.TooManyOpenPositions.selector, max));
        _sellTo(extra, seller, address(vault), 0);

        _collect(ws[max / 2]);
        _sellTo(extra, seller, address(vault), 0);

        assertEq(_ownerOf(extra), address(vault));
        assertEq(vault.openPositionCount(), max);
    }

    function test_buyExit_resumesOnceAWriteOffFreesASlot() public {
        uint256 max = vault.MAX_OPEN_POSITIONS();
        Withdrawal[] memory ws = _buyOnOwnNodes(max, NODE, 1);
        Withdrawal memory extra = _createOn(gateway, NODE + 100, 1_000, 2, seller, AMOUNT)[1]; // index 1: index 0 is spent by _collect
        rollup.setFirstUnresolvedNode(NODE + 1); // only ws[0]'s node is rejected
        // Every pending node after NODE was built on it and is now doomed, so the extra exit sells as confirmed.
        _confirm(extra);
        vm.expectRevert(abi.encodeWithSelector(IExitVault.TooManyOpenPositions.selector, max));
        _sellTo(extra, seller, address(vault), 0);

        vault.writeOff(_record(ws[0]));
        _sellTo(extra, seller, address(vault), 0);

        assertEq(vault.openPositionCount(), max);
        assertEq(_ownerOf(extra), address(vault));
    }

    function test_openSet_swapAndPopKeepsEveryRemainingPositionCollectable() public {
        Withdrawal[] memory ws = _buyOnOwnNodes(6, NODE, 1);
        uint256[6] memory order = [uint256(0), 5, 2, 3, 1, 4]; // first, last, middle, ... (all pop shapes)
        uint256 costEach = vault.outstandingCost() / 6;

        for (uint256 i; i < 6; ++i) {
            _collect(ws[order[i]]);
            assertEq(vault.openPositionCount(), 5 - i);
            assertEq(vault.outstandingCost(), costEach * (5 - i));
            assertEq(vault.idleAssets(), usdg.balanceOf(address(vault)), "each exit is collected as it executes");
        }
        assertEq(vault.outstandingCost(), 0);
    }

    function testFuzz_openSet_anyCollectOrderKeepsAccountingExact(uint256 seed) public {
        uint256 n = 8;
        Withdrawal[] memory ws = _buyOnOwnNodes(n, NODE, 1);
        uint256 costEach = vault.outstandingCost() / n;
        bool[] memory done = new bool[](n);

        for (uint256 step; step < n; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 pick = seed % n;
            while (done[pick]) pick = (pick + 1) % n;
            done[pick] = true;

            _collect(ws[pick]);

            assertEq(vault.openPositionCount(), n - step - 1);
            assertEq(vault.outstandingCost(), costEach * (n - step - 1));
        }
        assertEq(vault.idleAssets(), usdg.balanceOf(address(vault)));
        assertEq(vault.totalAssets(), vault.idleAssets());
    }

    function testFuzz_openSet_writeOffAndCollectInterleavedKeepAccountingExact(uint256 seed) public {
        uint256 n = 6;
        Withdrawal[] memory ws = _buyOnOwnNodes(n, NODE, 1);
        rollup.setFirstUnresolvedNode(NODE + 3); // nodes NODE..NODE+2 rejected (ws[0..2]); the rest pending
        uint256 costEach = vault.outstandingCost() / n;
        uint256 open = n;

        for (uint256 step; step < n; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 pick = (seed >> 8) % n;
            (bytes32 h,, bool wo,,) = vault.purchases(_id(ws[pick]));
            if (h == bytes32(0)) continue; // already collected
            if (pick < 3 && !wo && seed % 2 == 0) {
                vault.writeOff(_record(ws[pick]));
                --open;
            } else if (pick >= 3) {
                _collect(ws[pick]);
                --open;
            }
            assertEq(vault.openPositionCount(), open);
            assertEq(vault.outstandingCost(), costEach * open);
        }
    }

    // ============================================================ direct buyer-hook guards

    function test_buyExit_revertsAlreadyPurchasedIfTheMarketHandsOverTheSameExitTwice() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        bytes32 key = _id(ws[0]);

        vm.startPrank(address(market));
        vault.buyExit(rec);
        vm.expectRevert(abi.encodeWithSelector(IExitVault.AlreadyPurchased.selector, key));
        vault.buyExit(rec);
        vm.stopPrank();

        assertEq(vault.openPositionCount(), 1);
    }

    function test_buyExit_revertsExitTooLargeAboveUint128() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        rec.amount = uint256(type(uint128).max) + 1;

        vm.expectRevert(abi.encodeWithSelector(IExitVault.ExitTooLarge.selector, rec.amount));
        vm.prank(address(market));
        vault.buyExit(rec);
    }

    // ============================================================ gas with a full open set

    function test_gas_depositAndRedeemWithFullOpenSet() public {
        Withdrawal[] memory ws = _buyOnOwnNodes(vault.MAX_OPEN_POSITIONS(), NODE, 1);
        assertEq(ws.length, 32);
        vm.roll(vm.getBlockNumber() + 50); // accrual is non-trivial for every position

        uint256 g = gasleft();
        uint256 nav = vault.totalAssets();
        uint256 navGas = g - gasleft();

        g = gasleft();
        vm.prank(newcomer);
        uint256 shares = vault.deposit(1_000e6, newcomer);
        uint256 depositGas = g - gasleft();

        vm.warp(vm.getBlockTimestamp() + vault.SHARE_LOCK());
        g = gasleft();
        vm.prank(newcomer);
        vault.redeem(shares, newcomer, newcomer);
        uint256 redeemGas = g - gasleft();

        emit log_named_uint("gas totalAssets (32 open, cold)", navGas);
        emit log_named_uint("gas deposit (32 open, cold)", depositGas);
        emit log_named_uint("gas redeem  (32 open, cold)", redeemGas);
        assertGt(nav, LP_DEPOSIT);
        assertLt(depositGas, 3_000_000);
        assertLt(redeemGas, 3_000_000);
    }
}
