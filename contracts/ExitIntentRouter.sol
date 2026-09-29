// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IL1ArbitrumExtendedGateway} from "./interfaces/IArbitrumBridge.sol";
import {ExitClaim, IExitMarket} from "./interfaces/IExitMarket.sol";
import {IExitIntentRouter} from "./interfaces/IExitIntentRouter.sol";
import {ExitKeys} from "./libraries/ExitKeys.sol";
import {ExitLeaf} from "./libraries/ExitLeaf.sol";

/// @title ExitIntentRouter
/// @notice Gasless "sign-once" exits on top of ExitMarket. See IExitIntentRouter for the flow.
/// @dev Holds no funds between calls: every settlement forwards the full balance delta it received.
///      Trust: relies on ExitMarket to prove the exit (including `claim.from`) inside settle(); reclaim()
///      proves it here with the market's frozen gateway config.
contract ExitIntentRouter is IExitIntentRouter, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SELL_ORDER_TYPEHASH = keccak256(
        "SellOrder(address gateway,uint256 exitNum,address buyer,uint256 minProceeds,uint256 relayerFee,uint64 deadline)"
    );

    IExitMarket private immutable _market;
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
        IExitMarket.GatewayConfig memory cfg = _market.getGatewayConfig(gateway);
        if (!cfg.known) revert GatewayUnknown(gateway);

        _requireProven(cfg, gateway, exitNum, claim);

        IL1ArbitrumExtendedGateway(gateway).transferExitAndCall(exitNum, address(this), claim.from, "", "");
        emit ExitReclaimed(ExitKeys.id(gateway, exitNum, address(this)), claim.from);
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
    function _requireProven(
        IExitMarket.GatewayConfig memory cfg,
        address gateway,
        uint256 exitNum,
        ExitClaim calldata c
    ) private view {
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
        bytes32 root = ExitLeaf.rootFromItem(ExitLeaf.itemHash(leaf), c.proof, c.index);
        if (root != c.sendRoot) {
            root = ExitLeaf.rootFromItem(ExitLeaf.itemHashWithValue(leaf, c.amount), c.proof, c.index);
            if (root != c.sendRoot) revert ProofMismatch(root, c.sendRoot);
        }
        (bool valid,,) = cfg.verifier.verifyRoot(cfg.rollup, cfg.outbox, c.sendRoot, c.nodeNum, c.blockHash);
        if (!valid) revert InvalidRoot(c.sendRoot, c.nodeNum);
    }
}
