// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ExitRecord, IExitBuyer} from "../../interfaces/IExitMarket.sol";

/// @dev Configurable IExitBuyer: approves `pay`, reports `claimed` (0 = honest, i.e. `pay`) as the price the market
///      pulls, optionally re-enters the market.
contract TestBuyer is IExitBuyer {
    IERC20 public immutable token;
    uint256 public pay;
    uint256 public claimed;
    address public reenterTarget;
    bytes public reenterData;
    bool public swallowReentryFailure;

    bool public reentered;
    bool public reentryBlocked;
    bytes4 public reentryError;
    uint256 public lastAmount;

    constructor(IERC20 token_, uint256 pay_) {
        token = token_;
        pay = pay_;
    }

    function setClaimed(uint256 claimed_) external {
        claimed = claimed_;
    }

    function setReentry(address target, bytes calldata data, bool swallow) external {
        reenterTarget = target;
        reenterData = data;
        swallowReentryFailure = swallow;
    }

    function buyExit(ExitRecord calldata exit) external returns (uint256) {
        lastAmount = exit.amount;
        if (reenterData.length > 0) {
            reentered = true;
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) {
                if (!swallowReentryFailure) {
                    assembly {
                        revert(add(ret, 32), mload(ret))
                    }
                }
                reentryBlocked = true;
                reentryError = bytes4(ret);
            }
        }
        token.approve(msg.sender, pay);
        return claimed == 0 ? pay : claimed;
    }
}
