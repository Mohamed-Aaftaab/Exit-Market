// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BoldAssertionState, BoldGlobalState} from "../../interfaces/IBoldRollup.sol";
import {BoldRootVerifier} from "../../verifiers/BoldRootVerifier.sol";
import {MockOutbox} from "../mocks/MockArbitrum.sol";
import {MockBoldRollup} from "../mocks/MockBoldRollup.sol";

/// @dev Shared base for the BoldRootVerifier unit tests: a mock BOLD rollup with a confirmed GENESIS assertion,
///      and helpers to post (createAssertion: real hashing + child bookkeeping) and register assertions.
abstract contract BoldFixture is Test {
    uint8 internal constant NONE = 0;
    uint8 internal constant PENDING = 1;
    uint8 internal constant CONFIRMED = 2;
    uint64 internal constant CONFIRM_PERIOD = 45_818; // ~6.4 days of L1 blocks
    uint256 internal constant START_BLOCK = 1_000_000;
    bytes32 internal constant GENESIS = keccak256("confirmed parent assertion");
    bytes32 internal constant ROOT_A = keccak256("send root A");
    bytes32 internal constant ROOT_B = keccak256("send root B");
    bytes32 internal constant ROOT_C = keccak256("send root C");

    /// @dev An assertion posted to the mock rollup together with its full preimage.
    struct Posted {
        bytes32 parent;
        BoldAssertionState state;
        bytes32 inboxAcc;
        bytes32 hash;
        bytes32 sendRoot;
    }

    MockOutbox internal outbox;
    MockBoldRollup internal rollup;
    BoldRootVerifier internal verifier;
    address internal stranger;

    function setUp() public virtual {
        vm.roll(START_BLOCK);
        stranger = makeAddr("stranger");
        outbox = new MockOutbox();
        rollup = new MockBoldRollup(address(outbox), CONFIRM_PERIOD);
        verifier = new BoldRootVerifier();
        rollup.setAssertion(GENESIS, CONFIRMED, uint64(block.number), 0);
    }

    function _assertVerdict(bytes32 sendRoot, bytes32 witness, bool valid, bool pending, uint64 deadline)
        internal
        view
    {
        (bool v, bool p, uint64 d) = verifier.verifyRoot(address(rollup), address(outbox), sendRoot, 0, witness);
        assertEq(v, valid, "valid");
        assertEq(p, pending, "pending");
        assertEq(d, deadline, "deadlineBlock");
    }

    function _register(Posted memory p) internal returns (bytes32) {
        return verifier.register(address(rollup), p.parent, p.state, p.inboxAcc);
    }

    function _postRegistered(bytes32 parent, bytes32 sendRoot, uint256 salt) internal returns (Posted memory p) {
        p = _post(parent, sendRoot, salt);
        _register(p);
    }

    function _state(bytes32 sendRoot, uint256 salt) internal pure returns (BoldAssertionState memory s) {
        s.globalState = BoldGlobalState({
            bytes32Vals: [keccak256(abi.encode("l2 block", salt)), sendRoot], u64Vals: [uint64(salt), uint64(0)]
        });
        s.machineStatus = 1; // FINISHED
        s.endHistoryRoot = keccak256(abi.encode("history", salt));
    }

    /// @dev Posts a Pending assertion on the mock rollup at the current block. `salt` keeps siblings distinct.
    function _post(bytes32 parent, bytes32 sendRoot, uint256 salt) internal returns (Posted memory p) {
        p.parent = parent;
        p.sendRoot = sendRoot;
        p.state = _state(sendRoot, salt);
        p.inboxAcc = keccak256(abi.encode("inbox", salt));
        p.hash = rollup.createAssertion(parent, p.state, p.inboxAcc);
    }

    /// @dev Ours (ROOT_A, pending) and a confirmed sibling (ROOT_B) under GENESIS, both registered.
    function _losingSiblingSetup() internal returns (Posted memory ours, Posted memory sibling) {
        ours = _post(GENESIS, ROOT_A, 1);
        sibling = _post(GENESIS, ROOT_B, 2);
        _register(ours);
        _register(sibling);
        rollup.confirmAssertion(sibling.hash);
    }
}
