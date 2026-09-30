// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IExitMarket} from "../../interfaces/IExitMarket.sol";
import {IExitIntentRouter} from "../../interfaces/IExitIntentRouter.sol";
import {ExitLeaf} from "../../libraries/ExitLeaf.sol";
import {ExitIntentRouter} from "../../ExitIntentRouter.sol";
import {ExitVault} from "../../ExitVault.sol";
import {ExitFixture} from "./ExitFixture.sol";

/// @dev Shared setup for ExitIntentRouter tests. Withdrawals are built with initialDestination = router and
///      from = an EOA whose key signs the SellOrder; a relayer settles through the real ExitMarket + ExitVault
///      on the mock gateway.
abstract contract IntentFixture is ExitFixture {
    uint256 internal constant USER_PK = 0xA11CE;
    uint256 internal constant USER2_PK = 0xB0B;
    uint256 internal constant ATTACKER_PK = 0xBAD;
    uint256 internal constant LP_DEPOSIT = 500_000e6;
    uint256 internal constant RELAYER_FEE = 25e6;
    uint256 internal constant ORDER_TTL = 1 hours;
    uint256 internal constant RECLAIM_GRACE = 3 days;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "SellOrder(address gateway,uint256 exitNum,address buyer,uint256 minProceeds,uint256 relayerFee,uint64 deadline)"
    );

    ExitVault internal vault;
    ExitIntentRouter internal router;
    address internal user;
    address internal attacker;
    address internal relayer;
    address internal lp;

    function setUp() public override {
        super.setUp();
        user = vm.addr(USER_PK);
        attacker = vm.addr(ATTACKER_PK);
        relayer = makeAddr("relayer");
        lp = makeAddr("lp");
        vault = new ExitVault(IERC20(address(usdg)), IExitMarket(address(market)), owner, "Exit Vault USDG", "xvUSDG");
        router = new ExitIntentRouter(address(market), address(vault));
        _fund(lp, address(vault), LP_DEPOSIT);
        vm.prank(lp);
        vault.deposit(LP_DEPOSIT, lp);
    }

    // ================================================================ helpers

    /// @dev `n` withdrawals by `user` with the router as initial destination (exitNum 1..n, one tree).
    function _intents(uint256 n) internal returns (Withdrawal[] memory) {
        return _createFrom(gateway, NODE, 1, n, user, address(router), AMOUNT);
    }

    /// @dev What the router receives when the vault buys `w`: quote minus the market fee.
    function _received(Withdrawal memory w) internal view returns (uint256) {
        uint256 price = vault.quote(_record(w));
        return price - _fee(price);
    }

    function _order(Withdrawal memory w, uint256 minProceeds, uint256 relayerFee)
        internal
        view
        returns (IExitIntentRouter.SellOrder memory)
    {
        return _orderTo(w, address(vault), minProceeds, relayerFee);
    }

    function _orderTo(Withdrawal memory w, address buyer_, uint256 minProceeds, uint256 relayerFee)
        internal
        view
        returns (IExitIntentRouter.SellOrder memory)
    {
        return IExitIntentRouter.SellOrder({
            gateway: w.gateway,
            exitNum: w.exitNum,
            buyer: buyer_,
            minProceeds: minProceeds,
            relayerFee: relayerFee,
            deadline: uint64(block.timestamp + ORDER_TTL)
        });
    }

    function _clone(IExitIntentRouter.SellOrder memory o) internal pure returns (IExitIntentRouter.SellOrder memory) {
        return IExitIntentRouter.SellOrder(o.gateway, o.exitNum, o.buyer, o.minProceeds, o.relayerFee, o.deadline);
    }

    /// @dev EIP-712 digest computed here, independently of the router's own orderDigest().
    function _digest(address verifyingContract, IExitIntentRouter.SellOrder memory o) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("ExitIntentRouter"), keccak256("1"), block.chainid, verifyingContract)
        );
        bytes32 structHash = keccak256(
            abi.encode(ORDER_TYPEHASH, o.gateway, o.exitNum, o.buyer, o.minProceeds, o.relayerFee, o.deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(uint256 pk, address verifyingContract, IExitIntentRouter.SellOrder memory o)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(verifyingContract, o));
        return abi.encodePacked(r, s, v);
    }

    /// @dev `user` signs for the router under test.
    function _signed(IExitIntentRouter.SellOrder memory o) internal view returns (bytes memory) {
        return _sign(USER_PK, address(router), o);
    }

    function _settleAs(
        address who,
        Withdrawal memory w,
        IExitIntentRouter.SellOrder memory o,
        bytes memory sig
    ) internal returns (uint256) {
        vm.prank(who);
        return router.settle(w.claim, o, sig);
    }

    function _reclaimAs(address who, Withdrawal memory w) internal {
        vm.prank(who);
        router.reclaim(w.gateway, w.exitNum, w.claim);
    }

    /// @dev First moment a third party may reclaim `w`: l2Timestamp of the withdrawal + grace.
    function _unlockTime(Withdrawal memory w) internal pure returns (uint256) {
        return w.claim.l2Timestamp + RECLAIM_GRACE;
    }

    /// @dev Signs `o` as the user and settles it through `relayer`.
    function _settleSigned(Withdrawal memory w, IExitIntentRouter.SellOrder memory o) internal returns (uint256) {
        return _settleAs(relayer, w, o, _signed(o));
    }

    function _expectBadSignature(Withdrawal memory w, IExitIntentRouter.SellOrder memory submitted, bytes memory sig)
        internal
    {
        vm.expectRevert(IExitIntentRouter.BadSignature.selector);
        _settleAs(relayer, w, submitted, sig);
        assertEq(_ownerOf(w), address(router), "exit must stay with the router");
    }

    /// @dev Root reported by ExitMarket/router on a leaf mismatch: the value = amount retry.
    function _mismatchRoot(Withdrawal memory w) internal view returns (bytes32) {
        bytes32 item = ExitLeaf.itemHashWithValue(_leafOf(w), w.claim.amount);
        return ExitLeaf.rootFromItem(item, w.claim.proof, w.claim.index);
    }
}
