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
import {ExitClaim, ExitRecord, IExitBuyer, IExitMarket, PayoutProof} from "./interfaces/IExitMarket.sol";
import {IRootVerifier} from "./interfaces/IRootVerifier.sol";
import {ExitKeys} from "./libraries/ExitKeys.sol";
import {ExitLeaf} from "./libraries/ExitLeaf.sol";

/// @title ExitMarket
/// @notice Marketplace for pending Arbitrum withdrawals ("tradeable exits").
///         A seller redirects their exit to this contract with `gateway.transferExitAndCall`; the gateway
///         calls `onExitTransfer`, where the exit is proven on-chain (Outbox merkle proof against a
///         confirmed root or an unresolved rollup node) and then listed or sold instantly to an IExitBuyer.
/// @dev Trust model: the owner chooses which gateways and which root verifier to trust, and sets a fee
///      capped at MAX_FEE_BPS (snapshotted per listing). Child gateway, outbox and rollup are derived from
///      the gateway itself and, with the verifier, frozen on first allow. An owner who allowed a hostile
///      gateway could fake exits and drain buyers, so the deployment (scripts/deploy.ts) allows the real
///      Arbitrum gateways and then RENOUNCES ownership in the same script: the live market has no owner, and
///      nobody can add a gateway, change the fee or disallow a gateway after that (round 5, H-2).
///      Payout safety: an Outbox spent bit is keyed by index only, so tokens are released only when the
///      index provably holds this exit's item under a CONFIRMED root (confirmed roots are canonical).
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
        if (paymentToken_ == address(0)) revert ZeroAddress();
        _paymentToken = IERC20(paymentToken_);
        _setFee(feeBps_, feeRecipient_);
    }

    // ---------------------------------------------------------------- admin

    /// @inheritdoc IExitMarket
    function allowGateway(address gateway, IRootVerifier verifier) external onlyOwner {
        if (address(verifier) == address(0)) revert ZeroAddress();
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
        address recipient = feeRecipient;
        _paymentToken.safeTransfer(recipient, amount);
        emit FeesWithdrawn(recipient, amount);
    }

    // ---------------------------------------------------------------- gateway hook

    /// @notice Called by an allowlisted gateway right after it redirected an exit to this contract.
    /// @param sender previous owner of the exit (the seller), as authenticated by the gateway
    /// @param exitNum exit number, taken from the gateway call (never from `data`)
    /// @param data abi.encode(uint8(Action), ExitClaim, params); see IExitMarket.Action
    /// @return true on success (the gateway requires it)
    function onExitTransfer(address sender, uint256 exitNum, bytes calldata data)
        external
        nonReentrant
        returns (bool)
    {
        GatewayConfig memory cfg = _gateways[msg.sender];
        if (!cfg.allowed) revert GatewayNotAllowed(msg.sender);

        (Action action, ExitClaim memory claim, bytes memory params) = abi.decode(data, (Action, ExitClaim, bytes));
        ExitRecord memory exit = _verifyExit(msg.sender, cfg, exitNum, claim);
        bytes32 id = ExitKeys.id(msg.sender, exitNum, claim.initialDestination);
        emit ExitVerified(id, exit);

        if (action == Action.LIST) _list(id, exit, sender, params);
        else _sellToBuyer(id, exit, sender, params);
        return true;
    }

    // ---------------------------------------------------------------- listings

    /// @inheritdoc IExitMarket
    function buy(bytes32 id, uint256 maxPrice) external nonReentrant {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) revert NotListed(id);
        if (block.timestamp > l.expiry) revert ListingExpired(id);
        uint256 price = l.price;
        if (price > maxPrice) revert PriceAboveMax(price, maxPrice);

        ExitRecord memory exit = l.exit;
        GatewayConfig memory cfg = _gateways[exit.gateway];
        if (!cfg.allowed) revert GatewayNotAllowed(exit.gateway);
        _requireLive(cfg, exit);

        l.status = Status.Sold;
        uint256 fee = (price * l.feeBps) / BPS;
        accruedFees += fee;

        _paymentToken.safeTransferFrom(msg.sender, address(this), fee);
        _paymentToken.safeTransferFrom(msg.sender, l.seller, price - fee);
        _transferExit(exit.gateway, exit.exitNum, exit.initialDestination, msg.sender);

        emit ExitBought(id, msg.sender, price, fee);
        emit ExitOwnerChanged(id, msg.sender);
    }

    /// @inheritdoc IExitMarket
    function cancel(bytes32 id) external nonReentrant {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) revert NotListed(id);
        address seller = l.seller;
        if (msg.sender != seller && block.timestamp <= l.expiry) revert NotSeller();

        ExitRecord memory exit = l.exit;
        address outbox = _knownGateway(exit.gateway).outbox;
        if (IOutbox(outbox).isSpent(exit.index)) {
            // Spent while listed: forward the tokens, but only if the slot provably holds THIS exit.
            PayoutProof memory asProven = PayoutProof(exit.index, exit.sendRoot, new bytes32[](0));
            if (!_paidOut(outbox, exit, asProven)) revert ExitNeedsSettlement(exit.index);
            return _settle(id, l);
        }

        l.status = Status.Cancelled;
        _transferExit(exit.gateway, exit.exitNum, exit.initialDestination, seller);

        emit ListingCancelled(id);
        emit ExitOwnerChanged(id, seller);
    }

    /// @inheritdoc IExitMarket
    function settle(bytes32 id, PayoutProof calldata payout) external nonReentrant {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) revert NotListed(id);
        ExitRecord memory exit = l.exit;
        if (!_paidOut(_knownGateway(exit.gateway).outbox, exit, payout)) revert ExitNotPaidOut(payout.index);
        _settle(id, l);
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc IExitMarket
    function listingId(address gateway, uint256 exitNum, address initialDestination) external pure returns (bytes32) {
        return ExitKeys.id(gateway, exitNum, initialDestination);
    }

    /// @inheritdoc IExitMarket
    function getListing(bytes32 id) external view returns (Listing memory) {
        return _listings[id];
    }

    /// @inheritdoc IExitMarket
    function isExitLive(ExitRecord calldata exit) external view returns (bool) {
        GatewayConfig storage cfg = _knownGateway(exit.gateway);
        if (IOutbox(cfg.outbox).isSpent(exit.index)) return false;
        (bool valid,,) = cfg.verifier.verifyRoot(cfg.rollup, cfg.outbox, exit.sendRoot, exit.nodeNum, exit.blockHash);
        return valid;
    }

    /// @inheritdoc IExitMarket
    function isExitPaidOut(ExitRecord calldata exit, PayoutProof calldata payout) external view returns (bool) {
        return _paidOut(_knownGateway(exit.gateway).outbox, exit, payout);
    }

    /// @inheritdoc IExitMarket
    function isExitRejected(ExitRecord calldata exit) external view returns (bool) {
        GatewayConfig storage cfg = _knownGateway(exit.gateway);
        return cfg.verifier.isRootRejected(cfg.rollup, cfg.outbox, exit.sendRoot, exit.nodeNum);
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
        ExitLeaf.Leaf memory leaf = _leafOf(cfg.childGateway, gateway, exitNum, c);
        bytes32 item = ExitLeaf.itemHash(leaf);
        bytes32 root = ExitLeaf.rootFromItem(item, c.proof, c.index);
        if (root != c.sendRoot) {
            // WETH gateway leaves carry value = amount (see ExitLeaf.itemHashWithValue for why this is safe).
            item = ExitLeaf.itemHashWithValue(leaf, c.amount);
            root = ExitLeaf.rootFromItem(item, c.proof, c.index);
            if (root != c.sendRoot) revert ProofMismatch(root, c.sendRoot);
        }

        (bool valid, bool pending, uint64 deadlineBlock) =
            cfg.verifier.verifyRoot(cfg.rollup, cfg.outbox, c.sendRoot, c.nodeNum, c.blockHash);
        if (!valid) revert InvalidRoot(c.sendRoot, c.nodeNum);
        // Unspent now + redirected to us => a later execution OF THIS ITEM pays an address we control.
        if (IOutbox(cfg.outbox).isSpent(c.index)) revert ExitAlreadySpent(c.index);

        return ExitRecord({
            gateway: gateway,
            exitNum: exitNum,
            initialDestination: c.initialDestination,
            l1Token: c.l1Token,
            amount: c.amount,
            index: c.index,
            itemHash: item,
            sendRoot: c.sendRoot,
            nodeNum: c.nodeNum,
            blockHash: c.blockHash,
            pending: pending,
            deadlineBlock: deadlineBlock
        });
    }

    function _leafOf(address childGateway, address gateway, uint256 exitNum, ExitClaim memory c)
        private
        pure
        returns (ExitLeaf.Leaf memory)
    {
        return ExitLeaf.Leaf({
            childGateway: childGateway,
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
    }

    function _list(bytes32 id, ExitRecord memory exit, address seller, bytes memory params) private {
        (uint256 price, uint64 expiry) = abi.decode(params, (uint256, uint64));
        if (price == 0) revert ZeroPrice();
        if (expiry <= block.timestamp) revert BadExpiry();
        // Defensive: while Listed the market owns the exit, so the gateway cannot re-enter here for it.
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

    function _sellToBuyer(bytes32 id, ExitRecord memory exit, address seller, bytes memory params) private {
        (address buyer, uint256 minPayout) = abi.decode(params, (address, uint256));

        // The buyer names its price and the market pulls exactly that from the buyer. The buyer is chosen by the
        // seller and runs arbitrary code in buyExit, so the price must never be a balance change measured around
        // that call: another listing's Outbox payout landing mid-call would otherwise be paid out as this
        // seller's price (round 5, H-1).
        (bytes4 magic, uint256 price) = IExitBuyer(buyer).buyExit(exit);
        if (magic != IExitBuyer.buyExit.selector) revert NotExitBuyer(buyer);
        if (price == 0) revert ZeroPrice();
        uint256 fee = (price * feeBps) / BPS;
        // The seller's slippage bound is on what the seller receives, after the fee.
        if (price - fee < minPayout) revert PayoutBelowMin(price - fee, minPayout);

        // Only the payment token's own code runs inside this window, so the delta is exactly the pull.
        uint256 balanceBefore = _paymentToken.balanceOf(address(this));
        _paymentToken.safeTransferFrom(buyer, address(this), price);
        uint256 received = _paymentToken.balanceOf(address(this)) - balanceBefore;
        if (received != price) revert PaymentShortfall(received, price);
        accruedFees += fee;

        _transferExit(exit.gateway, exit.exitNum, exit.initialDestination, buyer);
        _paymentToken.safeTransfer(seller, price - fee);

        emit ExitSoldToBuyer(id, seller, buyer, price, fee);
        emit ExitOwnerChanged(id, buyer);
    }

    function _settle(bytes32 id, Listing storage l) private {
        l.status = Status.Settled;
        uint256 amount = l.exit.amount;
        IERC20(l.exit.l1Token).safeTransfer(l.seller, amount);
        emit ListingSettled(id, amount);
    }

    /// @dev Spent bit alone is not enough (it is keyed by index): a fake exit proven against a node that is
    ///      later rejected can share an index with a real message. A confirmed root is canonical, so if the
    ///      index holds our item under a confirmed root, the message executed at that index was ours.
    ///      The index is a parameter: an exit proven against a bogus node may carry a non-canonical index.
    function _paidOut(address outbox, ExitRecord memory exit, PayoutProof memory p) private view returns (bool) {
        if (!IOutbox(outbox).isSpent(p.index)) return false;
        if (IOutbox(outbox).roots(p.confirmedRoot) == bytes32(0)) return false;
        if (p.index == exit.index && p.confirmedRoot == exit.sendRoot) return true; // proven at verification
        return ExitLeaf.rootFromItem(exit.itemHash, p.proof, p.index) == p.confirmedRoot;
    }

    function _requireLive(GatewayConfig memory cfg, ExitRecord memory exit) private view {
        (address owner_,) =
            IL1ArbitrumExtendedGateway(exit.gateway).getExternalCall(exit.exitNum, exit.initialDestination, "");
        if (owner_ != address(this)) revert ExitNotHeld();
        if (IOutbox(cfg.outbox).isSpent(exit.index)) revert ExitAlreadySpent(exit.index);
        (bool valid,,) = cfg.verifier.verifyRoot(cfg.rollup, cfg.outbox, exit.sendRoot, exit.nodeNum, exit.blockHash);
        if (!valid) revert InvalidRoot(exit.sendRoot, exit.nodeNum);
    }

    function _knownGateway(address gateway) private view returns (GatewayConfig storage cfg) {
        cfg = _gateways[gateway];
        if (!cfg.known) revert GatewayUnknown(gateway);
    }

    function _transferExit(address gateway, uint256 exitNum, address initialDestination, address to) private {
        // Empty data: no hook on the receiver, so no re-entry into this contract.
        IL1ArbitrumExtendedGateway(gateway).transferExitAndCall(exitNum, initialDestination, to, "", "");
    }

    function _setFee(uint16 feeBps_, address feeRecipient_) private {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit FeeUpdated(feeBps_, feeRecipient_);
    }
}
