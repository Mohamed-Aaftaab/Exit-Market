// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BoldAssertionState, BoldGlobalState} from "../interfaces/IBoldRollup.sol";
import {ExitRecord, IExitMarket} from "../interfaces/IExitMarket.sol";
import {IExitVault} from "../interfaces/IExitVault.sol";
import {ExitMarket} from "../ExitMarket.sol";
import {ExitVault} from "../ExitVault.sol";
import {BoldRootVerifier} from "../verifiers/BoldRootVerifier.sol";
import {MockBridge, MockExtendedGateway, MockInbox, MockOutbox} from "./mocks/MockArbitrum.sol";
import {MockBoldRollup} from "./mocks/MockBoldRollup.sol";
import {ExitFixture} from "./utils/ExitFixture.sol";

/// @dev ExitMarket + BoldRootVerifier end to end on a mock BOLD rollup: real merkle trees of withdrawal leaves are
///      committed as the sendRoot of a pending assertion, and ExitClaim.blockHash carries the assertion hash.
///      Reuses the ExitFixture helpers after swapping its gateway stack for a BOLD-backed one.
contract ExitMarketBoldTest is ExitFixture {
    uint8 private constant CONFIRMED = 2;
    uint64 private constant BOLD_CONFIRM_PERIOD = 45_818;
    uint256 private constant START_BLOCK = 1_000_000; // ExitFixture.setUp rolls here
    uint256 private constant PRICE = 9_900e6;
    uint256 private constant LP_DEPOSIT = 100_000e6;
    bytes32 private constant GENESIS = keccak256("confirmed parent assertion");
    bytes32 private constant RIVAL_ROOT = keccak256("rival send root");

    /// @dev A posted assertion together with its preimage (needed to register it).
    struct Posted {
        bytes32 parent;
        BoldAssertionState state;
        bytes32 inboxAcc;
        bytes32 hash;
        uint64 createdAtBlock;
    }

    MockBoldRollup private boldRollup;
    BoldRootVerifier private boldVerifier;
    ExitVault private vault;
    address private lp;

    function setUp() public override {
        super.setUp(); // legacy stack (unused below, but keeps the inherited fields initialised)

        outbox = new MockOutbox();
        boldRollup = new MockBoldRollup(address(outbox), BOLD_CONFIRM_PERIOD);
        bridge = new MockBridge(address(boldRollup)); // MockBridge only needs rollup.outbox()
        inbox = new MockInbox(address(bridge));
        gateway = new MockExtendedGateway(CHILD_GATEWAY, address(inbox));
        boldVerifier = new BoldRootVerifier();
        market = new ExitMarket(address(usdg), owner, FEE_BPS, feeRecipient);
        boldRollup.setAssertion(GENESIS, CONFIRMED, uint64(block.number), 0);

        vm.prank(owner);
        market.allowGateway(address(gateway), boldVerifier);

        vault = new ExitVault(IERC20(address(usdg)), IExitMarket(address(market)), owner, "V", "V");
        lp = makeAddr("lp");
        _fund(lp, address(vault), LP_DEPOSIT);
        vm.prank(lp);
        vault.deposit(LP_DEPOSIT, lp);
    }

    // ============================================================ wiring

    function test_allowGateway_derivesBoldRollupAndOutbox() public view {
        IExitMarket.GatewayConfig memory cfg = market.getGatewayConfig(address(gateway));

        assertEq(cfg.rollup, address(boldRollup));
        assertEq(cfg.outbox, address(outbox));
        assertEq(address(cfg.verifier), address(boldVerifier));
        assertTrue(cfg.allowed);
    }

    // ============================================================ listing against a pending assertion

    function test_list_acceptsPendingUnchallengedBoldAssertionWithCorrectDeadline() public {
        Withdrawal[] memory ws = _createWithdrawals(3, seller, AMOUNT);
        Posted memory a = _commit(ws, GENESIS, 1, true);
        vm.roll(block.number + 200); // deadline must be anchored to assertion creation, not to listing time

        bytes32 id = _list(ws[1], seller, PRICE);

        IExitMarket.Listing memory l = market.getListing(id);
        assertEq(uint8(l.status), uint8(IExitMarket.Status.Listed));
        assertTrue(l.exit.pending);
        assertEq(l.exit.deadlineBlock, a.createdAtBlock + BOLD_CONFIRM_PERIOD);
        assertEq(l.exit.blockHash, a.hash);
        assertEq(l.exit.sendRoot, ws[1].claim.sendRoot);
        assertEq(l.exit.amount, AMOUNT);
        assertEq(l.exit.index, 1);
        assertEq(_ownerOf(ws[1]), address(market));
    }

    function test_list_worksForEveryLeafCommittedByTheAssertion() public {
        Withdrawal[] memory ws = _createWithdrawals(5, seller, AMOUNT);
        _commit(ws, GENESIS, 1, true);

        for (uint256 i = 0; i < ws.length; ++i) {
            _list(ws[i], seller, PRICE);
            assertEq(_ownerOf(ws[i]), address(market));
        }
    }

    function test_list_ignoresNodeNumBecauseBoldHasNoNodeNumbers() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _commit(ws, GENESIS, 1, true);
        ws[0].claim.nodeNum = type(uint64).max;

        bytes32 id = _list(ws[0], seller, PRICE);

        assertEq(uint8(market.getListing(id).status), uint8(IExitMarket.Status.Listed));
    }

    function test_list_confirmedRootNeedsNoRegistrationOrWitness() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _confirm(ws[0]); // root already in the Outbox
        ws[0].claim.blockHash = bytes32(0);

        bytes32 id = _list(ws[0], seller, PRICE);

        IExitMarket.Listing memory l = market.getListing(id);
        assertFalse(l.exit.pending);
        assertEq(l.exit.deadlineBlock, 0);
    }

    function test_list_afterAssertionConfirmsIsNoLongerPending() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        Posted memory a = _commit(ws, GENESIS, 1, true);
        boldRollup.confirmAssertion(a.hash); // publishes the send root to the Outbox

        bytes32 id = _list(ws[0], seller, PRICE);

        IExitMarket.Listing memory l = market.getListing(id);
        assertFalse(l.exit.pending);
        assertEq(l.exit.deadlineBlock, 0);
    }

    // ============================================================ rejected at listing

    function test_list_revertsInvalidRootWhenAssertionIsNotRegistered() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _commit(ws, GENESIS, 1, false);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        _list(ws[0], seller, PRICE);
        assertEq(_ownerOf(ws[0]), seller);
    }

    function test_list_revertsInvalidRootWhenNoAssertionWitnessIsGiven() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _commit(ws, GENESIS, 1, true);
        ws[0].claim.blockHash = bytes32(0);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        _list(ws[0], seller, PRICE);
    }

    function test_list_revertsInvalidRootWhenGenuineAssertionHashIsUsedToVouchForAForgedRoot() public {
        // Arrange: a genuine, registered, unchallenged assertion for tree #1 ...
        Withdrawal[] memory real = _createWithdrawals(2, seller, AMOUNT);
        Posted memory a = _commit(real, GENESIS, 1, true);
        // ... and an attacker's self-consistent forged tree #2 that no assertion commits to
        address attacker = makeAddr("attacker");
        Withdrawal[] memory forged = _createOn(gateway, NODE, 100, 1, attacker, AMOUNT);
        forged[0].claim.blockHash = a.hash;

        // Act / Assert
        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, forged[0].claim.sendRoot, NODE));
        _list(forged[0], attacker, PRICE);
    }

    function test_list_revertsInvalidRootWhenAssertionIsDisputedAtListingTime() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _commit(ws, GENESIS, 1, true);
        _postRival();

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        _list(ws[0], seller, PRICE);
    }

    // ============================================================ disputes after listing

    function test_buy_succeedsWhileAssertionIsPendingAndUnchallenged() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _commit(ws, GENESIS, 1, true);
        bytes32 id = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), PRICE);

        vm.prank(buyer);
        market.buy(id, PRICE);

        assertEq(_ownerOf(ws[0]), buyer);
        assertEq(uint8(market.getListing(id).status), uint8(IExitMarket.Status.Sold));
    }

    function test_buy_revertsInvalidRootWhenDisputeAppearsAfterListing() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        _commit(ws, GENESIS, 1, true);
        bytes32 id = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), PRICE);
        _postRival();

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        vm.prank(buyer);
        market.buy(id, PRICE);

        assertEq(uint8(market.getListing(id).status), uint8(IExitMarket.Status.Listed));
        assertEq(_ownerOf(ws[0]), address(market));
        assertEq(usdg.balanceOf(buyer), PRICE);
    }

    function test_buy_worksAgainOnceTheDisputeResolvesInFavourOfOurAssertion() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        Posted memory ours = _commit(ws, GENESIS, 1, true);
        bytes32 id = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), PRICE);
        _postRival();
        boldRollup.confirmAssertion(ours.hash);

        vm.prank(buyer);
        market.buy(id, PRICE);

        assertEq(_ownerOf(ws[0]), buyer);
    }

    function test_isExitLive_followsDisputeState() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        Posted memory ours = _commit(ws, GENESIS, 1, true);
        _list(ws[0], seller, PRICE);
        ExitRecord memory rec = _boldRecord(ws[0], ours);
        assertTrue(market.isExitLive(rec));

        _postRival();
        assertFalse(market.isExitLive(rec));

        boldRollup.confirmAssertion(ours.hash);
        assertTrue(market.isExitLive(rec));
    }

    // ============================================================ rejection and vault write-off

    function test_isExitRejected_trueOnlyAfterAConfirmedSiblingIsProven() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        Posted memory ours = _commit(ws, GENESIS, 1, true);
        ExitRecord memory rec = _boldRecord(ws[0], ours);
        assertFalse(market.isExitRejected(rec));

        Posted memory rival = _postRival();
        assertFalse(market.isExitRejected(rec), "a dispute alone is not a rejection");
        boldRollup.confirmAssertion(rival.hash);
        assertFalse(market.isExitRejected(rec), "a confirmed sibling must be proven on-chain first");

        boldVerifier.markRejected(address(boldRollup), ours.hash, ours.hash, rival.hash);
        assertTrue(market.isExitRejected(rec));
    }

    function test_isExitRejected_falseAgainIfTheSameRootIsLaterConfirmed() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        Posted memory ours = _commit(ws, GENESIS, 1, true);
        ExitRecord memory rec = _boldRecord(ws[0], ours);
        Posted memory rival = _postRival();
        boldRollup.confirmAssertion(rival.hash);
        boldVerifier.markRejected(address(boldRollup), ours.hash, ours.hash, rival.hash);
        assertTrue(market.isExitRejected(rec));

        outbox.setRoot(ws[0].claim.sendRoot, keccak256("re-committed and confirmed"));

        assertFalse(market.isExitRejected(rec));
    }

    function test_vault_writeOffRevertsBeforeRejectionIsProven() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        Posted memory ours = _commit(ws, GENESIS, 1, true);
        ExitRecord memory rec = _boldRecord(ws[0], ours);
        _sellTo(ws[0], seller, address(vault), 0);
        _postRival(); // disputed, but not resolved

        vm.expectRevert(abi.encodeWithSelector(IExitVault.ExitNotRejected.selector, _id(ws[0])));
        vault.writeOff(rec);
    }

    function test_vault_writeOffSucceedsAfterMarkRejected() public {
        // Arrange: the vault buys a pending exit backed by an unchallenged assertion
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        Posted memory ours = _commit(ws, GENESIS, 1, true);
        ExitRecord memory rec = _boldRecord(ws[0], ours);
        _sellTo(ws[0], seller, address(vault), 0);
        (bytes32 recordHash, uint256 cost,,,) = vault.purchases(_id(ws[0]));
        assertEq(recordHash, keccak256(abi.encode(rec)), "test record must equal the market's record");
        assertEq(vault.outstandingCost(), cost);

        // A rival wins the level; anyone proves the loss on-chain
        Posted memory rival = _postRival();
        boldRollup.confirmAssertion(rival.hash);
        boldVerifier.markRejected(address(boldRollup), ours.hash, ours.hash, rival.hash);
        assertTrue(market.isExitRejected(rec));

        // Act
        vm.expectEmit(true, false, false, true, address(vault));
        emit IExitVault.ExitWrittenOff(_id(ws[0]), cost);
        vault.writeOff(rec);

        // Assert
        (,, bool writtenOff,,) = vault.purchases(_id(ws[0]));
        assertTrue(writtenOff);
        assertEq(vault.outstandingCost(), 0);
        assertEq(vault.impairedExits(), 1);
    }

    function test_vault_collectsAfterTheBoldAssertionConfirmsAndTheExitExecutes() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        Posted memory ours = _commit(ws, GENESIS, 1, true);
        ExitRecord memory rec = _boldRecord(ws[0], ours);
        _sellTo(ws[0], seller, address(vault), 0);
        (, uint256 cost,,,) = vault.purchases(_id(ws[0]));
        uint256 idleBefore = vault.idleAssets();

        boldRollup.confirmAssertion(ours.hash);
        _execute(ws[0]);
        vault.collect(rec, _ownPayout(ws[0]));

        assertEq(vault.outstandingCost(), 0);
        assertEq(vault.idleAssets(), idleBefore + AMOUNT);
        assertGt(AMOUNT, cost, "LP earned the discount");
        assertEq(vault.impairedExits(), 0);
    }

    // ============================================================ multi-level pending chains

    function test_list_acceptsExitUnderAThreeLevelPendingChain() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        Posted memory level1 = _postRegistered(GENESIS, keccak256("level 1 root"), 11);
        vm.roll(START_BLOCK + 50);
        Posted memory level2 = _postRegistered(level1.hash, keccak256("level 2 root"), 12);
        vm.roll(START_BLOCK + 100);
        Posted memory level3 = _commit(ws, level2.hash, 13, true);
        vm.roll(START_BLOCK + 300);

        bytes32 id = _list(ws[1], seller, PRICE);

        IExitMarket.Listing memory l = market.getListing(id);
        assertEq(uint8(l.status), uint8(IExitMarket.Status.Listed));
        assertTrue(l.exit.pending);
        assertEq(l.exit.blockHash, level3.hash);
        assertEq(l.exit.deadlineBlock, START_BLOCK + 100 + BOLD_CONFIRM_PERIOD, "anchored to the leaf's creation");
        assertEq(_ownerOf(ws[1]), address(market));
    }

    function test_list_revertsInvalidRootWhenAnAncestorIsNotRegistered() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        Posted memory level1 = _post(GENESIS, keccak256("level 1 root"), 11); // pending, never registered
        Posted memory level2 = _postRegistered(level1.hash, keccak256("level 2 root"), 12);
        _commit(ws, level2.hash, 13, true);

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        _list(ws[0], seller, PRICE);

        _register(level1); // completing the chain makes the same claim acceptable
        _list(ws[0], seller, PRICE);
        assertEq(_ownerOf(ws[0]), address(market));
    }

    function test_buy_revertsInvalidRootWhenAnAncestorLevelIsDisputedAfterListing() public {
        Withdrawal[] memory ws = _createWithdrawals(2, seller, AMOUNT);
        Posted memory level1 = _postRegistered(GENESIS, keccak256("level 1 root"), 11);
        _commit(ws, level1.hash, 12, true);
        bytes32 id = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), PRICE);

        _postRival(); // rival of level 1: the leaf itself still has no rival child

        vm.expectRevert(abi.encodeWithSelector(IExitMarket.InvalidRoot.selector, ws[0].claim.sendRoot, NODE));
        vm.prank(buyer);
        market.buy(id, PRICE);
    }

    function test_vault_writeOffWorksForAnExitProvenUnderADescendantOfTheLoser() public {
        // Arrange: GENESIS -> loser -> leaf (commits the exit); the vault buys while everything is unchallenged
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        Posted memory loser = _postRegistered(GENESIS, keccak256("loser root"), 11);
        Posted memory leaf = _commit(ws, loser.hash, 12, true);
        ExitRecord memory rec = _boldRecord(ws[0], leaf);
        _sellTo(ws[0], seller, address(vault), 0);

        // A rival to the loser wins; nothing is provable on-chain until markRejected
        Posted memory winner = _postRival();
        boldRollup.confirmAssertion(winner.hash);
        assertFalse(market.isExitRejected(rec));
        vm.expectRevert(abi.encodeWithSelector(IExitVault.ExitNotRejected.selector, _id(ws[0])));
        vault.writeOff(rec);

        // Act: prove the leaf lost through its losing ancestor
        boldVerifier.markRejected(address(boldRollup), leaf.hash, loser.hash, winner.hash);

        // Assert
        assertTrue(market.isExitRejected(rec));
        vault.writeOff(rec);
        (,, bool writtenOff,,) = vault.purchases(_id(ws[0]));
        assertTrue(writtenOff);
        assertEq(vault.impairedExits(), 1);
    }

    // ============================================================ helpers

    /// @dev Commits the withdrawals' merkle root as the sendRoot of a new pending assertion under `parent` and
    ///      points every claim at it (`blockHash` = assertion hash). Optionally registers it in the verifier.
    function _commit(Withdrawal[] memory ws, bytes32 parent, uint256 salt, bool register)
        private
        returns (Posted memory a)
    {
        a = _post(parent, ws[0].claim.sendRoot, salt);
        if (register) _register(a);
        for (uint256 i = 0; i < ws.length; ++i) {
            ws[i].claim.blockHash = a.hash;
        }
    }

    /// @dev A rival child of GENESIS carrying a different send root: puts the level into dispute.
    function _postRival() private returns (Posted memory rival) {
        rival = _post(GENESIS, RIVAL_ROOT, 99);
        _register(rival);
    }

    function _post(bytes32 parent, bytes32 sendRoot, uint256 salt) private returns (Posted memory a) {
        a.parent = parent;
        a.state = BoldAssertionState({
            globalState: BoldGlobalState({
                bytes32Vals: [keccak256(abi.encode("l2 block", salt)), sendRoot], u64Vals: [uint64(salt), uint64(0)]
            }),
            machineStatus: 1,
            endHistoryRoot: keccak256(abi.encode("history", salt))
        });
        a.inboxAcc = keccak256(abi.encode("inbox", salt));
        a.hash = boldRollup.createAssertion(parent, a.state, a.inboxAcc);
        a.createdAtBlock = boldRollup.getAssertion(a.hash).createdAtBlock;
    }

    function _postRegistered(bytes32 parent, bytes32 sendRoot, uint256 salt) private returns (Posted memory a) {
        a = _post(parent, sendRoot, salt);
        _register(a);
    }

    function _register(Posted memory a) private {
        boldVerifier.register(address(boldRollup), a.parent, a.state, a.inboxAcc);
    }

    /// @dev The ExitRecord the market builds for a pending exit backed by BOLD assertion `a`.
    function _boldRecord(Withdrawal memory w, Posted memory a) private view returns (ExitRecord memory rec) {
        rec = _record(w);
        rec.blockHash = a.hash;
        rec.deadlineBlock = a.createdAtBlock + BOLD_CONFIRM_PERIOD;
    }
}
