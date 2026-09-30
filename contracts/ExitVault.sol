// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ExitRecord, IExitBuyer, IExitMarket, PayoutProof} from "./interfaces/IExitMarket.sol";
import {IExitVault} from "./interfaces/IExitVault.sol";
import {ExitAccrual} from "./libraries/ExitAccrual.sol";
import {ExitKeys} from "./libraries/ExitKeys.sol";

/// @title ExitVault
/// @notice ERC-4626 vault that gives L3 users an instant exit: it buys verified pending withdrawals of its
///         own asset (USDG) at `face - baseFee - APR x timeToConfirm`, then collects face value when the
///         withdrawal pays out. LPs earn the discount; no oracle is needed because payout token = asset.
/// @dev NAV = idle + sum over the (at most MAX_OPEN_POSITIONS) open exits of their value, where idle is tracked
///      internally (not balanceOf), so donations cannot move the share price and executed-but-uncollected exits
///      are not double counted. An open exit is worth
///        - 0 if its rollup node is rejected (`market.isExitRejected`), evaluated on every call, so no deposit or
///          redemption can price off a doomed exit while nobody has called writeOff yet (H1);
///        - otherwise its cost plus the purchase discount accrued linearly from the purchase block to the exit's
///          deadlineBlock (ExitAccrual), so collect() causes no NAV step beyond the not-yet-accrued remainder
///          and a fresh depositor cannot capture a discount incumbents carried (H2).
///      Deposits pause while any open exit is rejected or any written-off exit is impaired; the impairment
///      window belongs to the rejected root (rollup + send root), not to each exit (H3). LP risk: a rejected
///      exit that later pays out anyway (re-committed by the honest node) is still credited by collect().
contract ExitVault is ERC4626, Ownable2Step, ReentrancyGuard, IExitVault {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_BASE_FEE_BPS = 500;
    uint16 public constant MAX_APR_BPS = 5_000;
    uint16 public constant DEFAULT_BASE_FEE_BPS = 10; // 0.10%
    uint16 public constant DEFAULT_APR_BPS = 1_000; // 10% APR on time-to-confirm
    uint256 public constant SHARE_LOCK = 7 days;
    /// @dev After a write-off NAV may be understated (a real exit gets re-committed and collected); deposits
    ///      pause until the root's window ends (counted from the FIRST write-off under that root) or the exit is
    ///      collected, so nobody can buy in at the dip.
    uint256 public constant IMPAIRMENT_WINDOW = 14 days;
    /// @dev Bounds every NAV computation (one market call per open exit). Buying beyond it reverts in the buyer
    ///      hook, so the seller's transaction fails whole and nothing is stranded.
    uint256 public constant MAX_OPEN_POSITIONS = 32;
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

    /// @dev Packed so valuing an open position reads four slots. gateway/nodeNum/sendRoot are the only fields
    ///      ExitMarket.isExitRejected reads; the rest of the record is bound by `recordHash`.
    struct Position {
        bytes32 recordHash; // keccak256(abi.encode(ExitRecord)): binds collect/writeOff to the exact record
        uint128 cost;
        bool writtenOff; // cost already removed from outstanding; collect() still credits the payout
        uint64 writtenOffAt;
        bool finalized; // impairment over (finalizeWriteOff, or written off after the window); collect() still credits
        uint32 openIndex; // index in _openKeys while open (not written off)
        uint128 amount; // face value
        uint64 purchasedBlock;
        uint64 deadlineBlock;
        address gateway;
        uint64 nodeNum;
        bytes32 sendRoot;
    }

    mapping(bytes32 key => Position) private _positions;
    /// @dev Bought, not collected, not written off. Swap-and-pop keeps it dense.
    bytes32[] private _openKeys;
    /// @dev keccak256(rollup, sendRoot) => end of the impairment window opened by that root's first write-off.
    mapping(bytes32 rootKey => uint64 endsAt) private _windowEnd;
    mapping(address account => uint256 unlockTime) public shareUnlockTime;
    /// @notice Written-off exits still inside their root's impairment window; deposits pause while non-zero.
    uint256 public impairedExits;

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
        if (exit.amount > maxExitAmount || exit.amount > type(uint128).max) revert ExitTooLarge(exit.amount);
        if (_openKeys.length >= MAX_OPEN_POSITIONS) revert TooManyOpenPositions(MAX_OPEN_POSITIONS);

        price = quote(exit);
        if (price > _idle) revert InsufficientLiquidity(price, _idle);

        bytes32 key = ExitKeys.id(exit.gateway, exit.exitNum, exit.initialDestination);
        if (_positions[key].recordHash != bytes32(0)) revert AlreadyPurchased(key);
        _positions[key] = Position({
            recordHash: keccak256(abi.encode(exit)),
            cost: uint128(price),
            writtenOff: false,
            writtenOffAt: 0,
            finalized: false,
            openIndex: uint32(_openKeys.length),
            amount: uint128(exit.amount),
            purchasedBlock: uint64(block.number),
            deadlineBlock: exit.deadlineBlock,
            gateway: exit.gateway,
            nodeNum: exit.nodeNum,
            sendRoot: exit.sendRoot
        });
        _openKeys.push(key);
        _idle -= price;
        _outstandingCost += price;

        IERC20(asset()).safeTransfer(address(market), price);
        emit ExitPurchased(key, exit.amount, price);
    }

    /// @inheritdoc IExitVault
    function collect(ExitRecord calldata exit, PayoutProof calldata payout) external nonReentrant {
        (bytes32 key, Position storage p) = _requirePurchased(exit);
        if (!market.isExitPaidOut(exit, payout)) revert ExitNotPaidOut(key);

        uint256 released;
        if (!p.writtenOff) {
            released = p.cost;
            _removeOpen(p.openIndex);
            _outstandingCost -= released;
        } else if (!p.finalized) {
            --impairedExits;
        }
        delete _positions[key];
        _idle += exit.amount;
        emit ExitCollected(key, exit.amount, released);
    }

    /// @inheritdoc IExitVault
    function writeOff(ExitRecord calldata exit) external nonReentrant {
        (bytes32 key, Position storage p) = _requirePurchased(exit);
        if (p.writtenOff) revert AlreadyWrittenOff(key);
        if (!market.isExitRejected(exit)) revert ExitNotRejected(key);

        // Keep the record: a real exit is re-committed by the honest node and collect() can still credit it.
        uint256 cost = p.cost;
        _removeOpen(p.openIndex);
        _outstandingCost -= cost;
        p.writtenOff = true;
        p.writtenOffAt = uint64(block.timestamp);
        if (_joinWindow(exit)) ++impairedExits;
        else p.finalized = true; // the root's window already elapsed: a late write-off must not pause deposits again
        emit ExitWrittenOff(key, cost);
    }

    /// @inheritdoc IExitVault
    function finalizeWriteOff(ExitRecord calldata exit) external nonReentrant {
        (bytes32 key, Position storage p) = _requirePurchased(exit);
        if (!p.writtenOff || p.finalized) revert NotImpaired(key);
        if (block.timestamp < _windowEnd[_rootKey(exit)]) revert ImpairmentWindowOpen(key);

        p.finalized = true;
        --impairedExits;
        emit WriteOffFinalized(key);
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

    /// @notice Idle liquidity plus every open exit at cost + accrued discount; a rejected exit counts zero.
    /// @inheritdoc ERC4626
    function totalAssets() public view override returns (uint256 nav) {
        nav = _idle;
        uint256 n = _openKeys.length;
        for (uint256 i; i < n; ++i) {
            Position storage p = _positions[_openKeys[i]];
            if (_isRejected(p)) continue;
            nav += ExitAccrual.valueAt(p.cost, p.amount, p.purchasedBlock, p.deadlineBlock, block.number);
        }
    }

    /// @notice Zero while a written-off exit is impaired or an open exit's node is rejected (NAV may be
    ///         understated until the honest re-commit).
    function maxDeposit(address receiver) public view override returns (uint256) {
        return _depositsPaused() ? 0 : super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return _depositsPaused() ? 0 : super.maxMint(receiver);
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

    /// @notice Same 5-field tuple as when `purchases` was a public mapping (the keeper and web decode it).
    function purchases(bytes32 key)
        external
        view
        returns (bytes32 recordHash, uint256 cost, bool writtenOff, uint64 writtenOffAt, bool finalized)
    {
        Position storage p = _positions[key];
        return (p.recordHash, p.cost, p.writtenOff, p.writtenOffAt, p.finalized);
    }

    /// @inheritdoc IExitVault
    function idleAssets() external view returns (uint256) {
        return _idle;
    }

    /// @inheritdoc IExitVault
    function outstandingCost() external view returns (uint256) {
        return _outstandingCost;
    }

    /// @inheritdoc IExitVault
    function openPositionCount() external view returns (uint256) {
        return _openKeys.length;
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

    function _depositsPaused() private view returns (bool) {
        if (impairedExits > 0) return true;
        uint256 n = _openKeys.length;
        for (uint256 i; i < n; ++i) {
            if (_isRejected(_positions[_openKeys[i]])) return true;
        }
        return false;
    }

    /// @dev Asks the market whether the node behind `p` was rejected. Only gateway, sendRoot and nodeNum are
    ///      stored because they are all ExitMarket.isExitRejected reads. If the check itself reverts (e.g. a
    ///      legacy verifier whose rollup was upgraded), the exit stays valued as before this check existed
    ///      instead of bricking every deposit and redemption; writeOff/collect do not depend on it.
    function _isRejected(Position storage p) private view returns (bool rejected) {
        ExitRecord memory probe;
        probe.gateway = p.gateway;
        probe.sendRoot = p.sendRoot;
        probe.nodeNum = p.nodeNum;
        try market.isExitRejected(probe) returns (bool r) {
            rejected = r;
        } catch {}
    }

    /// @dev Swap-and-pop; the moved position's index is patched. The removed position's own index goes stale.
    function _removeOpen(uint256 index) private {
        uint256 last = _openKeys.length - 1;
        if (index != last) {
            bytes32 moved = _openKeys[last];
            _openKeys[index] = moved;
            _positions[moved].openIndex = uint32(index);
        }
        _openKeys.pop();
    }

    /// @dev One window per rejected root, opened by its first write-off and never extended.
    /// @return isOpen true if the root's window is still running (the exit counts as impaired)
    function _joinWindow(ExitRecord calldata exit) private returns (bool isOpen) {
        bytes32 rk = _rootKey(exit);
        uint64 endsAt = _windowEnd[rk];
        if (endsAt == 0) {
            endsAt = uint64(block.timestamp + IMPAIRMENT_WINDOW);
            _windowEnd[rk] = endsAt;
        }
        return block.timestamp < endsAt;
    }

    /// @dev Gateways of one rollup share send roots, so key by rollup (frozen per gateway in the market).
    function _rootKey(ExitRecord calldata exit) private view returns (bytes32) {
        return keccak256(abi.encode(market.getGatewayConfig(exit.gateway).rollup, exit.sendRoot));
    }

    function _requirePurchased(ExitRecord calldata exit) private view returns (bytes32 key, Position storage p) {
        key = ExitKeys.id(exit.gateway, exit.exitNum, exit.initialDestination);
        p = _positions[key];
        if (p.recordHash != keccak256(abi.encode(exit))) revert UnknownExit(key);
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
