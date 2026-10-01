// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IExitMarket} from "../interfaces/IExitMarket.sol";
import {ExitFixture} from "./utils/ExitFixture.sol";
import {TestBuyer} from "./utils/TestBuyers.sol";

/// @dev A smart wallet with a standing allowance whose fallback answers every unknown call with `reply`.
contract FallbackWallet {
    bytes private reply;

    constructor(bytes memory reply_) {
        reply = reply_;
    }

    function approve(IERC20 token, address spender, uint256 amount) external {
        token.approve(spender, amount);
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return reply;
    }
}

/// @notice v4 hardening (2026-10-01): a pending exit stops being sellable the moment its node is contested, and a
///         buyer must explicitly consent before the market pulls its payment.
contract Round6HardeningTest is ExitFixture {
    uint256 private constant PRICE = 9_900e6;

    TestBuyer private tb;

    function setUp() public override {
        super.setUp();
        tb = new TestBuyer(IERC20(address(usdg)), PRICE);
        usdg.mint(address(tb), 10 * PRICE);
    }

    // ---------------------------------------------------------------- contested nodes

    function test_saleIsRefusedWhileTheExitsNodeHasARival() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT); // node NODE, child of node 0
        _publishChild(keccak256("rival root"), NODE + 1, 0); // a validator disputes NODE

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        _sellTo(ws[0], seller, address(tb), 0);
        assertEq(_ownerOf(ws[0]), seller);
    }

    function test_saleResumesOnceTheOlderRivalIsRejected() public {
        _publishPending(keccak256("fake root"), NODE); // fake node, child of node 0
        _publishChild(bytes32(0), NODE + 1, 0); // honest node, its rival
        Withdrawal[] memory ws = _createOn(gateway, NODE + 1, 1, 1, seller, AMOUNT);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE + 1));
        _sellTo(ws[0], seller, address(tb), 0);

        rollup.setFirstUnresolvedNode(NODE + 1); // the fake node is rejected
        _sellTo(ws[0], seller, address(tb), 0);
        assertEq(_ownerOf(ws[0]), address(tb));
        assertEq(usdg.balanceOf(seller), PRICE - _fee(PRICE));
    }

    function test_aListedExitCannotBeBoughtOnceItsNodeIsContestedButCanBeCancelled() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _publishChild(keccak256("rival root"), NODE + 1, 0);
        _fund(buyer, address(market), PRICE);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        market.buy(id, PRICE);

        vm.prank(seller);
        market.cancel(id);
        assertEq(_ownerOf(ws[0]), seller);
        assertEq(usdg.balanceOf(buyer), PRICE);
    }

    function test_aDisputeAboveTheExitsNodeAlsoStopsTheSale() public {
        _publishPending(keccak256("parent root"), NODE); // pending parent
        Withdrawal[] memory ws = _createOn(gateway, NODE + 1, 1, 1, seller, AMOUNT); // child of NODE
        _publishChild(keccak256("rival of the parent"), NODE + 2, 0);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE + 1));
        _sellTo(ws[0], seller, address(tb), 0);
    }

    // ---------------------------------------------------------------- buyer consent

    function test_aBuyerReturningTheWrongMagicIsNotCharged() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        tb.setMagic(0xdeadbeef);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.NotExitBuyer.selector, address(tb)));
        _sellTo(ws[0], seller, address(tb), 0);
        assertEq(usdg.balanceOf(address(tb)), 10 * PRICE);
    }

    function test_aWalletWhoseFallbackReturnsAPriceCannotBeCharged() public {
        FallbackWallet wallet = new FallbackWallet(abi.encode(PRICE)); // 32 bytes: not even decodable
        _standingAllowance(wallet);
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);

        vm.expectRevert();
        _sellTo(ws[0], seller, address(wallet), 0);
        assertEq(usdg.balanceOf(address(wallet)), PRICE);
    }

    function test_aWalletWhoseFallbackReturnsADecodableReplyCannotBeCharged() public {
        FallbackWallet wallet = new FallbackWallet(abi.encode(bytes4(0x12345678), PRICE));
        _standingAllowance(wallet);
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.NotExitBuyer.selector, address(wallet)));
        _sellTo(ws[0], seller, address(wallet), 0);
        assertEq(usdg.balanceOf(address(wallet)), PRICE);
        assertEq(_ownerOf(ws[0]), seller);
    }

    function _standingAllowance(FallbackWallet wallet) private {
        usdg.mint(address(wallet), PRICE);
        wallet.approve(usdg, address(market), type(uint256).max);
    }
}
