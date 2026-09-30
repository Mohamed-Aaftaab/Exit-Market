// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IExitMarket} from "../interfaces/IExitMarket.sol";
import {IExitIntentRouter} from "../interfaces/IExitIntentRouter.sol";
import {IExitVault} from "../interfaces/IExitVault.sol";
import {ExitIntentRouter} from "../ExitIntentRouter.sol";
import {IntentFixture} from "./utils/IntentFixture.sol";
import {TestBuyer} from "./utils/TestBuyers.sol";

/// @dev Hostile gateway named in a (user-signed) order: pays the router like a real gateway would, then tries
///      to re-enter settle(). Isolates the router's own reentrancy guard (the market has one too).
contract ReentrantGateway {
    IERC20 private immutable _token;
    address private immutable _router;
    uint256 private immutable _payment;

    bytes public replay;
    bool public attempted;
    bool public reentrySucceeded;
    bytes4 public reentryError;

    constructor(IERC20 token_, address router_, uint256 payment_) {
        _token = token_;
        _router = router_;
        _payment = payment_;
    }

    function arm(bytes calldata data) external {
        replay = data;
    }

    function transferExitAndCall(uint256, address, address, bytes calldata, bytes calldata) external {
        if (attempted) return;
        attempted = true;
        _token.transfer(_router, _payment);
        (bool ok, bytes memory ret) = _router.call(replay);
        reentrySucceeded = ok;
        if (!ok) reentryError = bytes4(ret);
    }
}

