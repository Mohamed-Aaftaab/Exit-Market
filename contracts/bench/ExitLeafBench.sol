// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitLeaf} from "../libraries/ExitLeaf.sol";

/// @notice Solidity twin of the Stylus ExitProof program (same ABI), used to benchmark gas on-chain.
contract ExitLeafBench {
    function itemHash(
        address childGateway,
        address parentGateway,
        address l1Token,
        address from,
        address to,
        uint256 amount,
        uint256 exitNum,
        uint256 l2Block,
        uint256 l1Block,
        uint256 l2Timestamp,
        uint256 value
    ) external pure returns (bytes32) {
        return ExitLeaf.itemHashWithValue(
            ExitLeaf.Leaf({
                childGateway: childGateway,
                parentGateway: parentGateway,
                l1Token: l1Token,
                from: from,
                initialDestination: to,
                amount: amount,
                exitNum: exitNum,
                l2Block: l2Block,
                l1Block: l1Block,
                l2Timestamp: l2Timestamp
            }),
            value
        );
    }

    function rootFromItem(bytes32 item, bytes32[] calldata proof, uint256 index) external pure returns (bytes32) {
        return ExitLeaf.rootFromItem(item, proof, index);
    }
}
