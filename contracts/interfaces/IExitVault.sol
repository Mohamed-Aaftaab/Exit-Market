// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRecord, IExitBuyer, PayoutProof} from "./IExitMarket.sol";

/// @notice ERC-4626 USDG vault that buys USDG exits instantly at a time-based discount.
interface IExitVault is IExitBuyer {
    event ExitPurchased(bytes32 indexed key, uint256 amount, uint256 price);
    /// @notice Exit paid out: `amount` added to idle, `costReleased` removed from outstanding (0 if the exit had
    ///         been written off); the difference accrues to LPs.
    event ExitCollected(bytes32 indexed key, uint256 amount, uint256 costReleased);
    event ExitWrittenOff(bytes32 indexed key, uint256 cost);
    event WriteOffFinalized(bytes32 indexed key);
    event ParamsUpdated(uint16 baseFeeBps, uint16 aprBps, uint256 maxExitAmount, bool acceptPending);

    error OnlyMarket();
    error WrongToken(address l1Token);
    error PendingNotAccepted();
    error ExitTooLarge(uint256 amount);
    error InsufficientLiquidity(uint256 needed, uint256 idle);
    /// @notice The vault already carries MAX_OPEN_POSITIONS uncollected exits; the sale reverts (fail closed).
    error TooManyOpenPositions(uint256 max);
    /// @notice Defensive: the market cannot hand the vault the same exit twice.
    error AlreadyPurchased(bytes32 key);
    error UnknownExit(bytes32 key);
    error ExitNotPaidOut(bytes32 key);
    error ExitNotRejected(bytes32 key);
    error AlreadyWrittenOff(bytes32 key);
    error NotImpaired(bytes32 key);
    error ImpairmentWindowOpen(bytes32 key);
    error SharesLocked(uint256 unlockTime);
    error ReceiverMustBeCaller();
    error BadParams();

    /// @notice price = amount - amount*baseFeeBps/1e4 - amount*aprBps*secondsToConfirm/(1e4*365 days),
    ///         secondsToConfirm = max(deadlineBlock - block.number, 0) * 12 (block.number is L1 on Arbitrum).
    function quote(ExitRecord calldata exit) external view returns (uint256 price);

    /// @notice Permissionless: once the exit provably paid out (see IExitMarket.isExitPaidOut), book the
    ///         face value as idle and release its cost from outstanding. Works for written-off exits too.
    ///         NAV already carries the discount accrued up to the deadline, so this moves it only by the
    ///         part not yet accrued (zero once `block.number >= deadlineBlock`).
    function collect(ExitRecord calldata exit, PayoutProof calldata payout) external;

    /// @notice Permissionless bookkeeping: once the exit's node is rejected (IExitMarket.isExitRejected), drop
    ///         the position from the open set and start (or join) its root's impairment window. NAV already
    ///         values a rejected exit at zero from the moment of rejection, so this never moves the share price.
    ///         The record is kept so a later genuine payout can still be collected.
    function writeOff(ExitRecord calldata exit) external;

    /// @notice Permissionless: close the impairment window of a written-off exit once its ROOT's window
    ///         (opened by the first write-off of any exit under the same rollup and send root, lasting
    ///         IMPAIRMENT_WINDOW) has elapsed, re-enabling deposits. A late genuine payout can still be collected.
    function finalizeWriteOff(ExitRecord calldata exit) external;

    /// @notice Owner: pricing and risk parameters (capped).
    function setParams(uint16 baseFeeBps, uint16 aprBps, uint256 maxExitAmount, bool acceptPending) external;

    /// @notice USDG available for withdrawals and new purchases.
    function idleAssets() external view returns (uint256);

    /// @notice Sum of prices paid for exits that are open (bought, not collected, not written off), at cost.
    ///         totalAssets() is NOT idle + outstanding cost any more: it adds the discount accrued so far and
    ///         values open exits whose node is rejected at zero.
    function outstandingCost() external view returns (uint256);

    /// @notice Number of open exits; buying is refused (TooManyOpenPositions) at MAX_OPEN_POSITIONS.
    function openPositionCount() external view returns (uint256);
}
