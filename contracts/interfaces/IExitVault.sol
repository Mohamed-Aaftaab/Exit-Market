// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitClaim, ExitRecord, IExitBuyer} from "./IExitMarket.sol";

/// @notice ERC-4626 USDG vault that buys USDG exits instantly at a time-based discount.
interface IExitVault is IExitBuyer {
    event ExitPurchased(bytes32 indexed key, uint256 amount, uint256 price);
    /// @notice Exit paid out: `amount` added to idle, `cost` removed from outstanding; the gain accrues to LPs.
    event ExitCollected(bytes32 indexed key, uint256 amount, uint256 cost);
    event ExitWrittenOff(bytes32 indexed key, uint256 cost);
    event ParamsUpdated(uint16 baseFeeBps, uint16 aprBps, uint256 maxExitAmount, bool acceptPending);

    error OnlyMarket();
    error WrongToken(address l1Token);
    error PendingNotAccepted();
    error ExitTooLarge(uint256 amount);
    error InsufficientLiquidity(uint256 needed, uint256 idle);
    error UnknownExit(bytes32 key);
    error ExitNotPaidOut(bytes32 key);
    error ExitNotDisproven(bytes32 key);
    error SharesLocked(uint256 unlockTime);
    error ReceiverMustBeCaller();
    error BadParams();

    /// @notice price = amount - amount*baseFeeBps/1e4 - amount*aprBps*secondsToConfirm/(1e4*365 days),
    ///         secondsToConfirm = max(deadlineBlock - block.number, 0) * 12 (block.number is L1 on Arbitrum).
    function quote(ExitRecord calldata exit) external view returns (uint256 price);

    /// @notice Permissionless: once the exit provably paid out (see IExitMarket.isExitPaidOut), book the
    ///         face value as idle and release its cost from outstanding.
    function collect(ExitRecord calldata exit, bytes32 confirmedRoot, bytes32[] calldata proof) external;

    /// @notice Permissionless: realize the loss of a fake exit, given a fraud proof (see
    ///         IExitMarket.isExitDisproven): a confirmed root holding a different item for the same exitNum.
    function writeOff(ExitRecord calldata exit, ExitClaim calldata canonical) external;

    /// @notice Owner: pricing and risk parameters (capped).
    function setParams(uint16 baseFeeBps, uint16 aprBps, uint256 maxExitAmount, bool acceptPending) external;

    /// @notice USDG available for withdrawals and new purchases.
    function idleAssets() external view returns (uint256);

    /// @notice Sum of prices paid for exits not yet collected (exits are carried at cost).
    function outstandingCost() external view returns (uint256);
}
