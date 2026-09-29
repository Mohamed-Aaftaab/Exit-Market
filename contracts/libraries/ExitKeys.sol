// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Canonical id of an exit, shared by the market and buyers (no external call needed).
library ExitKeys {
    /// @dev Exit numbers are per child gateway and redirects are keyed by (exitNum, initialDestination)
    ///      inside each parent gateway, so the triple is globally unique.
    function id(address gateway, uint256 exitNum, address initialDestination) internal pure returns (bytes32) {
        return keccak256(abi.encode(gateway, exitNum, initialDestination));
    }
}
