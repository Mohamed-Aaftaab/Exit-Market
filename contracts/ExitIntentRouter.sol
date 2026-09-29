// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IL1ArbitrumExtendedGateway, IOutbox} from "./interfaces/IArbitrumBridge.sol";
import {ExitClaim, IExitMarket, PayoutProof} from "./interfaces/IExitMarket.sol";
import {IExitIntentRouter} from "./interfaces/IExitIntentRouter.sol";
import {ExitKeys} from "./libraries/ExitKeys.sol";
import {ExitLeaf} from "./libraries/ExitLeaf.sol";

/// @title ExitIntentRouter
/// @notice Gasless "sign-once" exits on top of ExitMarket. See IExitIntentRouter for the flow.
/// @dev Holds no funds between calls: every settlement forwards the full balance delta it received. The only
///      exception is an exit executed through the Outbox before settlement, recovered via recoverExecuted.
///      Trust: relies on ExitMarket to prove the exit (including `claim.from`) inside settle(); reclaim()
///      proves it here with the market's frozen gateway config.
contract ExitIntentRouter is IExitIntentRouter, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SELL_ORDER_TYPEHASH = keccak256(
        "SellOrder(address gateway,uint256 exitNum,address buyer,uint256 minProceeds,uint256 relayerFee,uint64 deadline)"
    );

    /// @notice Anyone may reclaim a router-owned exit this long after it was withdrawn on the child chain.
    uint256 public constant RECLAIM_GRACE = 3 days;

    IExitMarket private immutable _market;
    /// @notice Items whose executed tokens were already forwarded by recoverExecuted.
    mapping(bytes32 itemHash => bool) public recovered;
    IERC20 private immutable _paymentToken;

    constructor(address market_) EIP712("ExitIntentRouter", "1") {
        _market = IExitMarket(market_);
        _paymentToken = IERC20(IExitMarket(market_).paymentToken());
    }

    /// @inheritdoc IExitIntentRouter
    function settle(ExitClaim calldata claim, SellOrder calldata order, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 proceeds)
    {
        if (claim.initialDestination != address(this)) revert NotRouterExit();
        if (block.timestamp > order.deadline) revert OrderExpired(order.deadline);

        address seller = claim.from;
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(orderDigest(order), signature);
        if (err != ECDSA.RecoverError.NoError || signer != seller) revert BadSignature();

        uint256 balanceBefore = _paymentToken.balanceOf(address(this));
        // The market proves the whole leaf (so `seller` is the real child-chain sender) and sells to the buyer.
        IL1ArbitrumExtendedGateway(order.gateway).transferExitAndCall(
            order.exitNum,
            address(this),
            address(_market),
            "",
            abi.encode(IExitMarket.Action.SELL_TO_BUYER, claim, abi.encode(order.buyer, uint256(0)))
        );
        uint256 received = _paymentToken.balanceOf(address(this)) - balanceBefore;

        uint256 required = order.minProceeds + order.relayerFee;
        if (received < required) revert ProceedsBelowMin(received, required);

        proceeds = received - order.relayerFee;
        if (order.relayerFee > 0) _paymentToken.safeTransfer(msg.sender, order.relayerFee);
        _paymentToken.safeTransfer(seller, proceeds);

        emit IntentSettled(ExitKeys.id(order.gateway, order.exitNum, address(this)), seller, msg.sender, proceeds, order.relayerFee);
    }

    /// @inheritdoc IExitIntentRouter
    function reclaim(address gateway, uint256 exitNum, ExitClaim calldata claim) external nonReentrant {
        if (claim.initialDestination != address(this)) revert NotRouterExit();
        uint256 unlockTime = claim.l2Timestamp + RECLAIM_GRACE;
        if (msg.sender != claim.from && block.timestamp < unlockTime) revert ReclaimLocked(unlockTime);
        IExitMarket.GatewayConfig memory cfg = _knownGateway(gateway);

        _requireProven(cfg, gateway, exitNum, claim);

        IL1ArbitrumExtendedGateway(gateway).transferExitAndCall(exitNum, address(this), claim.from, "", "");
        emit ExitReclaimed(ExitKeys.id(gateway, exitNum, address(this)), claim.from);
    }

    /// @inheritdoc IExitIntentRouter
    function recoverExecuted(address gateway, uint256 exitNum, ExitClaim calldata claim, PayoutProof calldata payout)
        external
        nonReentrant
    {
        if (claim.initialDestination != address(this)) revert NotRouterExit();
        IExitMarket.GatewayConfig memory cfg = _knownGateway(gateway);
        bytes32 item = _requireProven(cfg, gateway, exitNum, claim);
        if (recovered[item]) revert AlreadyRecovered(item);

        // Same payout rule as the market: the spent slot must hold THIS item under a confirmed root.
        IOutbox outbox = IOutbox(cfg.outbox);
        if (
            !outbox.isSpent(payout.index) || outbox.roots(payout.confirmedRoot) == bytes32(0)
                || ExitLeaf.rootFromItem(item, payout.proof, payout.index) != payout.confirmedRoot
        ) revert ExitNotPaidOut(payout.index);
        // The router must still be the owner: otherwise the payout went to whoever bought or reclaimed it.
        (address owner_,) = IL1ArbitrumExtendedGateway(gateway).getExternalCall(exitNum, address(this), "");
        if (owner_ != address(this)) revert NotRouterExit();

        recovered[item] = true;
        IERC20(claim.l1Token).safeTransfer(claim.from, claim.amount);
        emit ExecutedExitRecovered(ExitKeys.id(gateway, exitNum, address(this)), claim.from, claim.l1Token, claim.amount);
    }

    /// @inheritdoc IExitIntentRouter
    function orderDigest(SellOrder calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SELL_ORDER_TYPEHASH,
                    order.gateway,
                    order.exitNum,
                    order.buyer,
                    order.minProceeds,
                    order.relayerFee,
                    order.deadline
                )
            )
        );
    }

    /// @inheritdoc IExitIntentRouter
    function market() external view returns (address) {
        return address(_market);
    }

    /// @inheritdoc IExitIntentRouter
    function paymentToken() external view returns (address) {
        return address(_paymentToken);
    }

    /// @dev Same leaf + root checks as ExitMarket._verifyExit (minus ownership/spent, irrelevant here: the
    ///      exit only ever goes back to its proven sender).
    function _knownGateway(address gateway) private view returns (IExitMarket.GatewayConfig memory cfg) {
        cfg = _market.getGatewayConfig(gateway);
        if (!cfg.known) revert GatewayUnknown(gateway);
    }

    /// @return item the proven Outbox item hash (value 0, or value = amount for WETH-style leaves)
    function _requireProven(
        IExitMarket.GatewayConfig memory cfg,
        address gateway,
        uint256 exitNum,
        ExitClaim calldata c
    ) private view returns (bytes32 item) {
        ExitLeaf.Leaf memory leaf = ExitLeaf.Leaf({
            childGateway: cfg.childGateway,
            parentGateway: gateway,
            l1Token: c.l1Token,
            from: c.from,
            initialDestination: c.initialDestination,
            amount: c.amount,
            exitNum: exitNum,
            l2Block: c.l2Block,
            l1Block: c.l1Block,
            l2Timestamp: c.l2Timestamp
        });
        item = ExitLeaf.itemHash(leaf);
        bytes32 root = ExitLeaf.rootFromItem(item, c.proof, c.index);
        if (root != c.sendRoot) {
            item = ExitLeaf.itemHashWithValue(leaf, c.amount);
            root = ExitLeaf.rootFromItem(item, c.proof, c.index);
            if (root != c.sendRoot) revert ProofMismatch(root, c.sendRoot);
        }
        (bool valid,,) = cfg.verifier.verifyRoot(cfg.rollup, cfg.outbox, c.sendRoot, c.nodeNum, c.blockHash);
        if (!valid) revert InvalidRoot(c.sendRoot, c.nodeNum);
    }
}
