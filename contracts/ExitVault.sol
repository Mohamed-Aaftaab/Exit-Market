// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ExitClaim, ExitRecord, IExitBuyer, IExitMarket} from "./interfaces/IExitMarket.sol";
import {IExitVault} from "./interfaces/IExitVault.sol";
import {ExitKeys} from "./libraries/ExitKeys.sol";

/// @title ExitVault
/// @notice ERC-4626 vault that gives L3 users an instant exit: it buys verified pending withdrawals of its
///         own asset (USDG) at `face - baseFee - APR x timeToConfirm`, then collects face value when the
///         withdrawal pays out. LPs earn the discount; no oracle is needed because payout token = asset.
/// @dev Accounting: totalAssets = idle + outstanding COST, tracked internally (not balanceOf), so donations
///      cannot move the share price and executed-but-uncollected exits are not double counted. The discount
///      is recognized only at collect(), when the tokens provably arrived; shares are locked for
///      SHARE_LOCK after receipt so just-in-time deposits cannot capture it.
///      LP risk: a pending exit whose rollup node is rejected is written off at cost.
contract ExitVault is ERC4626, Ownable2Step, ReentrancyGuard, IExitVault {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_BASE_FEE_BPS = 500;
    uint16 public constant MAX_APR_BPS = 5_000;
    uint16 public constant DEFAULT_BASE_FEE_BPS = 10; // 0.10%
    uint16 public constant DEFAULT_APR_BPS = 1_000; // 10% APR on time-to-confirm
    uint256 public constant SHARE_LOCK = 1 days;
    uint16 private constant BPS = 10_000;
    /// @dev On Arbitrum, block.number inside the EVM is the L1 block number used by rollup deadlines.
    uint256 private constant SECONDS_PER_L1_BLOCK = 12;
    uint256 private constant YEAR = 365 days;

    IExitMarket public immutable market;

    uint16 public baseFeeBps;
    uint16 public aprBps;
    uint256 public maxExitAmount;
    bool public acceptPending;

    uint256 private _idle;
    uint256 private _outstandingCost;

    struct Purchase {
        bytes32 recordHash; // keccak256(abi.encode(ExitRecord)): binds collect/writeOff to the exact record
        uint256 cost;
    }

    mapping(bytes32 key => Purchase) public purchases;
    mapping(address account => uint256 unlockTime) public shareUnlockTime;

    modifier onlyMarket() {
        if (msg.sender != address(market)) revert OnlyMarket();
        _;
    }

    constructor(IERC20 asset_, IExitMarket market_, address owner_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
        Ownable(owner_)
    {
        market = market_;
        _setParams(DEFAULT_BASE_FEE_BPS, DEFAULT_APR_BPS, type(uint256).max, true);
    }

    // ---------------------------------------------------------------- exit buying

    /// @inheritdoc IExitBuyer
    function buyExit(ExitRecord calldata exit) external onlyMarket nonReentrant returns (uint256 price) {
        if (exit.l1Token != asset()) revert WrongToken(exit.l1Token);
        if (exit.pending && !acceptPending) revert PendingNotAccepted();
        if (exit.amount > maxExitAmount) revert ExitTooLarge(exit.amount);

        price = quote(exit);
        if (price > _idle) revert InsufficientLiquidity(price, _idle);

        bytes32 key = ExitKeys.id(exit.gateway, exit.exitNum, exit.initialDestination);
        purchases[key] = Purchase({recordHash: keccak256(abi.encode(exit)), cost: price});
        _idle -= price;
        _outstandingCost += price;

        IERC20(asset()).safeTransfer(address(market), price);
        emit ExitPurchased(key, exit.amount, price);
    }

    /// @inheritdoc IExitVault
    function collect(ExitRecord calldata exit, bytes32 confirmedRoot, bytes32[] calldata proof)
        external
        nonReentrant
    {
        (bytes32 key, uint256 cost) = _requirePurchased(exit);
        if (!market.isExitPaidOut(exit, confirmedRoot, proof)) revert ExitNotPaidOut(key);

        delete purchases[key];
        _outstandingCost -= cost;
        _idle += exit.amount;
        emit ExitCollected(key, exit.amount, cost);
    }

    /// @inheritdoc IExitVault
    function writeOff(ExitRecord calldata exit, ExitClaim calldata canonical) external nonReentrant {
        (bytes32 key, uint256 cost) = _requirePurchased(exit);
        // A rejected node alone does not prove the exit is fake (a real exit is re-asserted by the honest
        // node and still pays us). Only a confirmed, different item for the same exitNum does.
        if (!market.isExitDisproven(exit, canonical)) revert ExitNotDisproven(key);

        delete purchases[key];
        _outstandingCost -= cost;
        emit ExitWrittenOff(key, cost);
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc IExitVault
    function quote(ExitRecord calldata exit) public view returns (uint256 price) {
        uint256 remainingBlocks = exit.deadlineBlock > block.number ? exit.deadlineBlock - block.number : 0;
        uint256 baseFee = (exit.amount * baseFeeBps) / BPS;
        uint256 timeDiscount =
            Math.mulDiv(exit.amount, uint256(aprBps) * remainingBlocks * SECONDS_PER_L1_BLOCK, uint256(BPS) * YEAR);
        uint256 discount = baseFee + timeDiscount;
        price = exit.amount > discount ? exit.amount - discount : 0;
    }

    /// @inheritdoc ERC4626
    function totalAssets() public view override returns (uint256) {
        return _idle + _outstandingCost;
    }

    /// @notice Limited to idle liquidity (outstanding exits return it over time) and to unlocked shares.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        if (block.timestamp < shareUnlockTime[owner_]) return 0;
        return Math.min(super.maxWithdraw(owner_), _idle);
    }

    /// @notice Share-denominated counterpart of maxWithdraw.
    function maxRedeem(address owner_) public view override returns (uint256) {
        if (block.timestamp < shareUnlockTime[owner_]) return 0;
        return Math.min(super.maxRedeem(owner_), _convertToShares(_idle, Math.Rounding.Floor));
    }

    /// @inheritdoc IExitVault
    function idleAssets() external view returns (uint256) {
        return _idle;
    }

    /// @inheritdoc IExitVault
    function outstandingCost() external view returns (uint256) {
        return _outstandingCost;
    }

    // ---------------------------------------------------------------- admin

    /// @inheritdoc IExitVault
    function setParams(uint16 baseFeeBps_, uint16 aprBps_, uint256 maxExitAmount_, bool acceptPending_)
        external
        onlyOwner
    {
        _setParams(baseFeeBps_, aprBps_, maxExitAmount_, acceptPending_);
    }

    // ---------------------------------------------------------------- internals

    /// @dev Deposits mint only to the caller: locking someone else's shares would be a free griefing vector.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override nonReentrant {
        if (receiver != caller) revert ReceiverMustBeCaller();
        super._deposit(caller, receiver, assets, shares);
        _idle += assets;
        shareUnlockTime[receiver] = block.timestamp + SHARE_LOCK;
    }

    /// @dev maxWithdraw/maxRedeem already cap at idle and enforce the lock (ERC4626 reverts above them).
    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        _idle -= assets;
        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    /// @dev Locked shares cannot move, so the lock can neither be bypassed via a fresh address nor pushed
    ///      onto someone else. Burns (withdraw/redeem) are gated by maxWithdraw/maxRedeem instead.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && block.timestamp < shareUnlockTime[from]) {
            revert SharesLocked(shareUnlockTime[from]);
        }
        super._update(from, to, value);
    }

    /// @dev Virtual shares blunt first-depositor inflation attacks (asset has 6 decimals).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function _requirePurchased(ExitRecord calldata exit) private view returns (bytes32 key, uint256 cost) {
        key = ExitKeys.id(exit.gateway, exit.exitNum, exit.initialDestination);
        Purchase storage p = purchases[key];
        if (p.recordHash != keccak256(abi.encode(exit))) revert UnknownExit(key);
        cost = p.cost;
    }

    function _setParams(uint16 baseFeeBps_, uint16 aprBps_, uint256 maxExitAmount_, bool acceptPending_) private {
        if (baseFeeBps_ > MAX_BASE_FEE_BPS || aprBps_ > MAX_APR_BPS) revert BadParams();
        baseFeeBps = baseFeeBps_;
        aprBps = aprBps_;
        maxExitAmount = maxExitAmount_;
        acceptPending = acceptPending_;
        emit ParamsUpdated(baseFeeBps_, aprBps_, maxExitAmount_, acceptPending_);
    }
}
