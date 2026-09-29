// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ExitRecord, IExitBuyer, IExitMarket, IExitVault} from "./interfaces/IExitMarket.sol";

/// @title ExitVault
/// @notice ERC-4626 vault that gives L3 users an instant exit: it buys verified pending withdrawals of its
///         own asset (USDG) at `face - baseFee - APR x timeToConfirm`, then collects face value when the
///         withdrawal executes. LPs earn the discount; no oracle is needed because payout token = asset.
/// @dev totalAssets = idle + outstanding face, tracked internally (not balanceOf) so that executed-but-not-
///      yet-collected exits are not double counted and donations cannot move the share price.
///      Risk borne by LPs: a pending exit whose rollup node is later rejected is written off.
contract ExitVault is ERC4626, Ownable2Step, ReentrancyGuard, IExitVault {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_BASE_FEE_BPS = 500;
    uint16 public constant MAX_APR_BPS = 5_000;
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
    uint256 private _outstanding;
    /// @dev key => keccak256(abi.encode(ExitRecord)) of exits bought and not yet collected / written off.
    mapping(bytes32 key => bytes32 recordHash) public purchases;

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
        _setParams(10, 1_000, type(uint256).max, true);
    }

    // ---------------------------------------------------------------- exit buying

    /// @inheritdoc IExitBuyer
    function buyExit(ExitRecord calldata exit) external onlyMarket nonReentrant returns (uint256 price) {
        if (exit.l1Token != asset()) revert WrongToken(exit.l1Token);
        if (exit.pending && !acceptPending) revert PendingNotAccepted();
        if (exit.amount > maxExitAmount) revert ExitTooLarge(exit.amount);

        price = quote(exit);
        if (price > _idle) revert InsufficientLiquidity(price, _idle);

        bytes32 key = _key(exit);
        purchases[key] = keccak256(abi.encode(exit));
        _idle -= price;
        _outstanding += exit.amount;

        IERC20(asset()).safeTransfer(address(market), price);
        emit ExitPurchased(key, exit.amount, price);
    }

    /// @inheritdoc IExitVault
    function collect(ExitRecord calldata exit) external nonReentrant {
        bytes32 key = _requirePurchased(exit);
        if (!market.isExitSpent(exit)) revert ExitStillLive(key);

        delete purchases[key];
        _outstanding -= exit.amount;
        _idle += exit.amount;
        emit ExitCollected(key, exit.amount);
    }

    /// @inheritdoc IExitVault
    function writeOff(ExitRecord calldata exit) external nonReentrant {
        bytes32 key = _requirePurchased(exit);
        if (market.isExitSpent(exit) || market.isExitLive(exit)) revert ExitStillLive(key);

        delete purchases[key];
        _outstanding -= exit.amount;
        emit ExitWrittenOff(key, exit.amount);
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
        return _idle + _outstanding;
    }

    /// @notice Withdrawals are limited to idle liquidity; outstanding exits return it over time.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), _idle);
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), _convertToShares(_idle, Math.Rounding.Floor));
    }

    /// @inheritdoc IExitVault
    function idleAssets() external view returns (uint256) {
        return _idle;
    }

    /// @inheritdoc IExitVault
    function outstandingFace() external view returns (uint256) {
        return _outstanding;
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

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override nonReentrant {
        super._deposit(caller, receiver, assets, shares);
        _idle += assets;
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        if (assets > _idle) revert InsufficientLiquidity(assets, _idle);
        _idle -= assets;
        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    /// @dev Virtual shares blunt first-depositor inflation attacks (asset has 6 decimals).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function _requirePurchased(ExitRecord calldata exit) private view returns (bytes32 key) {
        key = _key(exit);
        bytes32 stored = purchases[key];
        if (stored == bytes32(0) || stored != keccak256(abi.encode(exit))) revert UnknownExit(key);
    }

    function _key(ExitRecord calldata exit) private view returns (bytes32) {
        return market.listingId(exit.gateway, exit.exitNum, exit.initialDestination);
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