/// @dev Gasless sign-once exits: settle(), EIP-712 signatures, proceeds protection, market failures, reentrancy.
contract ExitIntentRouterTest is IntentFixture {
    // ================================================================ construction / EIP-712

    function test_constructor_bindsMarketAndItsPaymentToken() public view {
        assertEq(router.market(), address(market));
        assertEq(router.paymentToken(), address(usdg));
    }

    function test_constructor_revertsWhenMarketIsNotAMarket() public {
        vm.expectRevert();
        new ExitIntentRouter(address(0), address(vault));

        vm.expectRevert();
        new ExitIntentRouter(stranger, address(vault));
    }

    function test_constructor_revertsOnZeroBuyer() public {
        vm.expectRevert(IExitIntentRouter.ZeroAddress.selector);
        new ExitIntentRouter(address(market), address(0));
    }

    function test_eip712Domain_isExitIntentRouterVersion1OnThisChain() public view {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            IERC5267(address(router)).eip712Domain();

        assertEq(name, "ExitIntentRouter");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(router));
    }

    function test_orderDigest_matchesIndependentEip712Encoding() public view {
        IExitIntentRouter.SellOrder memory o =
            IExitIntentRouter.SellOrder(address(gateway), 7, address(vault), 123e6, 4e6, 1_800_000_000);

        assertEq(router.orderDigest(o), _digest(address(router), o));
    }

    function test_orderDigest_differsPerRouterAndPerField() public {
        ExitIntentRouter other = new ExitIntentRouter(address(market), address(vault));
        IExitIntentRouter.SellOrder memory o =
            IExitIntentRouter.SellOrder(address(gateway), 7, address(vault), 123e6, 4e6, 1_800_000_000);
        IExitIntentRouter.SellOrder memory o2 = _clone(o);
        o2.relayerFee = 5e6;

        assertTrue(router.orderDigest(o) != other.orderDigest(o));
        assertTrue(router.orderDigest(o) != router.orderDigest(o2));
    }

    // ================================================================ settle: happy paths

    function test_settle_gaslessSellPaysSellerRelayerAndVaultOwnsExit() public {
        Withdrawal[] memory ws = _intents(3);
        Withdrawal memory w = ws[1];
        uint256 price = vault.quote(_record(w));
        uint256 marketFee = _fee(price);
        uint256 received = price - marketFee;
        IExitIntentRouter.SellOrder memory o = _order(w, received - RELAYER_FEE, RELAYER_FEE);
        bytes memory sig = _signed(o);
        bytes32 id = _id(w);
        assertEq(user.balance, 0, "seller has no gas token");
        assertEq(_ownerOf(w), address(router));

        vm.expectEmit(true, true, true, true, address(router));
        emit IExitIntentRouter.IntentSettled(id, user, relayer, received - RELAYER_FEE, RELAYER_FEE);
        uint256 proceeds = _settleAs(relayer, w, o, sig);

        assertEq(proceeds, received - RELAYER_FEE, "return value is the seller's share");
        assertEq(usdg.balanceOf(user), price - marketFee - RELAYER_FEE, "seller: quote - market fee - relayer fee");
        assertEq(usdg.balanceOf(relayer), RELAYER_FEE, "relayer earns its fee");
        assertEq(usdg.balanceOf(address(router)), 0, "router holds no payment tokens");
        assertEq(market.accruedFees(), marketFee, "market fee accrues to the market");
        assertEq(_ownerOf(w), address(vault), "vault owns the exit");
        assertEq(vault.outstandingCost(), price);
        assertEq(vault.idleAssets(), LP_DEPOSIT - price);
    }

    function test_settle_anyoneCanRelay() public {
        Withdrawal[] memory ws = _intents(3);
        address relayerB = makeAddr("relayerB");
        uint256 received = _received(ws[0]); // identical for all three exits (same amount, block and vault params)
        IExitIntentRouter.SellOrder memory o0 = _order(ws[0], 0, RELAYER_FEE);
        IExitIntentRouter.SellOrder memory o1 = _order(ws[1], 0, RELAYER_FEE);
        IExitIntentRouter.SellOrder memory o2 = _order(ws[2], 0, RELAYER_FEE);

        _settleAs(relayer, ws[0], o0, _signed(o0));
        _settleAs(relayerB, ws[1], o1, _signed(o1));
        _settleAs(user, ws[2], o2, _signed(o2)); // the seller may also relay for themselves

        assertEq(usdg.balanceOf(relayer), RELAYER_FEE);
        assertEq(usdg.balanceOf(relayerB), RELAYER_FEE);
        // the self-relayed order pays the fee back to the seller, so only two fees leave the seller
        assertEq(usdg.balanceOf(user), 3 * received - 2 * RELAYER_FEE);
        assertEq(usdg.balanceOf(address(router)), 0);
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(_ownerOf(ws[i]), address(vault));
        }
    }

    function test_settle_zeroRelayerFeeSendsEverythingToSeller() public {
        Withdrawal[] memory ws = _intents(1);
        uint256 received = _received(ws[0]);

        uint256 proceeds = _settleSigned(ws[0], _order(ws[0], received, 0));

        assertEq(proceeds, received);
        assertEq(usdg.balanceOf(user), received);
        assertEq(usdg.balanceOf(relayer), 0);
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    function test_settle_succeedsAtExactDeadline() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);
        vm.warp(o.deadline);

        _settleAs(relayer, ws[0], o, sig);

        assertEq(_ownerOf(ws[0]), address(vault));
    }

    function test_settle_keepsProceedsOfDifferentSellersSeparate() public {
        address user2 = vm.addr(USER2_PK);
        address relayerB = makeAddr("relayerB");
        Withdrawal[] memory a = _intents(1);
        Withdrawal[] memory b = _createFrom(gateway, NODE + 1, 10, 1, user2, address(router), AMOUNT / 2);
        IExitIntentRouter.SellOrder memory oa = _order(a[0], 0, RELAYER_FEE);
        IExitIntentRouter.SellOrder memory ob = _order(b[0], 0, 3e6);

        _settleAs(relayer, a[0], oa, _signed(oa));
        _settleAs(relayerB, b[0], ob, _sign(USER2_PK, address(router), ob));

        assertEq(usdg.balanceOf(user), _receivedAfterSale(a[0]) - RELAYER_FEE);
        assertEq(usdg.balanceOf(user2), _receivedAfterSale(b[0]) - 3e6);
        assertEq(usdg.balanceOf(relayer), RELAYER_FEE);
        assertEq(usdg.balanceOf(relayerB), 3e6);
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    /// @dev Quote-based receipt recomputed from the recorded purchase (the vault already bought, so quote() is moot).
    function _receivedAfterSale(Withdrawal memory w) private view returns (uint256) {
        (, uint256 cost,,,) = vault.purchases(_id(w));
        return cost - _fee(cost);
    }

    function test_settle_forwardsOnlyTheBalanceDeltaAndLeavesOtherRouterFundsAlone() public {
        Withdrawal[] memory ws = _intents(2);
        _execute(ws[0]); // exit executed while router-owned: its tokens sit in the router, unrelated to ws[1]
        uint256 stranded = usdg.balanceOf(address(router));
        assertEq(stranded, AMOUNT);
        uint256 received = _received(ws[1]);

        _settleSigned(ws[1], _order(ws[1], 0, RELAYER_FEE));

        assertEq(usdg.balanceOf(user), received - RELAYER_FEE);
        assertEq(usdg.balanceOf(relayer), RELAYER_FEE);
        assertEq(usdg.balanceOf(address(router)), stranded, "pre-existing router funds are untouched");
    }

    function test_settle_worksForWethStyleLeaf() public {
        wethLeaves = true;
        Withdrawal[] memory ws = _intents(2);
        uint256 received = _received(ws[1]);

        _settleSigned(ws[1], _order(ws[1], 0, RELAYER_FEE));

        assertEq(usdg.balanceOf(user), received - RELAYER_FEE);
        assertEq(_ownerOf(ws[1]), address(vault));
    }

    // ================================================================ settle: signature checks

    function test_settle_revertsBadSignatureWhenSignedByAnotherKey() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);

        _expectBadSignature(ws[0], o, _sign(ATTACKER_PK, address(router), o));
        _expectBadSignature(ws[0], o, _sign(USER2_PK, address(router), o));
    }

    /// @dev Only the bound buyer is ever accepted, so a tampered buyer is rejected before the signature check.
    function test_settle_rejectsATamperedBuyerOutright() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory signed = _order(ws[0], 0, RELAYER_FEE);
        IExitIntentRouter.SellOrder memory tampered = _clone(signed);
        tampered.buyer = attacker;
        bytes memory sig = _signed(signed);

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.BuyerNotAllowed.selector, attacker));
        _settleAs(relayer, ws[0], tampered, sig);
        assertEq(_ownerOf(ws[0]), address(router));
    }

    function test_settle_revertsBadSignatureWhenMinProceedsChangedAfterSigning() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory signed = _order(ws[0], 1_000e6, RELAYER_FEE);
        IExitIntentRouter.SellOrder memory tampered = _clone(signed);
        tampered.minProceeds = 0;

        _expectBadSignature(ws[0], tampered, _signed(signed));
    }

    function test_settle_revertsBadSignatureWhenRelayerFeeChangedAfterSigning() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory signed = _order(ws[0], 0, RELAYER_FEE);
        IExitIntentRouter.SellOrder memory tampered = _clone(signed);
        tampered.relayerFee = RELAYER_FEE * 2; // a greedy relayer

        _expectBadSignature(ws[0], tampered, _signed(signed));
    }

    function test_settle_revertsBadSignatureWhenDeadlineChangedAfterSigning() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory signed = _order(ws[0], 0, RELAYER_FEE);
        IExitIntentRouter.SellOrder memory tampered = _clone(signed);
        tampered.deadline = signed.deadline + 30 days;

        _expectBadSignature(ws[0], tampered, _signed(signed));
    }

    function test_settle_revertsBadSignatureWhenExitNumChangedAfterSigning() public {
        Withdrawal[] memory ws = _intents(2);
        IExitIntentRouter.SellOrder memory signed = _order(ws[0], 0, RELAYER_FEE);
        IExitIntentRouter.SellOrder memory tampered = _clone(signed);
        tampered.exitNum = ws[1].exitNum;

        _expectBadSignature(ws[0], tampered, _signed(signed));
    }

    /// @dev Only market-allowed gateways are accepted, so an unknown gateway is rejected before the signature check.
    function test_settle_rejectsATamperedGatewayOutright() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory signed = _order(ws[0], 0, RELAYER_FEE);
        IExitIntentRouter.SellOrder memory tampered = _clone(signed);
        tampered.gateway = makeAddr("otherGateway");
        bytes memory sig = _signed(signed);

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.GatewayNotAllowed.selector, tampered.gateway));
        _settleAs(relayer, ws[0], tampered, sig);
    }

    function test_settle_revertsBadSignatureWhenSignedForAnotherRouter() public {
        ExitIntentRouter routerB = new ExitIntentRouter(address(market), address(vault));
        Withdrawal[] memory ws = _createFrom(gateway, NODE, 1, 1, user, address(routerB), AMOUNT);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sigForA = _sign(USER_PK, address(router), o);
        bytes memory sigForB = _sign(USER_PK, address(routerB), o);

        vm.expectRevert(IExitIntentRouter.BadSignature.selector);
        vm.prank(relayer);
        routerB.settle(ws[0].claim, o, sigForA);

        vm.prank(relayer); // control: the same order signed for router B settles on B
        routerB.settle(ws[0].claim, o, sigForB);
        assertEq(_ownerOf(ws[0]), address(vault));
    }

    function test_settle_revertsBadSignatureWhenChainIdDiffers() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sigForOriginalChain = _signed(o);

        // Note: restoring the original chain id with vm.chainId does not propagate to called contracts in the
        // Hardhat runner, so the control signs for the new chain instead of switching back.
        vm.chainId(block.chainid + 1);
        bytes memory sigForNewChain = _signed(o);

        vm.expectRevert(IExitIntentRouter.BadSignature.selector);
        _settleAs(relayer, ws[0], o, sigForOriginalChain);
        assertEq(_ownerOf(ws[0]), address(router));

        _settleAs(relayer, ws[0], o, sigForNewChain); // control: the signature bound to this chain works
        assertEq(_ownerOf(ws[0]), address(vault));
    }

    function test_settle_revertsOnMalformedSignatures() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory valid = _signed(o);
        bytes memory garbage65 = new bytes(65);
        garbage65[64] = bytes1(uint8(29)); // invalid v
        bytes memory truncated = new bytes(64);
        for (uint256 i = 0; i < 64; ++i) {
            truncated[i] = valid[i];
        }

        vm.expectRevert();
        _settleAs(relayer, ws[0], o, "");
        vm.expectRevert();
        _settleAs(relayer, ws[0], o, garbage65);
        vm.expectRevert();
        _settleAs(relayer, ws[0], o, truncated);
        vm.expectRevert();
        _settleAs(relayer, ws[0], o, abi.encodePacked(valid, uint8(0))); // 66 bytes

        assertEq(_ownerOf(ws[0]), address(router));
    }

    function test_settle_rejectsMalleatedHighSSignature() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, _digest(address(router), o));
        assertLe(uint256(s), SECP256K1_N / 2, "signer produced a low-s signature");
        bytes memory malleated = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));

        vm.expectRevert();
        _settleAs(relayer, ws[0], o, malleated);
    }

    function test_settle_revertsForZeroSenderWithGarbageSignature() public {
        // ecrecover returns address(0) for garbage; a leaf whose sender is address(0) must not accept that.
        Withdrawal[] memory ws = _createFrom(gateway, NODE, 1, 1, address(0), address(router), AMOUNT);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);

        vm.expectRevert();
        _settleAs(relayer, ws[0], o, new bytes(65));

        assertEq(_ownerOf(ws[0]), address(router));
    }

    // ================================================================ settle: order validity

    function test_settle_revertsOrderExpiredAfterDeadline() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);
        vm.warp(uint256(o.deadline) + 1);

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.OrderExpired.selector, o.deadline));
        _settleAs(relayer, ws[0], o, sig);

        assertEq(_ownerOf(ws[0]), address(router));
    }

    function test_settle_revertsNotRouterExitWhenClaimIsForUserOwnedExit() public {
        Withdrawal[] memory ws = _createWithdrawals(1, user, AMOUNT); // initialDestination = user, not the router
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);

        vm.expectRevert(IExitIntentRouter.NotRouterExit.selector);
        _settleAs(relayer, ws[0], o, sig);

        assertEq(_ownerOf(ws[0]), user);
    }

    function test_settle_revertsWhenSameOrderIsReplayed() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);
        _settleAs(relayer, ws[0], o, sig);
        uint256 userBefore = usdg.balanceOf(user);
        uint256 relayerBefore = usdg.balanceOf(relayer);

        vm.expectRevert("NOT_EXPECTED_SENDER"); // the exit already moved to the vault
        _settleAs(relayer, ws[0], o, sig);
        vm.expectRevert("NOT_EXPECTED_SENDER");
        _settleAs(makeAddr("relayerB"), ws[0], o, sig);

        assertEq(usdg.balanceOf(user), userBefore);
        assertEq(usdg.balanceOf(relayer), relayerBefore);
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(_ownerOf(ws[0]), address(vault));
    }

    // ================================================================ settle: proceeds protection

    function test_settle_revertsProceedsBelowMinAndLeavesExitWithRouter() public {
        Withdrawal[] memory ws = _intents(1);
        uint256 received = _received(ws[0]);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], received - RELAYER_FEE + 1, RELAYER_FEE);
        bytes memory sig = _signed(o);

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.ProceedsBelowMin.selector, received, received + 1));
        _settleAs(relayer, ws[0], o, sig);

        assertEq(_ownerOf(ws[0]), address(router), "exit ownership unchanged");
        assertEq(usdg.balanceOf(user), 0);
        assertEq(usdg.balanceOf(relayer), 0);
        assertEq(vault.outstandingCost(), 0);
        // the exit is still sellable with a satisfiable order
        _settleSigned(ws[0], _order(ws[0], received - RELAYER_FEE, RELAYER_FEE));
        assertEq(_ownerOf(ws[0]), address(vault));
    }

    function test_settle_succeedsWhenMinProceedsEqualsExactlyWhatSellerGets() public {
        Withdrawal[] memory ws = _intents(1);
        uint256 received = _received(ws[0]);

        uint256 proceeds = _settleSigned(ws[0], _order(ws[0], received - RELAYER_FEE, RELAYER_FEE));

        assertEq(proceeds, received - RELAYER_FEE);
        assertEq(usdg.balanceOf(user), received - RELAYER_FEE);
    }

    function test_settle_revertsWhenRelayerFeeAloneExceedsWhatWasReceived() public {
        Withdrawal[] memory ws = _intents(1);
        uint256 received = _received(ws[0]);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, received + 1);
        bytes memory sig = _signed(o);

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.ProceedsBelowMin.selector, received, received + 1));
        _settleAs(relayer, ws[0], o, sig);
    }

    function test_settle_revertsWhenMinProceedsPlusFeeOverflows() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], type(uint256).max, 1);
        bytes memory sig = _signed(o);

        vm.expectRevert();
        _settleAs(relayer, ws[0], o, sig);

        assertEq(_ownerOf(ws[0]), address(router));
    }

    function test_settle_revertsWhenVaultOwnerRaisesFeesAfterSigning() public {
        Withdrawal[] memory ws = _intents(1);
        uint256 signedReceived = _received(ws[0]);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], signedReceived - RELAYER_FEE, RELAYER_FEE);
        bytes memory sig = _signed(o);
        vm.prank(owner);
        vault.setParams(500, 1000, type(uint256).max, true); // max base fee: quote drops
        uint256 newReceived = _received(ws[0]);
        assertLt(newReceived, signedReceived);

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.ProceedsBelowMin.selector, newReceived, signedReceived));
        _settleAs(relayer, ws[0], o, sig);
    }

    function test_settle_revertsWhenBuyerPaysLessThanRelayerFee() public {
        Withdrawal[] memory ws = _intents(1);
        uint256 received = _received(ws[0]);
        uint256 greedyFee = received + 1; // the vault's payment cannot even cover the relayer
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, greedyFee);
        bytes memory sig = _signed(o);

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.ProceedsBelowMin.selector, received, greedyFee));
        _settleAs(relayer, ws[0], o, sig);

        assertEq(_ownerOf(ws[0]), address(router));
    }

    function test_settle_rejectsAnUntrustedZeroPayingBuyer() public {
        Withdrawal[] memory ws = _intents(1);
        TestBuyer freeloader = new TestBuyer(IERC20(address(usdg)), 0);
        IExitIntentRouter.SellOrder memory o = _orderTo(ws[0], address(freeloader), 0, 0);
        bytes memory sig = _signed(o);

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.BuyerNotAllowed.selector, address(freeloader)));
        _settleAs(relayer, ws[0], o, sig);
    }

    function test_settle_revertsWhenVaultRefusesAndReclaimStillReturnsTheExit() public {
        Withdrawal[] memory ws = _intents(1);
        vm.prank(owner);
        vault.setParams(10, 1000, AMOUNT - 1, true); // vault now refuses exits this large
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);

        vm.expectRevert(abi.encodeWithSelector(IExitVault.ExitTooLarge.selector, AMOUNT));
        _settleAs(relayer, ws[0], o, sig);
        assertEq(_ownerOf(ws[0]), address(router));

        _reclaimAs(user, ws[0]);
        assertEq(_ownerOf(ws[0]), user);
    }

    // ================================================================ settle: proof / market failures

    function test_settle_revertsProofMismatchWhenClaimFromIsForged() public {
        Withdrawal[] memory forged = _intents(1);
        forged[0].claim.from = attacker; // attacker claims a victim's exit and signs with his own key
        bytes32 computed = _mismatchRoot(forged[0]);
        bytes32 sendRoot = forged[0].claim.sendRoot;
        IExitIntentRouter.SellOrder memory o = _order(forged[0], 0, RELAYER_FEE);
        bytes memory sig = _sign(ATTACKER_PK, address(router), o);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ProofMismatch.selector, computed, sendRoot));
        _settleAs(attacker, forged[0], o, sig);

        assertEq(usdg.balanceOf(attacker), 0);
        assertEq(_ownerOf(forged[0]), address(router), "victim's exit untouched");
    }

    function test_settle_revertsProofMismatchWhenRelayerTampersClaimAmount() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);
        ws[0].claim.amount = AMOUNT * 10;

        vm.expectPartialRevert(IExitMarket.ProofMismatch.selector);
        _settleAs(relayer, ws[0], o, sig);
    }

    function test_settle_revertsProofMismatchWhenClaimBelongsToAnotherExitThanTheOrder() public {
        Withdrawal[] memory ws = _intents(2);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE); // signed for exit 1
        bytes memory sig = _signed(o);

        vm.expectPartialRevert(IExitMarket.ProofMismatch.selector);
        _settleAs(relayer, ws[1], o, sig); // proof of exit 2

        assertEq(_ownerOf(ws[0]), address(router));
        assertEq(_ownerOf(ws[1]), address(router));
    }

    function test_settle_revertsExitAlreadySpentWhenOutboxExecutedFirst() public {
        Withdrawal[] memory ws = _intents(1);
        _execute(ws[0]);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.ExitAlreadySpent.selector, ws[0].claim.index));
        _settleAs(relayer, ws[0], o, sig);

        assertEq(_ownerOf(ws[0]), address(router));
    }

    function test_settle_revertsInvalidRootWhenNodeWasRejected() public {
        Withdrawal[] memory ws = _intents(1);
        rollup.setFirstUnresolvedNode(NODE + 1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, ws[0].claim.nodeNum));
        _settleAs(relayer, ws[0], o, sig);
    }

    function test_settle_revertsGatewayNotAllowedAfterMarketDisallowsIt() public {
        Withdrawal[] memory ws = _intents(1);
        vm.prank(owner);
        market.disallowGateway(address(gateway));
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.GatewayNotAllowed.selector, address(gateway)));
        _settleAs(relayer, ws[0], o, sig);
    }

    // ================================================================ settle: reentrancy

    /// @dev Since re-audit C1 no attacker code can run inside settle(): a re-entrant buyer or gateway is refused
    ///      before any external call (the nonReentrant guard stays as defence in depth).
    function test_settle_refusesAReentrantBuyerBeforeAnyExternalCall() public {
        Withdrawal[] memory ws = _intents(2);
        uint256 pay = 9_000e6;
        TestBuyer evil = new TestBuyer(IERC20(address(usdg)), pay);
        usdg.mint(address(evil), pay);
        IExitIntentRouter.SellOrder memory first = _orderTo(ws[0], address(evil), 0, RELAYER_FEE);
        IExitIntentRouter.SellOrder memory second = _orderTo(ws[1], address(evil), 0, RELAYER_FEE);
        evil.setReentry(
            address(router), abi.encodeCall(IExitIntentRouter.settle, (ws[1].claim, second, _signed(second))), true
        );
        bytes memory sig = _signed(first);

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.BuyerNotAllowed.selector, address(evil)));
        _settleAs(relayer, ws[0], first, sig);

        assertFalse(evil.reentered(), "buyer never ran");
        assertEq(_ownerOf(ws[0]), address(router));
        assertEq(_ownerOf(ws[1]), address(router));
    }

    function test_settle_refusesAHostileGatewayBeforeAnyExternalCall() public {
        uint256 payment = 1_000e6;
        ReentrantGateway evilGw = new ReentrantGateway(IERC20(address(usdg)), address(router), payment);
        usdg.mint(address(evilGw), payment);
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, 0);
        o.gateway = address(evilGw);
        bytes memory sig = _signed(o);
        evilGw.arm(abi.encodeCall(IExitIntentRouter.settle, (ws[0].claim, o, sig)));

        vm.expectRevert(abi.encodeWithSelector(IExitIntentRouter.GatewayNotAllowed.selector, address(evilGw)));
        _settleAs(relayer, ws[0], o, sig);

        assertFalse(evilGw.attempted(), "gateway never ran");
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    // ================================================================ fuzz

    function testFuzz_settle_neverStrandsOrCreatesTokensForAnySplitAmountOrRelayer(
        uint256 amount,
        uint256 feeSeed,
        uint256 minSeed,
        address who
    ) public {
        vm.assume(
            who != address(0) && who != user && who != address(router) && who != address(vault)
                && who != address(market)
        );
        amount = bound(amount, 1_000e6, 100_000e6);
        Withdrawal[] memory ws = _createFrom(gateway, NODE, 1, 1, user, address(router), amount);
        uint256 received = _received(ws[0]);
        uint256 fee = bound(feeSeed, 0, received);
        uint256 minProceeds = bound(minSeed, 0, received - fee);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], minProceeds, fee);

        uint256 proceeds = _settleAs(who, ws[0], o, _signed(o));

        assertEq(usdg.balanceOf(address(router)), 0, "router keeps nothing");
        assertEq(usdg.balanceOf(who), fee, "relayer gets exactly its fee");
        assertEq(usdg.balanceOf(user), received - fee, "seller gets the rest");
        assertEq(usdg.balanceOf(user) + usdg.balanceOf(who), received, "no token lost or created");
        assertEq(proceeds, received - fee);
        assertGe(proceeds, minProceeds);
        assertEq(_ownerOf(ws[0]), address(vault));
    }

    function testFuzz_settle_succeedsExactlyWhenReceivedCoversMinPlusFee(uint256 minSeed, uint256 feeSeed) public {
        Withdrawal[] memory ws = _intents(1);
        uint256 received = _received(ws[0]);
        uint256 minProceeds = bound(minSeed, 0, 2 * received);
        uint256 fee = bound(feeSeed, 0, 2 * received);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], minProceeds, fee);
        bytes memory sig = _signed(o);

        if (minProceeds + fee > received) {
            vm.expectRevert(
                abi.encodeWithSelector(IExitIntentRouter.ProceedsBelowMin.selector, received, minProceeds + fee)
            );
            _settleAs(relayer, ws[0], o, sig);
            assertEq(_ownerOf(ws[0]), address(router));
            assertEq(usdg.balanceOf(user) + usdg.balanceOf(relayer), 0);
        } else {
            _settleAs(relayer, ws[0], o, sig);
            assertEq(usdg.balanceOf(user), received - fee);
            assertEq(usdg.balanceOf(relayer), fee);
            assertEq(usdg.balanceOf(address(router)), 0);
        }
    }
}
