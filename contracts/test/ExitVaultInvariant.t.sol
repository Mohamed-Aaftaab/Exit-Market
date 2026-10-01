// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ExitClaim, ExitRecord, IExitMarket, PayoutProof} from "../interfaces/IExitMarket.sol";
import {IExitVault} from "../interfaces/IExitVault.sol";
import {ExitLeaf} from "../libraries/ExitLeaf.sol";
import {ExitVault} from "../ExitVault.sol";
import {MockExtendedGateway} from "./mocks/MockArbitrum.sol";
import {ExitFixture} from "./utils/ExitFixture.sol";

/// @dev Drives ExitVault through random interleavings of LP flows, exit sales, node resolution (confirm or
///      reject), payouts, honest re-commits, write-offs and finalization, and records the facts the invariants
///      are checked against. Every action tolerates being a no-op when its precondition does not hold, so the
///      fuzzer never wastes a call on a revert (the only tolerated reverts are the vault's fail-closed ones).
contract VaultHandler is ExitFixture {
    uint256 internal constant PRICE_UNIT = 1e12;
    uint256 internal constant ACTORS = 3;

    struct Tracked {
        Withdrawal w;
        bytes32 key;
        uint256 soldAtBlock;
        bool sold; // the vault bought it
        bool executed; // the outbox paid the vault (tokens minted), not necessarily collected yet
        bool collected;
        uint256 payIndex;
        bytes32 payRoot;
        bytes32[] payProof;
    }

    ExitVault public vault;
    address[ACTORS] internal _actors;
    Tracked[] internal _t;
    uint64 internal _nextNode = 100;
    uint256 internal _nextExit = 1;
    uint256 internal _nextIndex; // next free outbox index
    mapping(uint64 node => bytes32 root) internal _nodeRoot;
    mapping(uint64 node => uint64 deadline) internal _nodeDeadline;
    mapping(bytes32 root => uint256 openedAt) internal _rootOpenedAt; // first write-off of the root

    // -- ghost facts
    string public violation;
    uint256 public pendingPayout; // face value paid to the vault by the outbox and not yet collected
    uint256 public nSold;
    uint256 public nCapReverts;
    uint256 public nLiquidityReverts;
    uint256 public nRejectedNodes;
    uint256 public nWriteOffs;
    uint256 public nBornFinalized;
    uint256 public nFinalized;
    uint256 public nCollects;
    uint256 public nRecommits;
    uint256 public nDeposits;
    uint256 public nRedeems;
    uint256 public maxOpenSeen;

    constructor() {
        setUp();
        vault = new ExitVault(IERC20(address(usdg)), IExitMarket(address(market)), owner, "V", "V");
        rollup.setFirstUnresolvedNode(_nextNode);
        for (uint256 i; i < ACTORS; ++i) {
            _actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
        }
        _fund(_actors[0], address(vault), 300_000e6);
        vm.prank(_actors[0]);
        vault.deposit(300_000e6, _actors[0]);
    }

    // ------------------------------------------------------------------ helpers

    function _fail(string memory why) internal {
        if (bytes(violation).length == 0) violation = why;
    }

    function _price() internal view returns (uint256) {
        return vault.convertToAssets(PRICE_UNIT);
    }

    function _isRejectedNow(Tracked storage t) internal view returns (bool) {
        return market.isExitRejected(_record(t.w));
    }

    function _pick(uint256 seed, function(Tracked storage) internal view returns (bool) ok) internal view returns (bool found, uint256 idx) {
        uint256 n = _t.length;
        for (uint256 k; k < n; ++k) {
            uint256 i = (seed + k) % n;
            if (ok(_t[i])) return (true, i);
        }
    }

    /// @dev Bought, not collected and not yet written off: the vault's open set.
    function _isOpenLive(Tracked storage t) internal view returns (bool) {
        if (!t.sold || t.collected) return false;
        (,, bool wo,,) = vault.purchases(t.key);
        return !wo;
    }

    function _canExecute(Tracked storage t) internal view returns (bool) {
        return t.sold && !t.executed && outbox.roots(t.w.claim.sendRoot) != bytes32(0);
    }

    function _canRecommit(Tracked storage t) internal view returns (bool) {
        return t.sold && !t.executed && outbox.roots(t.w.claim.sendRoot) == bytes32(0) && _isRejectedNow(t);
    }

    function _canCollect(Tracked storage t) internal view returns (bool) {
        return t.executed && !t.collected;
    }

    function _isWrittenOffImpaired(Tracked storage t) internal view returns (bool) {
        if (!t.sold || t.collected) return false;
        (,, bool wo,, bool fin) = vault.purchases(t.key);
        return wo && !fin;
    }

    // ------------------------------------------------------------------ LP actions

    function deposit(uint256 actorSeed, uint256 amount) external {
        address a = _actors[actorSeed % ACTORS];
        amount = bound(amount, 1e6, 200_000e6);
        if (vault.maxDeposit(a) == 0) return;
        uint256 p0 = _price();
        _fund(a, address(vault), amount);
        vm.prank(a);
        vault.deposit(amount, a);
        if (_price() < p0) _fail("deposit lowered the share price");
        ++nDeposits;
    }

    function redeem(uint256 actorSeed, uint256 pct) external {
        address a = _actors[actorSeed % ACTORS];
        uint256 shares = (vault.maxRedeem(a) * bound(pct, 1, 100)) / 100;
        if (shares == 0) return;
        uint256 p0 = _price();
        vm.prank(a);
        vault.redeem(shares, a, a);
        if (_price() < p0) _fail("redeem lowered the share price");
        ++nRedeems;
    }

    // ------------------------------------------------------------------ exit lifecycle

    /// @dev A new node commits 1-3 exits (one send root); the seller sells them all to the vault.
    function sell(uint256 sizeSeed, uint256 amountSeed) external {
        uint256 n = bound(sizeSeed, 1, 3);
        uint256 amount = bound(amountSeed, 1e6, 60_000e6);
        uint64 node = _nextNode++;
        Withdrawal[] memory ws = _createUnique(node, _nextExit, n, amount, _nextIndex);
        _nextExit += n;
        _nextIndex += n;
        _nodeRoot[node] = ws[0].claim.sendRoot;
        _nodeDeadline[node] = rollup.getNode(node).deadlineBlock;
        for (uint256 i; i < n; ++i) {
            _t.push();
            Tracked storage t = _t[_t.length - 1];
            t.w = ws[i];
            t.key = _id(ws[i]);
            _trySell(t, ws[i]);
        }
    }

    /// @dev Like _createOn for one gateway, but the outbox index of every exit is globally unique (`base` fillers
    ///      precede them), as on a real chain: Outbox.isSpent is keyed by index only, so reusing index 0 in every
    ///      node would make every exit after the first payout look already spent.
    function _createUnique(uint64 node, uint256 firstExit, uint256 n, uint256 amount, uint256 base)
        internal
        returns (Withdrawal[] memory ws)
    {
        bytes32[] memory items = new bytes32[](base + n);
        for (uint256 i; i < base; ++i) {
            items[i] = keccak256(abi.encode("filler", node, i));
        }
        ExitClaim[] memory claims = new ExitClaim[](n);
        for (uint256 j; j < n; ++j) {
            ExitLeaf.Leaf memory leaf = ExitLeaf.Leaf({
                childGateway: gateway.counterpartGateway(),
                parentGateway: address(gateway),
                l1Token: address(usdg),
                from: seller,
                initialDestination: seller,
                amount: amount,
                exitNum: firstExit + j,
                l2Block: 1000 + base + j,
                l1Block: 500 + base + j,
                l2Timestamp: 1_700_000_000 + base + j
            });
            items[base + j] = _leafHash(leaf);
            claims[j] = ExitClaim({
                initialDestination: seller,
                l1Token: address(usdg),
                from: seller,
                amount: amount,
                l2Block: leaf.l2Block,
                l1Block: leaf.l1Block,
                l2Timestamp: leaf.l2Timestamp,
                index: base + j,
                proof: new bytes32[](0),
                sendRoot: bytes32(0),
                nodeNum: node,
                blockHash: BLOCK_HASH
            });
        }
        (bytes32 root, bytes32[][] memory proofs) = _buildTree(items);
        _publishPending(root, node);
        ws = new Withdrawal[](n);
        for (uint256 j; j < n; ++j) {
            claims[j].proof = proofs[base + j];
            claims[j].sendRoot = root;
            ws[j] = Withdrawal({gateway: address(gateway), exitNum: firstExit + j, claim: claims[j]});
        }
    }

    function _trySell(Tracked storage t, Withdrawal memory w) internal {
        uint256 p0 = _price();
        uint256 open0 = vault.openPositionCount();
        bytes memory data = _hookData(IExitMarket.Action.SELL_TO_BUYER, w.claim, abi.encode(address(vault), uint256(0)));
        vm.prank(seller);
        try MockExtendedGateway(w.gateway).transferExitAndCall(w.exitNum, seller, address(market), "", data) {
            t.sold = true;
            t.soldAtBlock = vm.getBlockNumber();
            ++nSold;
            if (vault.openPositionCount() != open0 + 1) _fail("sale did not add exactly one open position");
            if (_price() < p0) _fail("sale lowered the share price");
            if (vault.openPositionCount() > maxOpenSeen) maxOpenSeen = vault.openPositionCount();
        } catch (bytes memory reason) {
            bytes4 sel = bytes4(reason);
            if (sel == IExitVault.TooManyOpenPositions.selector) {
                ++nCapReverts;
                if (open0 != vault.MAX_OPEN_POSITIONS()) _fail("cap revert below the cap");
            } else if (sel == IExitVault.InsufficientLiquidity.selector) {
                ++nLiquidityReverts;
            } else {
                _fail("unexpected revert while selling");
            }
            if (_ownerOf(w) != seller) _fail("failed sale stranded the exit");
        }
    }

    function advance(uint256 blocks, uint256 secs) external {
        uint256 p0 = _price();
        vm.roll(vm.getBlockNumber() + bound(blocks, 1, 400));
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 5 days));
        if (_price() < p0) _fail("time alone lowered the share price");
    }

    /// @dev Resolves the oldest unresolved node: confirm (only once its deadline passed) or reject.
    function resolveNext(uint256 seed) external {
        uint64 n = rollup.firstUnresolvedNode();
        if (n >= _nextNode) return;
        uint256 p0 = _price();
        // RollupCore confirms only a child of the latest confirmed node; any other node can only be rejected.
        bool reject = seed % 3 == 0 || rollup.getNode(n).prevNum != rollup.latestConfirmed();
        if (!reject) {
            if (vm.getBlockNumber() < _nodeDeadline[n]) return;
            outbox.setRoot(_nodeRoot[n], keccak256("confirmed"));
            rollup.setLatestConfirmed(n);
        } else {
            ++nRejectedNodes;
        }
        rollup.setFirstUnresolvedNode(n + 1);
        if (reject) _rejectDoomedDescendants();
        if (!reject && _price() < p0) _fail("confirming a node lowered the share price");
    }

    /// @dev Nodes built on a rejected node are doomed and RollupCore can reject them right away; the honest chain
    ///      then resumes from the latest confirmed node.
    function _rejectDoomedDescendants() internal {
        uint64 n = rollup.firstUnresolvedNode();
        while (n < _nextNode && rollup.getNode(n).prevNum != rollup.latestConfirmed()) {
            ++nRejectedNodes;
            rollup.setFirstUnresolvedNode(++n);
        }
    }

    function execute(uint256 seed) external {
        (bool ok, uint256 i) = _pick(seed, _canExecute);
        if (!ok) return;
        Tracked storage t = _t[i];
        uint256 p0 = _price();
        _execute(t.w);
        t.executed = true;
        t.payIndex = t.w.claim.index;
        t.payRoot = t.w.claim.sendRoot;
        t.payProof = t.w.claim.proof;
        pendingPayout += t.w.claim.amount;
        if (_price() != p0) _fail("a payout to the vault moved the share price before collect");
    }

    /// @dev The honest node re-commits a rejected exit under a confirmed root and the outbox pays the vault.
    function recommit(uint256 seed) external {
        (bool ok, uint256 i) = _pick(seed, _canRecommit);
        if (!ok) return;
        Tracked storage t = _t[i];
        (bytes32 root2, bytes32[] memory proof2) = _recommitConfirmed(t.w);
        _execute(t.w);
        t.executed = true;
        t.payIndex = t.w.claim.index;
        t.payRoot = root2;
        t.payProof = proof2;
        pendingPayout += t.w.claim.amount;
        ++nRecommits;
    }

    function collect(uint256 seed) external {
        (bool ok, uint256 i) = _pick(seed, _canCollect);
        if (!ok) return;
        Tracked storage t = _t[i];
        ExitRecord memory rec = _record(t.w);
        (,, bool wo,,) = vault.purchases(t.key);
        bool fullyAccrued = !wo && !_isRejectedNow(t) && vm.getBlockNumber() >= rec.deadlineBlock;
        uint256 nav0 = vault.totalAssets();
        uint256 p0 = _price();

        vault.collect(rec, PayoutProof(t.payIndex, t.payRoot, t.payProof));

        t.collected = true;
        pendingPayout -= rec.amount;
        ++nCollects;
        if (vault.totalAssets() < nav0) _fail("collect lowered NAV");
        if (_price() < p0) _fail("collect lowered the share price");
        if (fullyAccrued && vault.totalAssets() != nav0) _fail("collect after the deadline was a NAV event");
    }

    function writeOff(uint256 seed) external {
        (bool ok, uint256 i) = _pick(seed, _isOpenLive);
        if (!ok) return;
        Tracked storage t = _t[i];
        ExitRecord memory rec = _record(t.w);
        bool rejected = market.isExitRejected(rec);
        uint256 nav0 = vault.totalAssets();
        try vault.writeOff(rec) {
            if (!rejected) _fail("wrote off an exit whose node is not rejected");
            if (vault.totalAssets() != nav0) _fail("write-off moved NAV: it should only be bookkeeping");
            ++nWriteOffs;
            _checkWindowAfterWriteOff(t);
        } catch {
            if (rejected) _fail("could not write off a rejected exit");
        }
    }

    function _checkWindowAfterWriteOff(Tracked storage t) internal {
        bytes32 root = t.w.claim.sendRoot;
        if (_rootOpenedAt[root] == 0) _rootOpenedAt[root] = vm.getBlockTimestamp();
        bool elapsed = vm.getBlockTimestamp() >= _rootOpenedAt[root] + vault.IMPAIRMENT_WINDOW();
        (,,,, bool fin) = vault.purchases(t.key);
        if (fin != elapsed) _fail("write-off finalized flag disagrees with the root's window");
        if (fin) ++nBornFinalized;
    }

    function finalize(uint256 seed) external {
        (bool ok, uint256 i) = _pick(seed, _isWrittenOffImpaired);
        if (!ok) return;
        Tracked storage t = _t[i];
        bool due = vm.getBlockTimestamp() >= _rootOpenedAt[t.w.claim.sendRoot] + vault.IMPAIRMENT_WINDOW();
        uint256 nav0 = vault.totalAssets();
        try vault.finalizeWriteOff(_record(t.w)) {
            if (!due) _fail("finalized before the root's window elapsed");
            if (vault.totalAssets() != nav0) _fail("finalize moved NAV");
            ++nFinalized;
        } catch {
            if (due) _fail("could not finalize after the root's window elapsed");
        }
    }

    // ------------------------------------------------------------------ facts for the invariants

    struct Snap {
        uint256 openCount; // purchases with a record that are not written off
        uint256 outstanding; // their cost
        uint256 impaired; // written off, record kept, not finalized
        uint256 expectedNav; // idle + independent valuation of open, non-rejected exits
        uint256 costOfLive;
        uint256 faceOfLive;
        bool anyRejectedOpen;
    }

    function snapshot() external view returns (Snap memory s) {
        s.expectedNav = vault.idleAssets();
        for (uint256 i; i < _t.length; ++i) {
            Tracked storage t = _t[i];
            if (!t.sold || t.collected) continue;
            (bytes32 h, uint256 cost, bool wo,, bool fin) = vault.purchases(t.key);
            if (h == bytes32(0)) continue;
            if (wo) {
                if (!fin) ++s.impaired;
                continue;
            }
            ++s.openCount;
            s.outstanding += cost;
            if (_isRejectedNow(t)) {
                s.anyRejectedOpen = true;
                continue;
            }
            uint256 face = t.w.claim.amount;
            s.costOfLive += cost;
            s.faceOfLive += face;
            s.expectedNav += _linearValue(cost, face, t.soldAtBlock, _record(t.w).deadlineBlock);
        }
    }

    /// @dev Independent restatement of the accrual rule (not the library): cost + discount * elapsed / span.
    function _linearValue(uint256 cost, uint256 face, uint256 start, uint256 end) internal view returns (uint256) {
        if (vm.getBlockNumber() >= end) return face;
        if (vm.getBlockNumber() <= start) return cost;
        return cost + ((face - cost) * (vm.getBlockNumber() - start)) / (end - start);
    }

    function actor(uint256 i) external view returns (address) {
        return _actors[i];
    }

    /// @dev Everything the handler deployed besides itself: the fuzzer must only reach them through the handler.
    function world() external view returns (address[] memory a) {
        a = new address[](9);
        a[0] = address(usdg);
        a[1] = address(outbox);
        a[2] = address(rollup);
        a[3] = address(bridge);
        a[4] = address(inbox);
        a[5] = address(gateway);
        a[6] = address(market);
        a[7] = address(verifier);
        a[8] = address(vault);
    }
}

