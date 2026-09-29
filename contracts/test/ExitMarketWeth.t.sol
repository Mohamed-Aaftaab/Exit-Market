// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ExitLeaf} from "../libraries/ExitLeaf.sol";
import {ExitRecord, IExitMarket, PayoutProof} from "../interfaces/IExitMarket.sol";
import {ExitVault} from "../ExitVault.sol";
import {ExitFixture} from "./utils/ExitFixture.sol";

/// @dev WETH-gateway style leaves carry callvalue = amount; the market must accept both leaf flavours.
contract ExitMarketWethTest is ExitFixture {
    uint256 private constant PRICE = 9_900e6;

    function test_list_acceptsLeafWithValueEqualToAmountAndStoresThatHash() public {
        wethLeaves = true;
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        ExitLeaf.Leaf memory leaf = _leafOf(ws[1]);
        bytes32 wethHash = ExitLeaf.itemHashWithValue(leaf, AMOUNT);
        ExitRecord memory rec = _record(ws[1]);
        assertEq(rec.itemHash, wethHash);
        assertTrue(rec.itemHash != ExitLeaf.itemHash(leaf));
        bytes32 id = _id(ws[1]);

        vm.expectEmit(true, false, false, true, address(market));
        emit IExitMarket.ExitVerified(id, rec);
        _list(ws[1], seller, PRICE);

        assertEq(market.getListing(id).exit.itemHash, wethHash);
        assertEq(_ownerOf(ws[1]), address(market));
    }

    function test_list_valueZeroLeafStillStoresValueZeroHash() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[1], seller, PRICE);

        assertEq(market.getListing(id).exit.itemHash, ExitLeaf.itemHash(_leafOf(ws[1])));
    }

    function test_list_revertsProofMismatchWhenNeitherValueMatches() public {
        wethLeaves = true;
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        ws[1].claim.amount = AMOUNT + 1;
        // Reported `computed` is the value = amount retry.
        bytes32 item = ExitLeaf.itemHashWithValue(_leafOf(ws[1]), AMOUNT + 1);
        bytes32 computed = ExitLeaf.rootFromItem(item, ws[1].claim.proof, ws[1].claim.index);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ProofMismatch.selector, computed, ws[1].claim.sendRoot));
        _list(ws[1], seller, PRICE);
    }

    function test_list_revertsProofMismatchForValueZeroTreeWithTamperedAmount() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        ws[0].claim.amount = AMOUNT + 1;
        bytes32 item = ExitLeaf.itemHashWithValue(_leafOf(ws[0]), AMOUNT + 1);
        bytes32 computed = ExitLeaf.rootFromItem(item, ws[0].claim.proof, ws[0].claim.index);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ProofMismatch.selector, computed, ws[0].claim.sendRoot));
        _list(ws[0], seller, PRICE);
    }

    function test_settle_paysSellerForWethStyleLeaf() public {
        wethLeaves = true;
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[1], seller, PRICE);
        _confirm(ws[1]);
        _execute(ws[1]);

        market.settle(id, _ownPayout(ws[1]));

        assertEq(usdg.balanceOf(seller), AMOUNT);
    }

    function test_settle_paysSellerForWethStyleLeafViaSiblingRootAtOtherIndex() public {
        wethLeaves = true;
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        rollup.setFirstUnresolvedNode(NODE + 1);
        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmedAt(ws[0], 4);
        gateway.simulateExecute(outbox, 4, ws[0].exitNum, seller, usdg, AMOUNT);

        market.settle(id, PayoutProof(4, root2, proof2));

        assertEq(usdg.balanceOf(seller), AMOUNT);
    }

    function test_vaultCollect_worksForWethStyleLeaf() public {
        wethLeaves = true;
        ExitVault vault = new ExitVault(IERC20(address(usdg)), market, owner, "V", "V");
        _fund(seller, address(vault), 100_000e6);
        vm.prank(seller);
        vault.deposit(100_000e6, seller);
        Withdrawal[] memory ws = _createWithdrawals(1, buyer, AMOUNT);
        _sellTo(ws[0], buyer, address(vault), 0);
        ExitRecord memory rec = _record(ws[0]);
        _confirm(ws[0]);
        _execute(ws[0]);

        vault.collect(rec, _ownPayout(ws[0]));

        assertEq(vault.outstandingCost(), 0);
        assertEq(vault.idleAssets(), usdg.balanceOf(address(vault)));
        assertGt(vault.totalAssets(), 100_000e6);
    }
}
