// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {
    IBridge,
    IInbox,
    IL1ArbitrumExtendedGateway,
    ILegacyRollup,
    IOutbox,
    ITradeableExitReceiver
} from "./interfaces/IArbitrumBridge.sol";
import {ExitClaim, ExitRecord, IExitBuyer, IExitMarket, IRootVerifier} from "./interfaces/IExitMarket.sol";
import {ExitLeaf} from "./libraries/ExitLeaf.sol";

/// @title ExitMarket
/// @notice Marketplace for pending Arbitrum withdrawals ("tradeable exits").
///         A seller redirects their exit to this contract with `gateway.transferExitAndCall`; the gateway
///         calls `onExitTransfer`, where the exit is proven on-chain (Outbox merkle proof against a
///         confirmed root or an unresolved rollup node) and then listed or sold instantly to an IExitBuyer.
/// @dev Trust model: the owner can only allowlist gateways and set a capped fee. Verification sources
///      (child gateway, outbox, rollup, verifier) are derived from the gateway and frozen on first allow.
contract ExitMarket is IExitMarket, ITradeableExitReceiver, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 200;
    uint16 private constant BPS = 10_000;

    IERC20 private immutable _paymentToken;

    uint16 public feeBps;
    address public feeRecipient;
    uint256 public accruedFees;

    mapping(address gateway => GatewayConfig) private _gateways;
    mapping(bytes32 id => Listing) private _listings;

    constructor(address paymentToken_, address owner_, uint16 feeBps_, address feeRecipient_) Ownable(owner_) {
        _paymentToken = IERC20(paymentToken_);
        _setFee(feeBps_, feeRecipient_);
    }

    // ---------------------------------------------------------------- admin

    /// @inheritdoc IExitMarket
    function allowGateway(address gateway, IRootVerifier verifier) external onlyOwner {
        IL1ArbitrumExtendedGateway gw = IL1ArbitrumExtendedGateway(gateway);
        address bridge = IInbox(gw.inbox()).bridge();
        address rollup = IBridge(bridge).rollup();
        address outbox = ILegacyRollup(rollup).outbox();
        if (!IBridge(bridge).allowedOutboxes(outbox)) revert OutboxNotAllowed(outbox);

        GatewayConfig memory next = GatewayConfig({
            childGateway: gw.counterpartGateway(),
            outbox: outbox,
            rollup: rollup,
            verifier: verifier,
            allowed: true,
            known: true
        });

        GatewayConfig storage prev = _gateways[gateway];
        if (
            prev.known
                && (
                    prev.childGateway != next.childGateway || prev.outbox != next.outbox || prev.rollup != next.rollup
                        || prev.verifier != next.verifier
                )
        ) revert GatewaySourcesChanged(gateway);

        _gateways[gateway] = next;
        emit GatewayAllowed(gateway, next.childGateway, outbox, rollup, address(verifier));
    }

    /// @inheritdoc IExitMarket
    function disallowGateway(address gateway) external onlyOwner {
        _gateways[gateway].allowed = false;
        emit GatewayDisallowed(gateway);
    }

    /// @inheritdoc IExitMarket
    function setFee(uint16 feeBps_, address feeRecipient_) external onlyOwner {
        _setFee(feeBps_, feeRecipient_);
    }

    /// @inheritdoc IExitMarket
    function withdrawFees() external nonReentrant {
        uint256 amount = accruedFees;
        accruedFees = 0;
        _paymentToken.safeTransfer(feeRecipient, amount);
    }

    // ---------------------------------------------------------------- gateway hook

    /// @notice Called by an allowlisted gateway after it redirected an exit to this contract.
    /// @param sender previous owner of the exit (the seller)
    /// @param data abi.encode(Action, ExitClaim, params)
    function onExitTransfer(address sender, uint256 exitNum, bytes calldata data)
        external
        nonReentrant
        returns (bool)
    {
        GatewayConfig memory cfg = _gateways[msg.sender];
        if (!cfg.allowed) revert GatewayNotAllowed(msg.sender);

        (Action action, ExitClaim memory claim, bytes memory params) = abi.decode(data, (Action, ExitClaim, bytes));
        ExitRecord memory exit = _verifyExit(msg.sender, cfg, exitNum, claim);

        if (action == Action.LIST) _list(exit, sender, params);
        else _sellToBuyer(exit, sender, params);
        return true;
    }

    // ---------------------------------------------------------------- listings

    /// @inheritdoc IExitMarket
    function buy(bytes32 id, uint256 maxPrice) external nonReentrant {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) revert NotListed(id);
        if (block.timestamp > l.expiry) revert ListingExpired(id);
        if (l.price > maxPrice) revert PriceAboveMax(l.price, maxPrice);

        ExitRecord memory exit = l.exit;
        _requireLive(exit);

        l.status = Status.Sold;
        uint256 fee = (l.price * l.feeBps) / BPS;
        accruedFees += fee;

        _paymentToken.safeTransferFrom(msg.sender, address(this), fee);
        _paymentToken.safeTransferFrom(msg.sender, l.seller, l.price - fee);
        _transferExit(exit, msg.sender);

        emit ExitBought(id, msg.sender, l.price, fee);
        emit ExitOwnerChanged(id, msg.sender);
    }

    /// @inheritdoc IExitMarket
    function cancel(bytes32 id) external nonReentrant {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) revert NotListed(id);
        if (msg.sender != l.seller && block.timestamp <= l.expiry) revert NotSeller();

        // Executed while listed: the tokens are already here, so forward them instead.
        if (_isSpent(l.exit)) return _settle(id, l);

        l.status = Status.Cancelled;
        _transferExit(l.exit, l.seller);

        emit ListingCancelled(id);
        emit ExitOwnerChanged(id, l.seller);
    }

    /// @inheritdoc IExitMarket
    function settle(bytes32 id) external nonReentrant {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) revert NotListed(id);
        if (!_isSpent(l.exit)) revert ExitNotSpent(l.exit.index);
        _settle(id, l);
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc IExitMarket
    function listingId(address gateway, uint256 exitNum, address initialDestination) public pure returns (bytes32) {
        return keccak256(abi.encode(gateway, exitNum, initialDestination));
    }

    /// @inheritdoc IExitMarket
    function getListing(bytes32 id) external view returns (Listing memory) {
        return _listings[id];
    }

    /// @inheritdoc IExitMarket
    function isExitLive(ExitRecord calldata exit) external view returns (bool) {
        GatewayConfig memory cfg = _knownGateway(exit.gateway);
        if (IOutbox(cfg.outbox).isSpent(exit.index)) return false;
        (bool valid,,) = cfg.verifier.verifyRoot(cfg.rollup, cfg.outbox, exit.sendRoot, exit.nodeNum, exit.blockHash);
        return valid;
    }

    /// @inheritdoc IExitMarket
    function isExitSpent(ExitRecord calldata exit) external view returns (bool) {
        return _isSpent(exit);
    }

    /// @inheritdoc IExitMarket
    function getGatewayConfig(address gateway) external view returns (GatewayConfig memory) {
        return _gateways[gateway];
    }

    /// @inheritdoc IExitMarket
    function paymentToken() external view returns (address) {
        return address(_paymentToken);
    }

    // ---------------------------------------------------------------- internals

    function _verifyExit(address gateway, GatewayConfig memory cfg, uint256 exitNum, ExitClaim memory c)
        private
        view
        returns (ExitRecord memory)
    {
        (address owner_,) = IL1ArbitrumExtendedGateway(gateway).getExternalCall(exitNum, c.initialDestination, "");
        if (owner_ != address(this)) revert ExitNotHeld();

        // exitNum and gateway come from the gateway call, never from the seller's claim.
        bytes32 root = ExitLeaf.computeRoot(
            ExitLeaf.Leaf({
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
            }),
            c.proof,
            c.index
        );
        if (root != c.sendRoot) revert ProofMismatch(root, c.sendRoot);

        (bool valid, bool pending, uint64 deadlineBlock) =
            cfg.verifier.verifyRoot(cfg.rollup, cfg.outbox, c.sendRoot, c.nodeNum, c.blockHash);
        if (!valid) revert InvalidRoot(c.sendRoot, c.nodeNum);
        // Unspent now + redirected to us => any later execution pays an address this market controls.
        if (IOutbox(cfg.outbox).isSpent(c.index)) revert ExitAlreadySpent(c.index);

        return ExitRecord({
            gateway: gateway,
            exitNum: exitNum,
            initialDestination: c.initialDestination,
            l1Token: c.l1Token,
            amount: c.amount,
            index: c.index,
            sendRoot: c.sendRoot,
            nodeNum: c.nodeNum,
            blockHash: c.blockHash,
            pending: pending,
            deadlineBlock: deadlineBlock
        });
    }

    function _list(ExitRecord memory exit, address seller, bytes memory params) private {
        (uint256 price, uint64 expiry) = abi.decode(params, (uint256, uint64));
        if (price == 0) revert ZeroPrice();
        if (expiry <= block.timestamp) revert BadExpiry();

        bytes32 id = listingId(exit.gateway, exit.exitNum, exit.initialDestination);
        if (_listings[id].status == Status.Listed) revert ListingExists(id);

        _listings[id] = Listing({
            exit: exit,
            seller: seller,
            price: price,
            feeBps: feeBps,
            expiry: expiry,
            status: Status.Listed
        });

        emit ExitListed(id, seller, exit.l1Token, exit.amount, price, expiry, exit.pending);
        emit ExitOwnerChanged(id, address(this));
    }

    function _sellToBuyer(ExitRecord memory exit, address seller, bytes memory params) private {
        (address buyer, uint256 minPayout) = abi.decode(params, (address, uint256));
        bytes32 id = listingId(exit.gateway, exit.exitNum, exit.initialDestination);

        // Measure what the buyer actually delivered rather than trusting its return value.
        uint256 balanceBefore = _paymentToken.balanceOf(address(this));
        IExitBuyer(buyer).buyExit(exit);
        uint256 price = _paymentToken.balanceOf(address(this)) - balanceBefore;
        if (price == 0) revert ZeroPrice();
        if (price < minPayout) revert PayoutBelowMin(price, minPayout);

        uint256 fee = (price * feeBps) / BPS;
        accruedFees += fee;

        _transferExit(exit, buyer);
        _paymentToken.safeTransfer(seller, price - fee);

        emit ExitSoldToBuyer(id, seller, buyer, price, fee);
        emit ExitOwnerChanged(id, buyer);
    }

    function _settle(bytes32 id, Listing storage l) private {
        l.status = Status.Settled;
        IERC20(l.exit.l1Token).safeTransfer(l.seller, l.exit.amount);
        emit ListingSettled(id, l.exit.amount);
    }

    function _requireLive(ExitRecord memory exit) private view {
        GatewayConfig memory cfg = _knownGateway(exit.gateway);
        (address owner_,) =
            IL1ArbitrumExtendedGateway(exit.gateway).getExternalCall(exit.exitNum, exit.initialDestination, "");
        if (owner_ != address(this)) revert ExitNotHeld();
        if (IOutbox(cfg.outbox).isSpent(exit.index)) revert ExitAlreadySpent(exit.index);
        (bool valid,,) = cfg.verifier.verifyRoot(cfg.rollup, cfg.outbox, exit.sendRoot, exit.nodeNum, exit.blockHash);
        if (!valid) revert InvalidRoot(exit.sendRoot, exit.nodeNum);
    }

    function _isSpent(ExitRecord memory exit) private view returns (bool) {
        return IOutbox(_knownGateway(exit.gateway).outbox).isSpent(exit.index);
    }

    function _knownGateway(address gateway) private view returns (GatewayConfig memory cfg) {
        cfg = _gateways[gateway];
        if (!cfg.known) revert GatewayUnknown(gateway);
    }

    function _transferExit(ExitRecord memory exit, address to) private {
        // Empty data: no hook on the receiver, so no re-entry into this contract.
        IL1ArbitrumExtendedGateway(exit.gateway).transferExitAndCall(exit.exitNum, exit.initialDestination, to, "", "");
    }

    function _setFee(uint16 feeBps_, address feeRecipient_) private {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit FeeUpdated(feeBps_, feeRecipient_);
    }
}
