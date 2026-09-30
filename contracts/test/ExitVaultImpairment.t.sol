// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ExitClaim, ExitRecord, IExitMarket, PayoutProof} from "../interfaces/IExitMarket.sol";
import {IExitVault} from "../interfaces/IExitVault.sol";
import {ExitLeaf} from "../libraries/ExitLeaf.sol";
import {ExitVault} from "../ExitVault.sol";
import {MockExtendedGateway} from "./mocks/MockArbitrum.sol";
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

    // ============================================================ H3: one impairment window per rejected root

    /// @dev `n` exits of ONE node (one send root), all bought, node rejected; returns their records.
    function _buyManyFromOneNodeAndReject(uint64 nodeNum, uint256 firstExit, uint256 n)
        private
        returns (Withdrawal[] memory ws, ExitRecord[] memory recs)
    {
        ws = _createOn(gateway, nodeNum, firstExit, n, seller, 1e6);
        recs = new ExitRecord[](n);
        for (uint256 i; i < n; ++i) {
            _sellTo(ws[i], seller, address(vault), 0);
            recs[i] = _record(ws[i]);
        }
        rollup.setFirstUnresolvedNode(nodeNum + 1);
    }

    function test_H3_laterWriteOffsOfTheSameRootDoNotExtendTheWindow() public {
        (, ExitRecord[] memory recs) = _buyManyFromOneNodeAndReject(NODE, 1, 3);
        uint256 opened = vm.getBlockTimestamp();
        vault.writeOff(recs[0]);
        vm.warp(opened + 6 days);
        vault.writeOff(recs[1]);
        vm.warp(opened + 13 days);
        vault.writeOff(recs[2]);
        assertEq(vault.impairedExits(), 3);

        vm.warp(opened + vault.IMPAIRMENT_WINDOW() - 1);
        vm.expectPartialRevert(IExitVault.ImpairmentWindowOpen.selector);
        vault.finalizeWriteOff(recs[2]);

        vm.warp(opened + vault.IMPAIRMENT_WINDOW());
        for (uint256 i; i < 3; ++i) {
            vault.finalizeWriteOff(recs[i]);
        }
        assertEq(vault.impairedExits(), 0, "the last write-off got the remainder of the first one's window");
        assertGt(vault.maxDeposit(attacker), 0);
    }

    function test_H3_writeOffAfterTheRootWindowElapsedIsBornFinalizedAndDoesNotPauseDepositsAgain() public {
        (Withdrawal[] memory ws, ExitRecord[] memory recs) = _buyManyFromOneNodeAndReject(NODE, 1, 2);
        uint256 opened = vm.getBlockTimestamp();
        vault.writeOff(recs[0]);
        vm.warp(opened + vault.IMPAIRMENT_WINDOW() + 1 days);
        vault.finalizeWriteOff(recs[0]);
        assertEq(vault.maxDeposit(attacker), 0, "recs[1] is still an open rejected exit: deposits stay paused");

        vault.writeOff(recs[1]);

        (, , bool writtenOff, , bool finalized) = vault.purchases(_id(ws[1]));
        assertTrue(writtenOff);
        assertTrue(finalized, "the root's window is over: nothing left to wait for");
        assertEq(vault.impairedExits(), 0);
        assertGt(vault.maxDeposit(attacker), 0);
        vm.expectRevert(abi.encodeWithSelector(IExitVault.NotImpaired.selector, _id(ws[1])));
        vault.finalizeWriteOff(recs[1]);
    }

    function test_H3_collectingABornFinalizedWriteOffDoesNotUnderflowTheImpairedCounter() public {
        (Withdrawal[] memory ws, ExitRecord[] memory recs) = _buyManyFromOneNodeAndReject(NODE, 1, 2);
        vault.writeOff(recs[0]);
        vm.warp(vm.getBlockTimestamp() + vault.IMPAIRMENT_WINDOW());
        vault.writeOff(recs[1]); // born finalized
        assertEq(vault.impairedExits(), 1);

        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmed(ws[1]);
        _execute(ws[1]);
        vault.collect(recs[1], PayoutProof(recs[1].index, root2, proof2));

        assertEq(vault.impairedExits(), 1, "only recs[0] is still impaired");
    }

    function test_H3_differentRootsHaveIndependentWindows() public {
        (, ExitRecord[] memory a) = _buyManyFromOneNodeAndReject(NODE, 1, 1);
        (, ExitRecord[] memory b) = _buyManyFromOneNodeAndReject(NODE + 1, 10, 1);
        uint256 t0 = vm.getBlockTimestamp();
        vault.writeOff(a[0]);
        vm.warp(t0 + 13 days);
        vault.writeOff(b[0]);

        vm.warp(t0 + vault.IMPAIRMENT_WINDOW());
        vault.finalizeWriteOff(a[0]);
        assertEq(vault.impairedExits(), 1);
        assertEq(vault.maxDeposit(attacker), 0, "root B has its own window");
        vm.expectPartialRevert(IExitVault.ImpairmentWindowOpen.selector);
        vault.finalizeWriteOff(b[0]);

        vm.warp(t0 + 13 days + vault.IMPAIRMENT_WINDOW());
        vault.finalizeWriteOff(b[0]);
        assertGt(vault.maxDeposit(attacker), 0);
    }

    /// @dev Two allowlisted gateways of ONE rollup can commit exits under the same send root: that is one
    ///      rejected root, so one window (keyed by rollup + send root, not by gateway).
    function test_H3_twoGatewaysOfOneRollupShareTheWindowOfTheirCommonRoot() public {
        MockExtendedGateway gw2 = new MockExtendedGateway(address(0xBEEF), address(inbox));
        vm.prank(owner);
        market.allowGateway(address(gw2), verifier);
        Withdrawal[] memory ws = _twoGatewayExitsUnderOneRoot(gw2, 101);
        ExitRecord memory r0 = _record(ws[0]);
        ExitRecord memory r1 = _record(ws[1]);
        assertEq(r0.sendRoot, r1.sendRoot);
        _sellTo(ws[0], seller, address(vault), 0);
        _sellTo(ws[1], seller, address(vault), 0);
        rollup.setFirstUnresolvedNode(102);

        uint256 t0 = vm.getBlockTimestamp();
        vault.writeOff(r0);
        vm.warp(t0 + 13 days);
        vault.writeOff(r1);
        vm.warp(t0 + vault.IMPAIRMENT_WINDOW());

        vault.finalizeWriteOff(r0);
        vault.finalizeWriteOff(r1); // would still revert if the window were keyed by gateway
        assertEq(vault.impairedExits(), 0);
    }

    function _twoGatewayExitsUnderOneRoot(MockExtendedGateway gw2, uint64 nodeNum)
        private
        returns (Withdrawal[] memory ws)
    {
        MockExtendedGateway[2] memory gws = [gateway, gw2];
        bytes32[] memory items = new bytes32[](2);
        ExitClaim[] memory claims = new ExitClaim[](2);
        for (uint256 i; i < 2; ++i) {
            ExitLeaf.Leaf memory leaf = ExitLeaf.Leaf({
                childGateway: gws[i].counterpartGateway(),
                parentGateway: address(gws[i]),
                l1Token: address(usdg),
                from: seller,
                initialDestination: seller,
                amount: 1e6,
                exitNum: 40 + i,
                l2Block: 1000 + i,
                l1Block: 500 + i,
                l2Timestamp: 1_700_000_000 + i
            });
            items[i] = _leafHash(leaf);
            claims[i] = ExitClaim({
                initialDestination: seller,
                l1Token: address(usdg),
                from: seller,
                amount: 1e6,
                l2Block: leaf.l2Block,
                l1Block: leaf.l1Block,
                l2Timestamp: leaf.l2Timestamp,
                index: i,
                proof: new bytes32[](0),
                sendRoot: bytes32(0),
                nodeNum: nodeNum,
                blockHash: BLOCK_HASH
            });
        }
        (bytes32 root, bytes32[][] memory proofs) = _buildTree(items);
        _publishPending(root, nodeNum);
        ws = new Withdrawal[](2);
        for (uint256 i; i < 2; ++i) {
            claims[i].proof = proofs[i];
            claims[i].sendRoot = root;
            ws[i] = Withdrawal({gateway: address(gws[i]), exitNum: 40 + i, claim: claims[i]});
        }
    }
}
