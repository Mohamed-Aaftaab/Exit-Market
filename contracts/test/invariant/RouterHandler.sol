// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ExitClaim, ExitRecord, PayoutProof} from "../../interfaces/IExitMarket.sol";
import {IExitIntentRouter} from "../../interfaces/IExitIntentRouter.sol";
import {ExitIntentRouter} from "../../ExitIntentRouter.sol";
import {ExitMarket} from "../../ExitMarket.sol";
import {ExitVault} from "../../ExitVault.sol";
import {MockERC20, MockExtendedGateway, MockLegacyRollup, MockOutbox} from "../mocks/MockArbitrum.sol";

/// @dev Random gasless-exit traffic against the real ExitIntentRouter, ExitMarket and ExitVault on the mock
///      gateway stack: relayers settle signed orders (the router only accepts the vault as buyer and market-
///      allowed gateways), the vault owner retunes pricing and limits, users reclaim, the Outbox executes
///      exits (paying whoever owns them), anyone recovers proceeds that landed in the router, and strangers
///      donate tokens to it.
///
///      Every settlement is checked against balances measured independently before and after: the router
///      ends where it started, the market keeps exactly floor(paid x feeBps), and seller + relayer receive
///      exactly what the vault paid minus that fee. Failed or hostile calls (bad signature, expired order,
///      foreign buyer or gateway, seller minimum not met, vault refusing the exit, replay, reclaim after
///      execution, double or premature recovery) must revert atomically with the exit still owned by the
///      router. Deviations are recorded in `violations`, never reverted, so that the fuzzer cannot silently
///      discard them.
contract RouterHandler is Test {
    uint256 internal constant NONE = type(uint256).max;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant RECLAIM_GRACE = 3 days;
    uint256 internal constant ATTACKER_PK = 0xBAD;
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "SellOrder(address gateway,uint256 exitNum,address buyer,uint256 minProceeds,uint256 relayerFee,uint64 deadline)"
    );

    /// @dev Everything the handler needs, packed to keep the constructor off the stack limit.
    struct Wiring {
        ExitMarket market;
        ExitIntentRouter router;
        ExitVault vault;
        MockExtendedGateway gateway;
        MockOutbox outbox;
        MockLegacyRollup rollup;
        MockERC20 usdg;
        address vaultOwner;
        address stranger;
        uint256[] userKeys;
        address[] relayers;
        address[] extraHolders;
        bytes[] claims;
    }

    /// @dev A settlement the handler is about to attempt, with its predicted outcome.
    struct Run {
        uint256 i;
        address seller;
        address relayer;
        uint256 relayerFee;
        uint256 minProceeds;
        bool expectOk; // the settlement should succeed
        bool refused; // the vault or market will refuse it whatever the seller's minimum is
    }

    /// @dev Balances measured before a call.
    struct Snap {
        uint256 router;
        uint256 seller;
        uint256 relayer;
        uint256 market;
        uint256 fees;
        uint256 buyer;
    }

    uint256 public immutable exits;
    ExitMarket public immutable market;
    ExitIntentRouter public immutable router;
    ExitVault public immutable vault;
    MockExtendedGateway public immutable gateway;
    MockOutbox public immutable outbox;
    MockLegacyRollup public immutable rollup;
    MockERC20 public immutable usdg;
    address public immutable vaultOwner;
    address public immutable stranger;

    uint256[] internal _keys;
    address[] internal _users;
    address[] internal _relayers;
    bytes[] internal _claims; // abi.encode(ExitClaim) per exit; exitNum = index + 1

    // ------------------------------------------------------------ independent model
    mapping(uint256 => address) public ownerModel;
    mapping(uint256 => bool) public executed;
    mapping(uint256 => bool) public recovered;
    mapping(uint256 => bool) public settled;
    mapping(uint256 => bytes) internal _orderBlob; // abi.encode(SellOrder) of the settled order
    mapping(uint256 => bytes) internal _sigOf;
    address[] internal _holders;
    mapping(address => bool) internal _isHolder;

    uint256 public stranded; // executed router-owned payouts not yet recovered
    uint256 public donated;
    uint256 public minted;
    uint256 public buyersPaid;
    uint256 public toSellers;
    uint256 public toRelayers;
    uint256 public marketFees;

    uint256 public violations;
    string public firstViolation;
    mapping(string => uint256) public hits;

    constructor(Wiring memory w) {
        market = w.market;
        router = w.router;
        vault = w.vault;
        gateway = w.gateway;
        outbox = w.outbox;
        rollup = w.rollup;
        usdg = w.usdg;
        vaultOwner = w.vaultOwner;
        stranger = w.stranger;
        _keys = w.userKeys;
        _relayers = w.relayers;
        exits = w.claims.length;
        for (uint256 i = 0; i < w.userKeys.length; ++i) {
            _users.push(vm.addr(w.userKeys[i]));
            _track(vm.addr(w.userKeys[i]));
        }
        for (uint256 i = 0; i < w.claims.length; ++i) {
            _claims.push(w.claims[i]);
            ownerModel[i] = address(w.router);
        }
        for (uint256 i = 0; i < w.relayers.length; ++i) _track(w.relayers[i]);
        for (uint256 i = 0; i < w.extraHolders.length; ++i) _track(w.extraHolders[i]);
        _track(address(w.router));
        _track(address(w.market));
        _track(address(w.vault));
        _track(w.stranger);
        _track(w.market.feeRecipient());
    }

    // ================================================================ views for the invariants

    function claimAt(uint256 i) public view returns (ExitClaim memory) {
        return abi.decode(_claims[i], (ExitClaim));
    }

    function ownerOf(uint256 i) public view returns (address o) {
        (o,) = gateway.getExternalCall(i + 1, address(router), "");
    }

    function holders() external view returns (address[] memory) {
        return _holders;
    }

    // ================================================================ legal actions

    function settleOrder(uint256 seed, uint256 feeSeed, uint256 minSeed) external {
        uint256 i = _pickUnspentRouterOwned(seed);
        if (i == NONE) return _hit("settle:skipped");
        Run memory r;
        r.i = i;
        r.seller = claimAt(i).from;
        r.relayer = _relayers[uint256(keccak256(abi.encode(seed, "relayer"))) % _relayers.length];
        uint256 amount = claimAt(i).amount;
        // Mostly a small or zero relayer fee; sometimes one so large the seller's proceeds cannot cover it.
        r.relayerFee = feeSeed % 4 == 0 ? 0 : feeSeed % 8 == 1 ? _clamp(feeSeed / 8, 1, amount * 2) : _clamp(feeSeed, 1, 20e6);
        _plan(r, minSeed);
        _runSettle(r, seed);
    }

    /// @dev Reclaim is offered for every router-owned exit, executed or not: after execution it must revert
    ///      (the payout sits in the router and only recoverExecuted may release it).
    function reclaim(uint256 seed, uint256 mode) external {
        if (!_gate(seed, 3)) return _hit("reclaim:gated");
        uint256 i = NONE;
        for (uint256 k = 0; k < exits; ++k) {
            uint256 j = (seed + k) % exits;
            if (ownerModel[j] == address(router)) {
                i = j;
                break;
            }
        }
        if (i == NONE) return _hit("reclaim:skipped");
        ExitClaim memory c = claimAt(i);
        uint256 unlock = c.l2Timestamp + RECLAIM_GRACE;
        mode = mode % 3;
        if (mode == 2 && block.timestamp < unlock) vm.warp(unlock);
        address caller = mode == 0 ? c.from : stranger;
        bytes memory callData = abi.encodeCall(router.reclaim, (address(gateway), i + 1, c));

        if (caller != c.from && block.timestamp < unlock) {
            _mustRevert(caller, address(router), callData, IExitIntentRouter.ReclaimLocked.selector, "reclaim:locked");
            return _sync();
        }
        if (executed[i]) {
            _mustRevert(caller, address(router), callData, IExitIntentRouter.ExitAlreadySpent.selector, "reclaim:executed");
            return _sync();
        }

        uint256 routerBefore = usdg.balanceOf(address(router));
        vm.prank(caller);
        try router.reclaim(address(gateway), i + 1, c) {}
        catch (bytes memory err) {
            return _unexpected("reclaim", err);
        }
        if (usdg.balanceOf(address(router)) != routerBefore) _violate("reclaim moved payment tokens");
        ownerModel[i] = c.from;
        _sync();
        _hit(caller == c.from ? "reclaim:bySeller" : "reclaim:byAnyoneAfterGrace");
    }

    /// @dev The Outbox executes an exit: its root becomes confirmed and the current owner is paid.
    function execute(uint256 seed) external {
        if (!_gate(seed, 4)) return _hit("execute:gated");
        uint256 i = NONE;
        for (uint256 k = 0; k < exits; ++k) {
            uint256 j = (seed + k) % exits;
            bool preferred = seed % 2 == 1 || ownerModel[j] == address(router);
            if (!executed[j] && preferred) {
                i = j;
                break;
            }
        }
        if (i == NONE) return _hit("execute:skipped");
        ExitClaim memory c = claimAt(i);
        address payee = ownerModel[i];

        outbox.setRoot(c.sendRoot, keccak256("confirmed"));
        gateway.simulateExecute(outbox, c.index, i + 1, c.initialDestination, usdg, c.amount);
        executed[i] = true;
        minted += c.amount;
        _track(payee);
        if (payee == address(router)) stranded += c.amount;
        _sync();
        _hit(payee == address(router) ? "execute:paidRouter" : "execute:paidOther");
    }

    /// @dev Anyone forwards the payout of an executed, still router-owned exit to its proven sender.
    function recover(uint256 seed, uint256 callerSeed) external {
        uint256 i = NONE;
        for (uint256 k = 0; k < exits; ++k) {
            uint256 j = (seed + k) % exits;
            if (ownerModel[j] == address(router) && executed[j] && !recovered[j]) {
                i = j;
                break;
            }
        }
        if (i == NONE) return _hit("recover:skipped");
        ExitClaim memory c = claimAt(i);
        address caller = callerSeed % 2 == 0 ? stranger : c.from;
        Snap memory pre = _snap(c.from, caller, address(0));

        vm.prank(caller);
        try router.recoverExecuted(address(gateway), i + 1, c, PayoutProof(c.index, c.sendRoot, c.proof)) {}
        catch (bytes memory err) {
            return _unexpected("recover", err);
        }
        if (usdg.balanceOf(address(router)) != _sub(pre.router, c.amount)) _violate("router balance after recover");
        if (caller != c.from && usdg.balanceOf(caller) != pre.relayer) _violate("recover paid the caller");
        if (usdg.balanceOf(c.from) != pre.seller + c.amount) _violate("recover did not pay exactly the exit amount");
        recovered[i] = true;
        stranded -= c.amount;
        _sync();
        _hit("recover");
    }

    /// @dev Unsolicited payment-token transfer into the router.
    function donate(uint256 amountSeed) external {
        if (!_gate(amountSeed, 3)) return _hit("donate:gated");
        uint256 amount = _clamp(amountSeed, 1, 1e12);
        usdg.mint(address(router), amount);
        minted += amount;
        donated += amount;
        _hit("donate");
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + _clamp(secs, 1, 2 days));
        _hit("warp");
    }

    /// @dev The vault owner retunes pricing and limits: discounts move, and the vault may start refusing exits
    ///      (too large, or still pending). Settlements must stay conservative either way.
    function setVaultParams(uint256 seed) external {
        uint16 baseFee = uint16(_clamp(seed, 0, 500));
        uint16 apr = uint16(_clamp(uint256(keccak256(abi.encode(seed, "apr"))), 0, 5_000));
        uint256 maxExit = uint256(keccak256(abi.encode(seed, "max"))) % 4 == 0 ? 1_500e6 : type(uint256).max;
        bool acceptPending = uint256(keccak256(abi.encode(seed, "pending"))) % 5 != 0;
        vm.prank(vaultOwner);
        try vault.setParams(baseFee, apr, maxExit, acceptPending) {}
        catch (bytes memory err) {
            return _unexpected("setVaultParams", err);
        }
        _hit("setVaultParams");
    }

    // ================================================================ hostile actions (must revert atomically)

    function hostileSettle(uint256 seed, uint256 kind) external {
        uint256 i = _pickUnspentRouterOwned(seed);
        if (i == NONE) return _hit("hostileSettle:skipped");
        ExitClaim memory c = claimAt(i);
        IExitIntentRouter.SellOrder memory o = IExitIntentRouter.SellOrder({
            gateway: address(gateway),
            exitNum: i + 1,
            buyer: address(vault),
            minProceeds: 0,
            relayerFee: 1e6,
            deadline: uint64(block.timestamp + 1 hours)
        });
        bytes memory sig;
        bytes4 sel;
        kind = kind % 5;
        if (kind == 0) {
            sig = _sign(ATTACKER_PK, o); // not the exit's sender
            sel = IExitIntentRouter.BadSignature.selector;
        } else if (kind == 1) {
            sig = _sign(_keyOf(c.from), o);
            o.relayerFee += 1e6; // relayer inflates its own fee after signing
            sel = IExitIntentRouter.BadSignature.selector;
        } else if (kind == 2) {
            o.deadline = uint64(block.timestamp - 1);
            sig = _sign(_keyOf(c.from), o);
            sel = IExitIntentRouter.OrderExpired.selector;
        } else if (kind == 3) {
            o.buyer = stranger; // validly signed, but not the router's bound buyer
            sig = _sign(_keyOf(c.from), o);
            sel = IExitIntentRouter.BuyerNotAllowed.selector;
        } else {
            o.gateway = stranger; // validly signed, but not a market-allowed gateway
            sig = _sign(_keyOf(c.from), o);
            sel = IExitIntentRouter.GatewayNotAllowed.selector;
        }
        Snap memory pre = _snap(c.from, _relayers[0], address(vault));
        _mustRevert(_relayers[0], address(router), abi.encodeCall(router.settle, (c, o, sig)), sel, "hostile:settle");
        _checkUnchanged(i, c.from, _relayers[0], address(vault), pre);
    }

    /// @dev A settled order is replayed by a relayer: the exit is gone, so it must revert and pay nobody.
    function hostileReplay(uint256 seed) external {
        uint256 i = NONE;
        for (uint256 k = 0; k < exits; ++k) {
            uint256 j = (seed + k) % exits;
            if (settled[j]) {
                i = j;
                break;
            }
        }
        if (i == NONE) return _hit("hostileReplay:skipped");
        ExitClaim memory c = claimAt(i);
        IExitIntentRouter.SellOrder memory o = abi.decode(_orderBlob[i], (IExitIntentRouter.SellOrder));
        Snap memory pre = _snap(c.from, _relayers[0], o.buyer);

        vm.prank(_relayers[0]);
        (bool ok,) = address(router).call(abi.encodeCall(router.settle, (c, o, _sigOf[i])));
        if (ok) _violate("replayed order was settled twice");
        _checkUnchanged(NONE, c.from, _relayers[0], o.buyer, pre);
        _sync();
        _hit("hostile:replay");
    }

    function hostileRecover(uint256 seed, uint256 kind) external {
        kind = kind % 3;
        uint256 i = NONE;
        for (uint256 k = 0; k < exits; ++k) {
            uint256 j = (seed + k) % exits;
            bool routerOwns = ownerModel[j] == address(router);
            if (
                (kind == 0 && recovered[j]) || (kind == 1 && routerOwns && !executed[j])
                    || (kind == 2 && !routerOwns && executed[j])
            ) {
                i = j;
                break;
            }
        }
        if (i == NONE) return _hit("hostileRecover:skipped");
        ExitClaim memory c = claimAt(i);
        // 0: second recovery, 1: exit not executed yet, 2: exit no longer owned by the router
        bytes4 sel = kind == 0
            ? IExitIntentRouter.AlreadyRecovered.selector
            : kind == 1 ? IExitIntentRouter.ExitNotPaidOut.selector : IExitIntentRouter.NotRouterExit.selector;
        Snap memory pre = _snap(c.from, stranger, address(0));
        _mustRevert(
            stranger,
            address(router),
            abi.encodeCall(router.recoverExecuted, (address(gateway), i + 1, c, PayoutProof(c.index, c.sendRoot, c.proof))),
            sel,
            "hostile:recover"
        );
        _checkUnchanged(NONE, c.from, stranger, address(0), pre);
    }

    // ================================================================ settlement internals

    /// @dev Predicts the outcome from the vault's public quote(), built for the record the market will hand
    ///      it: pending against the unresolved node (deadline from the rollup) or, once any exit of the tree
    ///      was executed, confirmed (no time discount). The seller's minimum then sits on the boundary
    ///      (succeeds), one above it (must revert ProceedsBelowMin), below it, or at zero.
    function _plan(Run memory r, uint256 minSeed) internal view {
        ExitClaim memory c = claimAt(r.i);
        bool confirmed = outbox.roots(c.sendRoot) != bytes32(0);
        ExitRecord memory rec;
        rec.l1Token = c.l1Token;
        rec.amount = c.amount;
        rec.pending = !confirmed;
        rec.deadlineBlock = confirmed ? 0 : rollup.getNode(c.nodeNum).deadlineBlock;

        uint256 price = vault.quote(rec);
        r.refused = price == 0 || price > vault.idleAssets() || c.amount > vault.maxExitAmount()
            || (rec.pending && !vault.acceptPending());
        uint256 received = price - (price * market.feeBps()) / BPS;
        uint256 headroom = received >= r.relayerFee ? received - r.relayerFee : 0;
        uint256 mode = minSeed % 4;
        r.minProceeds = mode == 0 ? headroom : mode == 1 ? headroom + 1 : mode == 2 ? _clamp(minSeed, 0, headroom) : 0;
        r.expectOk = !r.refused && received >= r.minProceeds + r.relayerFee;
    }

    function _runSettle(Run memory r, uint256 ttlSeed) internal {
        ExitClaim memory c = claimAt(r.i);
        IExitIntentRouter.SellOrder memory o = IExitIntentRouter.SellOrder({
            gateway: address(gateway),
            exitNum: r.i + 1,
            buyer: address(vault),
            minProceeds: r.minProceeds,
            relayerFee: r.relayerFee,
            deadline: uint64(block.timestamp + _clamp(ttlSeed, 1 hours, 2 days))
        });
        bytes memory sig = _sign(_keyOf(r.seller), o);
        Snap memory pre = _snap(r.seller, r.relayer, address(vault));

        vm.prank(r.relayer);
        try router.settle(c, o, sig) returns (uint256 proceeds) {
            if (!r.expectOk) return _violate("settle succeeded although the vault refuses it or proceeds are below the minimum");
            _checkSettled(r, pre, proceeds);
            settled[r.i] = true;
            ownerModel[r.i] = address(vault);
            _orderBlob[r.i] = abi.encode(o);
            _sigOf[r.i] = sig;
            _sync();
            _hit("settle");
        } catch (bytes memory err) {
            if (r.expectOk) return _unexpected("settle", err);
            if (!r.refused && bytes4(err) != IExitIntentRouter.ProceedsBelowMin.selector) {
                return _violate("wrong error for proceeds below the seller's minimum");
            }
            _checkUnchanged(r.i, r.seller, r.relayer, address(vault), pre);
            _hit(r.refused ? "settle:vaultRefused" : "settle:belowMin");
        }
    }

    /// @dev The four numbers the seller cares about, from balances measured around the call.
    function _checkSettled(Run memory r, Snap memory pre, uint256 proceeds) internal {
        uint256 paid = _sub(pre.buyer, usdg.balanceOf(address(vault))); // what the buyer actually handed over
        uint256 fee = (paid * market.feeBps()) / BPS;
        uint256 received = paid - fee; // what the market forwarded to the router

        if (paid == 0) _violate("settle succeeded with a zero payment");
        if (usdg.balanceOf(address(router)) != pre.router) _violate("router balance changed across settle");
        if (_sub(market.accruedFees(), pre.fees) != fee) _violate("market fee != floor(paid x bps)");
        if (_sub(usdg.balanceOf(address(market)), pre.market) != fee) _violate("market kept more than its fee");
        if (proceeds != _sub(received, r.relayerFee)) _violate("returned proceeds != received - relayerFee");
        uint256 sellerGot = _sub(usdg.balanceOf(r.seller), pre.seller);
        if (r.seller == r.relayer) {
            if (sellerGot != received) _violate("seller-relayer did not receive the full amount");
        } else {
            if (sellerGot != _sub(received, r.relayerFee)) _violate("seller did not receive received - relayerFee");
            if (_sub(usdg.balanceOf(r.relayer), pre.relayer) != r.relayerFee) _violate("relayer did not receive relayerFee");
        }

        buyersPaid += paid;
        marketFees += fee;
        toSellers += _sub(received, r.relayerFee);
        toRelayers += r.relayerFee;
    }

    /// @dev A call that reverted changed nothing: every balance is as before and (if given) the exit is still the router's.
    function _checkUnchanged(uint256 i, address seller, address relayer_, address buyer_, Snap memory pre) internal {
        Snap memory now_ = _snap(seller, relayer_, buyer_);
        if (
            now_.router != pre.router || now_.seller != pre.seller || now_.relayer != pre.relayer
                || now_.market != pre.market || now_.fees != pre.fees || now_.buyer != pre.buyer
        ) _violate("a reverted call changed balances");
        if (i != NONE && ownerOf(i) != address(router)) _violate("a reverted call moved the exit");
        _sync();
    }

    function _snap(address seller, address relayer_, address buyer_) internal view returns (Snap memory s) {
        s.router = usdg.balanceOf(address(router));
        s.seller = usdg.balanceOf(seller);
        s.relayer = usdg.balanceOf(relayer_);
        s.market = usdg.balanceOf(address(market));
        s.fees = market.accruedFees();
        s.buyer = buyer_ == address(0) ? 0 : usdg.balanceOf(buyer_);
    }

    // ================================================================ plumbing

    /// @dev Runs after every state-changing action: the gateway's owner of every exit is the model's owner.
    function _sync() internal {
        for (uint256 i = 0; i < exits; ++i) {
            if (ownerOf(i) != ownerModel[i]) _violate("gateway owner differs from the model owner");
        }
    }

    function _mustRevert(address caller, address target, bytes memory callData, bytes4 sel, string memory name) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) = target.call(callData);
        if (ok) _violate(string.concat(name, " succeeded but must revert"));
        else if (bytes4(ret) != sel) _violate(string.concat(name, " reverted with the wrong error"));
        else _hit(name);
    }

    /// @dev Exit still owned by the router and not yet executed: it can be settled or reclaimed.
    function _pickUnspentRouterOwned(uint256 seed) internal view returns (uint256) {
        for (uint256 k = 0; k < exits; ++k) {
            uint256 i = (seed + k) % exits;
            if (ownerModel[i] == address(router) && !executed[i]) return i;
        }
        return NONE;
    }

    function _keyOf(address user) internal view returns (uint256) {
        for (uint256 i = 0; i < _users.length; ++i) {
            if (_users[i] == user) return _keys[i];
        }
        revert("unknown user");
    }

    /// @dev EIP-712 digest computed here, independently of the router's own orderDigest().
    function _digest(IExitIntentRouter.SellOrder memory o) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("ExitIntentRouter"), keccak256("1"), block.chainid, address(router))
        );
        bytes32 structHash = keccak256(
            abi.encode(ORDER_TYPEHASH, o.gateway, o.exitNum, o.buyer, o.minProceeds, o.relayerFee, o.deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(uint256 pk, IExitIntentRouter.SellOrder memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(o));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Maps `x` into [lo, hi] by modulo. Local replacement for forge-std's bound(), which logs a line on
    ///      every call and would flood the output of the walk tests.
    function _clamp(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        require(lo <= hi, "clamp: empty range");
        if (hi - lo == type(uint256).max) return x;
        return lo + (x % (hi - lo + 1));
    }

    /// @dev True for roughly 1 in `n` seeds. Uses high bits so it is independent of `seed % exits`.
    function _gate(uint256 seed, uint256 n) internal pure returns (bool) {
        return (seed >> 128) % n == 0;
    }

    /// @dev a - b, flagging a violation instead of reverting (a revert here would be discarded by the fuzzer).
    function _sub(uint256 a, uint256 b) internal returns (uint256) {
        if (a < b) {
            _violate("balance moved the wrong way");
            return 0;
        }
        return a - b;
    }

    function _track(address who) internal {
        if (_isHolder[who]) return;
        _isHolder[who] = true;
        _holders.push(who);
    }

    function _hit(string memory name) internal {
        ++hits[name];
    }

    function _violate(string memory why) internal {
        if (violations++ == 0) firstViolation = why;
    }

    function _unexpected(string memory what, bytes memory err) internal {
        _violate(string.concat(what, " reverted unexpectedly, selector ", vm.toString(bytes32(bytes4(err)))));
    }
}