contract ExitVaultInvariantTest is StdInvariant, Test {
    VaultHandler internal h;
    ExitVault internal vault;

    function setUp() public {
        h = new VaultHandler();
        vault = h.vault();
        address[] memory world = h.world();
        for (uint256 i; i < world.length; ++i) {
            excludeContract(world[i]);
        }
        // `sell` appears several times: repeated selectors weight the fuzzer's choice, and the 32-position cap
        // is only reachable with plenty of sales.
        bytes4[] memory sel = new bytes4[](13);
        sel[0] = VaultHandler.deposit.selector;
        sel[1] = VaultHandler.redeem.selector;
        sel[2] = VaultHandler.sell.selector;
        sel[3] = VaultHandler.sell.selector;
        sel[4] = VaultHandler.sell.selector;
        sel[5] = VaultHandler.sell.selector;
        sel[6] = VaultHandler.advance.selector;
        sel[7] = VaultHandler.resolveNext.selector;
        sel[8] = VaultHandler.execute.selector;
        sel[9] = VaultHandler.recommit.selector;
        sel[10] = VaultHandler.collect.selector;
        sel[11] = VaultHandler.writeOff.selector;
        sel[12] = VaultHandler.finalize.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_noRuleViolatedByAnyAction() public view {
        assertEq(h.violation(), "", "a per-action rule was broken");
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_idlePlusUncollectedPayoutsIsTheRealBalance() public view {
        assertEq(vault.idleAssets() + h.pendingPayout(), IERC20(vault.asset()).balanceOf(address(vault)));
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_openSetOutstandingAndImpairedCountersMatchTheRecords() public view {
        VaultHandler.Snap memory s = h.snapshot();
        assertEq(vault.openPositionCount(), s.openCount, "open set == records that are not written off");
        assertLe(vault.openPositionCount(), vault.MAX_OPEN_POSITIONS());
        assertEq(vault.outstandingCost(), s.outstanding);
        assertEq(vault.impairedExits(), s.impaired);
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_navIsIdlePlusAccruedNonRejectedExitsWithinCostAndFace() public view {
        VaultHandler.Snap memory s = h.snapshot();
        uint256 nav = vault.totalAssets();
        assertEq(nav, s.expectedNav, "NAV matches the independent valuation");
        assertGe(nav, vault.idleAssets() + s.costOfLive, "never below idle + cost of the live exits");
        assertLe(nav, vault.idleAssets() + s.faceOfLive, "never above idle + face of the live exits");
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_depositsArePausedExactlyWhileAnythingIsRejectedOrImpaired() public view {
        VaultHandler.Snap memory s = h.snapshot();
        bool paused = s.anyRejectedOpen || s.impaired > 0;
        address a = h.actor(1);
        assertEq(vault.maxDeposit(a) == 0, paused);
        assertEq(vault.maxMint(a) == 0, paused);
    }

    function afterInvariant() public {
        emit log_named_uint("sold", h.nSold());
        emit log_named_uint("cap reverts", h.nCapReverts());
        emit log_named_uint("max open seen", h.maxOpenSeen());
        emit log_named_uint("rejected nodes", h.nRejectedNodes());
        emit log_named_uint("write-offs", h.nWriteOffs());
        emit log_named_uint("born finalized", h.nBornFinalized());
        emit log_named_uint("finalized", h.nFinalized());
        emit log_named_uint("recommits", h.nRecommits());
        emit log_named_uint("collects", h.nCollects());
        emit log_named_uint("deposits", h.nDeposits());
        emit log_named_uint("redeems", h.nRedeems());
    }
}
