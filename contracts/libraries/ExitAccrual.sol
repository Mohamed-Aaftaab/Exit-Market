// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Linear accrual of the discount an exit buyer earns between purchase and the exit's deadline.
library ExitAccrual {
    /// @notice Value of an open position at `nowBlock`: its cost plus the share of the discount (face - cost)
    ///         that has accrued linearly from `startBlock` (purchase) to `endBlock` (the earliest block the
    ///         exit's node can confirm).
    /// @dev Monotonically non-decreasing in `nowBlock` and always within [cost, face]. Rounds down, so the
    ///      remainder booked at collect() is never negative. A deadline at or before the purchase block
    ///      (confirmed exit, or a node already past its deadline) accrues the whole discount at once: there is
    ///      no confirmation wait left to be paid for.
    /// @param cost price paid for the exit
    /// @param face amount the exit pays out
    /// @param startBlock block of purchase
    /// @param endBlock ExitRecord.deadlineBlock (same L1-block unit as `startBlock`/`nowBlock` on Arbitrum)
    /// @param nowBlock block at which to value the position
    function valueAt(uint256 cost, uint256 face, uint256 startBlock, uint256 endBlock, uint256 nowBlock)
        internal
        pure
        returns (uint256)
    {
        if (face <= cost) return cost;
        if (nowBlock >= endBlock) return face;
        if (nowBlock <= startBlock) return cost;
        return cost + Math.mulDiv(face - cost, nowBlock - startBlock, endBlock - startBlock);
    }
}
