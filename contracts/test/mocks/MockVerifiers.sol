// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRootVerifier} from "../../interfaces/IRootVerifier.sol";

/// @dev Verifies roots like `inner` but its rejection check always reverts, like a legacy verifier whose
///      rollup was upgraded to a contract without `firstUnresolvedNode`.
contract RejectionRevertsVerifier is IRootVerifier {
    IRootVerifier public immutable inner;

    constructor(IRootVerifier inner_) {
        inner = inner_;
    }

    function verifyRoot(address rollup, address outbox, bytes32 sendRoot, uint64 nodeNum, bytes32 blockHash)
        external
        view
        returns (bool valid, bool pending, uint64 deadlineBlock)
    {
        return inner.verifyRoot(rollup, outbox, sendRoot, nodeNum, blockHash);
    }

    function isRootRejected(address, address, bytes32, uint64) external pure returns (bool) {
        revert("rollup upgraded");
    }
}
