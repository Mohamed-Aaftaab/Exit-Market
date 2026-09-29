// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ExitClaim, ExitRecord, IExitMarket, IExitVault} from "../interfaces/IExitMarket.sol";
import {ExitVault} from "../ExitVault.sol";
import {MockERC20} from "./mocks/MockArbitrum.sol";
import {ExitFixture} from "./utils/ExitFixture.sol";

contract ExitVaultTest is ExitFixture {
    uint256 private constant LP_DEPOSIT = 100_000e6;
    uint256 private constant BASE_FEE_BPS = 10;
    uint256 private constant APR_BPS = 1000;
    uint256 private constant SECONDS_PER_BLOCK = 12;

    ExitVault private vault;
    address private lp;

    function setUp() public override {
        super.setUp();
        lp = makeAddr("lp");
        vault = new ExitVault(IERC20(address(usdg)), IExitMarket(address(market)), owner, "Exit Vault USDG", "xvUSDG");
        _fund(lp, address(vault), 10 * LP_DEPOSIT);
    }

    /// @dev price = A - A*base/1e4 - A*apr*secs/(1e4*365d), per IExitVault.quote natspec.
    function _expectedQuote(uint256 amount, uint256 remainingBlocks) private pure returns (uint256) {
        uint256 secs = remainingBlocks * SECONDS_PER_BLOCK;
        return amount - (amount * BASE_FEE_BPS) / BPS - Math.mulDiv(amount, APR_BPS * secs, BPS * 365 days);
    }

    function _deposit(uint256 assets) private returns (uint256 shares) {
        vm.prank(lp);
        shares = vault.deposit(assets, lp);
    }

    // ============================================================ ERC-4626 basics

    function test_deposit_mintsSharesWithVirtualOffsetAndTracksIdle() public {
        uint256 shares = _deposit(LP_DEPOSIT);

        assertEq(shares, LP_DEPOSIT * 1e6);
        assertEq(vault.balanceOf(lp), shares);
        assertEq(vault.totalAssets(), LP_DEPOSIT);
        assertEq(vault.idleAssets(), LP_DEPOSIT);
        assertEq(vault.outstandingFace(), 0);
        assertEq(vault.decimals(), 12);
        assertEq(vault.asset(), address(usdg));
    }

    function test_mint_pullsPreviewedAssets() public {
        uint256 wantShares = 5_000e6 * 1e6;
        uint256 expectedAssets = vault.previewMint(wantShares);

        vm.prank(lp);
        uint256 spent = vault.mint(wantShares, lp);

        assertEq(spent, expectedAssets);
        assertEq(vault.balanceOf(lp), wantShares);
        assertEq(vault.idleAssets(), expectedAssets);
    }

    function test_redeem_returnsDepositWhenNothingHappened() public {
        uint256 shares = _deposit(LP_DEPOSIT);

        vm.prank(lp);
        uint256 out = vault.redeem(shares, lp, lp);

        assertApproxEqAbs(out, LP_DEPOSIT, 5);
        assertEq(vault.idleAssets(), LP_DEPOSIT - out);
    }

    // ============================================================ quote math

    function test_quote_appliesBaseFeeAndTimeDiscount() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        vm.roll(rec.deadlineBlock - 150);

        assertApproxEqAbs(vault.quote(rec), _expectedQuote(AMOUNT, 150), 1);
    }

    function test_quote_hasNoTimeDiscountAtOrAfterDeadline() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        uint256 baseOnly = AMOUNT - (AMOUNT * BASE_FEE_BPS) / BPS;

        vm.roll(rec.deadlineBlock);
        assertEq(vault.quote(rec), baseOnly);

        vm.roll(uint256(rec.deadlineBlock) + 1_000);
        assertEq(vault.quote(rec), baseOnly);
    }

    function test_quote_forConfirmedExitIsBaseFeeOnly() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _confirm(ws[0]);
        ExitRecord memory rec = _record(ws[0]);
        rec.pending = false;
        rec.deadlineBlock = 0;

        assertEq(vault.quote(rec), AMOUNT - (AMOUNT * BASE_FEE_BPS) / BPS);
    }

    function testFuzz_quote_isMonotonicallyDecreasingInRemainingBlocks(uint256 r1, uint256 r2) public {
        r1 = bound(r1, 0, 2_000_000);
        r2 = bound(r2, r1, 2_000_000);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory nearer = _record(ws[0]);
        ExitRecord memory farther = _record(ws[0]);
        nearer.deadlineBlock = uint64(block.number + r1);
        farther.deadlineBlock = uint64(block.number + r2);

        uint256 pNear = vault.quote(nearer);
        uint256 pFar = vault.quote(farther);

        assertGe(pNear, pFar);
        assertLe(pNear, AMOUNT);
    }

    function test_setParams_changesQuote() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);

        vm.prank(owner);
        vault.setParams(0, 0, type(uint256).max, true);

        assertEq(vault.quote(rec), AMOUNT);
    }

    function test_setParams_revertsForNonOwnerAndAbsurdValues() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        vault.setParams(10, 1000, 1, true);

        vm.expectRevert(IExitVault.BadParams.selector);
        vm.prank(owner);
        vault.setParams(type(uint16).max, type(uint16).max, 1, true);
    }

    // ============================================================ instant sell

    function test_instantSell_paysSellerQuoteMinusFeeAndVaultOwnsExit() public {
        _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        uint256 price = vault.quote(_record(ws[0]));
        uint256 fee = _fee(price);
        uint256 assetsBefore = vault.totalAssets();

        _sellTo(ws[0], seller, address(vault), price);

        assertEq(usdg.balanceOf(seller), price - fee);
        assertEq(usdg.balanceOf(address(market)), fee);
        assertEq(_ownerOf(ws[0]), address(vault));
        assertEq(vault.outstandingFace(), AMOUNT);
        assertEq(vault.idleAssets(), LP_DEPOSIT - price);
        assertEq(vault.totalAssets(), assetsBefore + (AMOUNT - price));
        assertEq(usdg.balanceOf(address(vault)), LP_DEPOSIT - price);
    }

    function test_instantSell_revertsWhenSellerMinPayoutExceedsQuote() public {
        _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        uint256 price = vault.quote(_record(ws[0]));

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.PayoutBelowMin.selector, price, price + 1));
        _sellTo(ws[0], seller, address(vault), price + 1);
    }

    function test_instantSell_confirmedExitSellsAtBaseFeeEvenWhenPendingNotAccepted() public {
        _deposit(LP_DEPOSIT);
        vm.prank(owner);
        vault.setParams(10, 1000, type(uint256).max, false);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _confirm(ws[0]);
        uint256 price = AMOUNT - (AMOUNT * BASE_FEE_BPS) / BPS;

        _sellTo(ws[0], seller, address(vault), price);

        assertEq(usdg.balanceOf(seller), price - _fee(price));
        assertEq(_ownerOf(ws[0]), address(vault));
    }

    function test_instantSell_revertsWithWrongToken() public {
        _deposit(LP_DEPOSIT);
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        exitToken = other;
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);

        vm.expectRevert(abi.encodeWithSelector(IExitVault.WrongToken.selector, address(other)));
        _sellTo(ws[0], seller, address(vault), 0);
    }

    function test_instantSell_revertsWhenPendingNotAccepted() public {
        _deposit(LP_DEPOSIT);
        vm.prank(owner);
        vault.setParams(10, 1000, type(uint256).max, false);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);

        vm.expectRevert(IExitVault.PendingNotAccepted.selector);
        _sellTo(ws[0], seller, address(vault), 0);
    }

    function test_instantSell_revertsWhenExitTooLarge() public {
        _deposit(LP_DEPOSIT);
        vm.prank(owner);
        vault.setParams(10, 1000, AMOUNT - 1, true);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);

        vm.expectRevert(abi.encodeWithSelector(IExitVault.ExitTooLarge.selector, AMOUNT));
        _sellTo(ws[0], seller, address(vault), 0);
    }

    function test_instantSell_revertsWhenInsufficientLiquidity() public {
        _deposit(1_000e6);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        uint256 price = vault.quote(_record(ws[0]));

        vm.expectRevert(abi.encodeWithSelector(IExitVault.InsufficientLiquidity.selector, price, 1_000e6));
        _sellTo(ws[0], seller, address(vault), 0);
    }

    function test_buyExit_revertsWhenCalledByAnyoneButTheMarket() public {
        _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);

        vm.expectRevert(IExitVault.OnlyMarket.selector);
        vm.prank(stranger);
        vault.buyExit(rec);

        vm.expectRevert(IExitVault.OnlyMarket.selector);
        vm.prank(seller);
        vault.buyExit(rec);
    }

    // ============================================================ collect / writeOff

    function test_collect_movesFaceValueFromOutstandingToIdleAfterExecution() public {
        _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        uint256 price = vault.quote(rec);
        _sellTo(ws[0], seller, address(vault), price);
        _execute(ws[0]); // outbox pays the vault, the current exit owner
        assertEq(usdg.balanceOf(address(vault)), LP_DEPOSIT - price + AMOUNT);

        vm.prank(stranger);
        vault.collect(rec);

        assertEq(vault.outstandingFace(), 0);
        assertEq(vault.idleAssets(), LP_DEPOSIT - price + AMOUNT);
        assertEq(vault.totalAssets(), LP_DEPOSIT + (AMOUNT - price));
        assertEq(usdg.balanceOf(address(vault)), vault.idleAssets());
    }

    function test_collect_lpRealizesTheDiscountAsYield() public {
        uint256 shares = _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        uint256 price = vault.quote(rec);
        _sellTo(ws[0], seller, address(vault), price);
        _execute(ws[0]);
        vault.collect(rec);

        vm.prank(lp);
        uint256 out = vault.redeem(shares, lp, lp);

        assertApproxEqAbs(out, LP_DEPOSIT + (AMOUNT - price), 5);
        assertGt(out, LP_DEPOSIT);
    }

    function test_collect_revertsWhileExitStillLive() public {
        _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        _sellTo(ws[0], seller, address(vault), 0);
        bytes32 key = _id(ws[0]);

        vm.expectRevert(abi.encodeWithSelector(IExitVault.ExitStillLive.selector, key));
        vault.collect(rec);
    }

    function test_collect_revertsForUnknownExit() public {
        _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _sellTo(ws[0], seller, address(vault), 0);
        _execute(ws[1]); // spent, but never bought by the vault
        bytes32 key = _id(ws[1]);
        ExitRecord memory rec = _record(ws[1]);

        vm.expectRevert(abi.encodeWithSelector(IExitVault.UnknownExit.selector, key));
        vault.collect(rec);
    }

    function test_collect_cannotBeRepeated() public {
        _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        _sellTo(ws[0], seller, address(vault), 0);
        _execute(ws[0]);
        vault.collect(rec);

        vm.expectRevert();
        vault.collect(rec);
    }

    function test_collect_rejectsRecordWithInflatedAmount() public {
        _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        _sellTo(ws[0], seller, address(vault), 0);
        _execute(ws[0]);
        rec.amount = AMOUNT * 10;

        vm.expectRevert();
        vault.collect(rec);
        assertEq(vault.outstandingFace(), AMOUNT);
    }

    function test_writeOff_realizesLossWhenNodeRejected() public {
        _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        uint256 price = vault.quote(rec);
        _sellTo(ws[0], seller, address(vault), price);
        rollup.setFirstUnresolvedNode(NODE + 1);

        vm.prank(stranger);
        vault.writeOff(rec);

        assertEq(vault.outstandingFace(), 0);
        assertEq(vault.idleAssets(), LP_DEPOSIT - price);
        assertEq(vault.totalAssets(), LP_DEPOSIT - price);
    }

    function test_writeOff_revertsWhileExitIsStillLive() public {
        _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        _sellTo(ws[0], seller, address(vault), 0);

        vm.expectRevert();
        vault.writeOff(rec);
        assertEq(vault.outstandingFace(), AMOUNT);
    }

    function test_writeOff_revertsForSpentExit() public {
        _deposit(LP_DEPOSIT);
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        _sellTo(ws[0], seller, address(vault), 0);
        _execute(ws[0]);
        rollup.setFirstUnresolvedNode(NODE + 1); // even if the node also resolved, the money arrived

        vm.expectRevert();
        vault.writeOff(rec);
    }

    function test_writeOff_revertsForUnknownExit() public {
        ExitFixture.Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        rollup.setFirstUnresolvedNode(NODE + 1);
        bytes32 key = _id(ws[0]);
        ExitRecord memory rec = _record(ws[0]);

        vm.expectRevert(abi.encodeWithSelector(IExitVault.UnknownExit.selector, key));
        vault.writeOff(rec);
    }

    // ============================================================ share accounting attacks

    function test_donation_cannotInflateSharePriceToStealNextDepositor() public {
        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");
        uint256 donation = 10_000e6;
        _fund(attacker, address(vault), 1 + donation);
        _fund(victim, address(vault), 10_000e6);

        vm.startPrank(attacker);
        uint256 attackerShares = vault.deposit(1, attacker);
        usdg.transfer(address(vault), donation); // direct donation to skew balanceOf-based accounting
        vm.stopPrank();

        vm.prank(victim);
        uint256 victimShares = vault.deposit(10_000e6, victim);

        assertGt(victimShares, 0);
        assertApproxEqAbs(vault.previewRedeem(victimShares), 10_000e6, 2);
        assertLe(vault.previewRedeem(attackerShares), 1);
        assertEq(vault.totalAssets(), 10_000e6 + 1, "donation must not count as an asset");
    }
}
