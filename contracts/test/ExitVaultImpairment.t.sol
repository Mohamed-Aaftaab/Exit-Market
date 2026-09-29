// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ExitRecord, IExitMarket, PayoutProof} from "../interfaces/IExitMarket.sol";
import {IExitVault} from "../interfaces/IExitVault.sol";
import {ExitVault} from "../ExitVault.sol";
import {ExitFixture} from "./utils/ExitFixture.sol";

/// @dev Deposits pause while a written-off exit is impaired (NAV possibly understated).
contract ExitVaultImpairmentTest is ExitFixture {
    uint256 private constant LP_DEPOSIT = 100_000e6;

    ExitVault private vault;
    address private lp;
    address private attacker;

    function setUp() public override {
        super.setUp();
        lp = makeAddr("lp");
        attacker = makeAddr("attacker");
        vault = new ExitVault(IERC20(address(usdg)), IExitMarket(address(market)), owner, "V", "V");
        _fund(lp, address(vault), LP_DEPOSIT);
        _fund(attacker, address(vault), LP_DEPOSIT);
        vm.prank(lp);
        vault.deposit(LP_DEPOSIT, lp);
    }

    function _buyAndWriteOff(Withdrawal memory w) private returns (ExitRecord memory rec) {
        rec = _record(w);
        _sellTo(w, w.claim.initialDestination, address(vault), 0);
        rollup.setFirstUnresolvedNode(w.claim.nodeNum + 1);
        vault.writeOff(rec);
    }

    function _purchase(Withdrawal memory w) private view returns (bool writtenOff, uint64 at, bool finalized) {
        (,, writtenOff, at, finalized) = vault.purchases(_id(w));
    }

    function test_writeOff_pausesDepositsSoNavDipCannotBeExploited() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _buyAndWriteOff(ws[0]);

        assertEq(vault.impairedExits(), 1);
        assertEq(vault.maxDeposit(attacker), 0);
        assertEq(vault.maxMint(attacker), 0);
        vm.expectPartialRevert(ERC4626.ERC4626ExceededMaxDeposit.selector);
        vm.prank(attacker);
        vault.deposit(LP_DEPOSIT, attacker);
        vm.expectPartialRevert(ERC4626.ERC4626ExceededMaxMint.selector);
        vm.prank(attacker);
        vault.mint(1e12, attacker);
    }

    function test_writeOff_doesNotBlockWithdrawals() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _buyAndWriteOff(ws[0]);
        vm.warp(block.timestamp + vault.SHARE_LOCK());

        assertGt(vault.maxWithdraw(lp), 0);
        vm.prank(lp);
        vault.withdraw(1_000e6, lp, lp);
    }

    function test_deposits_resumeAfterWrittenOffExitIsCollected() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _buyAndWriteOff(ws[0]);
        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmed(ws[0]);
        _execute(ws[0]);

        vault.collect(rec, PayoutProof(rec.index, root2, proof2));

        assertEq(vault.impairedExits(), 0);
        assertGt(vault.maxDeposit(attacker), 0);
        vm.prank(attacker);
        vault.deposit(1_000e6, attacker);
    }

    function test_finalizeWriteOff_revertsWhileWindowOpen() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _buyAndWriteOff(ws[0]);
        bytes32 key = _id(ws[0]);
        vm.warp(block.timestamp + vault.IMPAIRMENT_WINDOW() - 1);

        vm.expectRevert(abi.encodeWithSelector(IExitVault.ImpairmentWindowOpen.selector, key));
        vault.finalizeWriteOff(rec);
        assertEq(vault.impairedExits(), 1);
    }

    function test_finalizeWriteOff_resumesDepositsPastWindowAndCannotRepeat() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _buyAndWriteOff(ws[0]);
        bytes32 key = _id(ws[0]);
        vm.warp(block.timestamp + vault.IMPAIRMENT_WINDOW());

        vm.expectEmit(true, false, false, false, address(vault));
        emit IExitVault.WriteOffFinalized(key);
        vm.prank(stranger);
        vault.finalizeWriteOff(rec);

        (bool writtenOff,, bool finalized) = _purchase(ws[0]);
        assertTrue(writtenOff);
        assertTrue(finalized);
        assertEq(vault.impairedExits(), 0);
        vm.prank(attacker);
        vault.deposit(1_000e6, attacker);

        vm.expectRevert(abi.encodeWithSelector(IExitVault.NotImpaired.selector, key));
        vault.finalizeWriteOff(rec);
        assertEq(vault.impairedExits(), 0);
    }

    function test_finalizeWriteOff_revertsNotImpairedWhenNeverWrittenOff() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _record(ws[0]);
        _sellTo(ws[0], seller, address(vault), 0);
        bytes32 key = _id(ws[0]);
        vm.warp(block.timestamp + 30 days);

        vm.expectRevert(abi.encodeWithSelector(IExitVault.NotImpaired.selector, key));
        vault.finalizeWriteOff(rec);
    }

    function test_collectAfterFinalize_creditsIdleWithoutUnderflowingImpairedCounter() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        ExitRecord memory rec = _buyAndWriteOff(ws[0]);
        vm.warp(block.timestamp + vault.IMPAIRMENT_WINDOW());
        vault.finalizeWriteOff(rec);
        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmed(ws[0]);
        _execute(ws[0]);
        uint256 idleBefore = vault.idleAssets();

        vault.collect(rec, PayoutProof(rec.index, root2, proof2));

        assertEq(vault.impairedExits(), 0);
        assertEq(vault.idleAssets(), idleBefore + AMOUNT);
        assertEq(vault.idleAssets(), usdg.balanceOf(address(vault)));
    }

    function test_twoWrittenOffExits_bothMustBeResolvedBeforeDepositsResume() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        rollup.setFirstUnresolvedNode(NODE + 1);
        ExitRecord memory r0 = _record(ws[0]);
        ExitRecord memory r1 = _record(ws[1]);
        rollup.setFirstUnresolvedNode(1);
        _sellTo(ws[0], seller, address(vault), 0);
        _sellTo(ws[1], seller, address(vault), 0);
        rollup.setFirstUnresolvedNode(NODE + 1);
        vault.writeOff(r0);
        vault.writeOff(r1);
        assertEq(vault.impairedExits(), 2);

        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmed(ws[1]);
        _execute(ws[1]);
        vault.collect(r1, PayoutProof(r1.index, root2, proof2));
        assertEq(vault.impairedExits(), 1);
        assertEq(vault.maxDeposit(attacker), 0, "one exit still impaired");

        vm.warp(block.timestamp + vault.IMPAIRMENT_WINDOW());
        vault.finalizeWriteOff(r0);
        assertEq(vault.impairedExits(), 0);
        assertGt(vault.maxDeposit(attacker), 0);
    }
}
