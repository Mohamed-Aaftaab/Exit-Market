// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ExitLeaf} from "../libraries/ExitLeaf.sol";

/// @dev Wraps the internal library so reverts can be asserted with vm.expectRevert.
contract ExitLeafHarness {
    function rootOf(ExitLeaf.Leaf memory leaf, bytes32[] memory proof, uint256 index) external pure returns (bytes32) {
        return ExitLeaf.computeRoot(leaf, proof, index);
    }
}

contract ExitLeafTest is Test {
    ExitLeafHarness private harness;

    // Real withdrawal on Xai Testnet (chain 37714555429), verified against the live
    // Outbox 0xc7491a...5d51 and rollup node 61781 on Arbitrum Sepolia on 2026-09-29.
    address private constant CHILD_GATEWAY = 0xD840761a09609394FaFA3404bEEAb312059AC558;
    address private constant PARENT_GATEWAY = 0xCcB451C4Df22addCFe1447c58bC6b2f264Bb1256;
    bytes32 private constant REAL_SEND_ROOT = 0xd8a1c3386ad861c9533e67e76d0f3e403adb04a819775a7ec0ca2404c462b583;
    uint256 private constant REAL_INDEX = 72;

    function setUp() public {
        harness = new ExitLeafHarness();
    }

    function _realLeaf() private pure returns (ExitLeaf.Leaf memory) {
        return ExitLeaf.Leaf({
            childGateway: CHILD_GATEWAY,
            parentGateway: PARENT_GATEWAY,
            l1Token: 0x67e197D575e7A350Ff3dE1A7eAd2aA06b19145B6,
            from: 0x2cd28Cda6825C4967372478E87D004637B73F996,
            initialDestination: 0x2cd28Cda6825C4967372478E87D004637B73F996,
            amount: 1_000_000_000_000_000,
            exitNum: 3,
            l2Block: 14_217_403,
            l1Block: 9_173_964,
            l2Timestamp: 1_757_504_867
        });
    }

    function _realProof() private pure returns (bytes32[] memory p) {
        p = new bytes32[](7);
        p[0] = 0x6e2f997569dd82bdb30c0ce25af0633f7331c580d4b6aaf1cd8904f3b4c7113a;
        p[1] = 0xcebc5eda66a599bf0568aae47dde4cefb5f543fbca405016aa3c1490490a2973;
        p[2] = bytes32(0);
        p[3] = 0x3a2d5e8fcce99f0fd08bd609d1303903ab54e9ddfa2730834e14562f11b17dac;
        p[4] = bytes32(0);
        p[5] = bytes32(0);
        p[6] = 0x2355f193840f04fc94aed433f911e03a9935a907db640130efbaf69442f7ddd6;
    }

    function test_realXaiWithdrawal_reproducesLiveSendRoot() public view {
        assertEq(harness.rootOf(_realLeaf(), _realProof(), REAL_INDEX), REAL_SEND_ROOT);
    }

    function test_tamperedAmount_changesRoot() public view {
        ExitLeaf.Leaf memory leaf = _realLeaf();
        leaf.amount += 1;
        assertTrue(harness.rootOf(leaf, _realProof(), REAL_INDEX) != REAL_SEND_ROOT);
    }

    function test_tamperedDestination_changesRoot() public view {
        ExitLeaf.Leaf memory leaf = _realLeaf();
        leaf.initialDestination = address(0xBEEF);
        assertTrue(harness.rootOf(leaf, _realProof(), REAL_INDEX) != REAL_SEND_ROOT);
    }

    function test_tamperedExitNum_changesRoot() public view {
        ExitLeaf.Leaf memory leaf = _realLeaf();
        leaf.exitNum = 4;
        assertTrue(harness.rootOf(leaf, _realProof(), REAL_INDEX) != REAL_SEND_ROOT);
    }

    /// Padding the index with bits above the proof length would still hash to the same root,
    /// but make Outbox.isSpent read a different slot. Must revert (mirrors AbsOutbox PathNotMinimal).
    function test_paddedIndex_reverts() public {
        uint256 padded = REAL_INDEX + (1 << 7);
        vm.expectRevert(abi.encodeWithSelector(ExitLeaf.PathNotMinimal.selector, padded, 7));
        harness.rootOf(_realLeaf(), _realProof(), padded);
    }

    function test_proofTooLong_reverts() public {
        bytes32[] memory tooLong = new bytes32[](256);
        vm.expectRevert(abi.encodeWithSelector(ExitLeaf.ProofTooLong.selector, 256));
        harness.rootOf(_realLeaf(), tooLong, 0);
    }

    function testFuzz_indexAboveProofLength_reverts(uint256 index, uint8 len) public {
        len = uint8(bound(len, 0, 64));
        index = bound(index, uint256(1) << len, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ExitLeaf.PathNotMinimal.selector, index, len));
        harness.rootOf(_realLeaf(), new bytes32[](len), index);
    }
}
