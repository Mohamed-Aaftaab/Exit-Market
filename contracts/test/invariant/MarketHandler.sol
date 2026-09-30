// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ExitClaim, IExitMarket, PayoutProof} from "../../interfaces/IExitMarket.sol";
import {ExitMarket} from "../../ExitMarket.sol";
import {MockERC20, MockExtendedGateway, MockOutbox} from "../mocks/MockArbitrum.sol";
import {TestBuyer} from "../utils/TestBuyers.sol";

/// @dev Random call sequences against a real ExitMarket + mock Arbitrum gateway stack, checked against an
///      independent model (shadow owner, token ledger, fee ledger, status machine).
///
///      Legal actions: list, buy, cancel (by seller / by anyone after expiry), settle, Outbox execution,
///      instant sale to an IExitBuyer, fee withdrawal, fee changes, direct exit transfers, time travel.
///      Hostile actions (must revert and change nothing): buy/cancel/settle a non-listed exit, list or sell a
///      spent exit, buy an expired listing, re-list an exit the market already owns, fee above the cap, fee
///      change by a stranger, an instant sale whose payout is below the seller's minimum or zero.
///      Unsolicited actions: token donations to the market and exits redirected to it WITHOUT hook data
///      (user error that strands the exit's payout in the market; it must never be mistaken for fees/escrow).
///
///      A handler call never reverts on its own: an unexpected revert of a legal action, a hostile action
///      that succeeds, or any model divergence is recorded in `violations` and asserted by the invariants.
contract MarketHandler is Test {
    uint256 internal constant NONE = type(uint256).max;
    uint256 internal constant BPS = 10_000;
    bytes4 internal constant ERROR_STRING = 0x08c379a0;

    uint256 public immutable exits;
    ExitMarket public immutable market;
    MockExtendedGateway public immutable gateway;
    MockOutbox public immutable outbox;
    MockERC20 public immutable usdg;
    MockERC20 public immutable other;
    address public immutable marketOwner;
    address public immutable stranger;

    address[] internal _traders; // EOAs that can own an exit, buy and fund
    address[2] internal _recipients;
    address[] internal _dest; // initialDestination per exit
    bytes[] internal _claims; // abi.encode(ExitClaim) per exit; exitNum = index + 1

    // ------------------------------------------------------------ independent model
    mapping(uint256 => address) public shadowOwner;
    mapping(uint256 => bool) public executed;
    mapping(uint256 => bool) public misdirected; // sent to the market with no hook: never listed, never released
    mapping(uint256 => IExitMarket.Status) internal _lastStatus;
    mapping(uint256 => uint16) public snapFee;
    mapping(uint256 => uint256) public termsPrice;
    mapping(uint256 => uint64) public termsExpiry;
    mapping(uint256 => address) public termsSeller;
    mapping(address token => mapping(address who => uint256)) public ledger;
    mapping(address token => uint256) public unsolicited;
    mapping(address token => uint256) public minted;
    address[] internal _holders;
    mapping(address => bool) internal _isHolder;

    uint16 public modelFeeBps;
    address public modelRecipient;
    uint256 public accrued;
    uint256 public earned;
    uint256 public withdrawn;

    uint256 public violations;
    string public firstViolation;
    mapping(string => uint256) public hits;

    /// @dev Everything the handler needs, packed to keep the constructor readable and off the stack limit.
    struct Wiring {
        ExitMarket market;
        MockExtendedGateway gateway;
        MockOutbox outbox;
        MockERC20 usdg;
        MockERC20 other;
        address marketOwner;
        address stranger;
        address[] traders;
        address[2] recipients;
        address[] dest;
        bytes[] claims;
    }

    constructor(Wiring memory w) {
        market = w.market;
        gateway = w.gateway;
        outbox = w.outbox;
        usdg = w.usdg;
        other = w.other;
        marketOwner = w.marketOwner;
        stranger = w.stranger;
        _traders = w.traders;
        _recipients = w.recipients;
        _dest = w.dest;
        exits = w.claims.length;
        for (uint256 i = 0; i < w.claims.length; ++i) {
            _claims.push(w.claims[i]);
            shadowOwner[i] = w.dest[i];
        }
        modelFeeBps = w.market.feeBps();
        modelRecipient = w.market.feeRecipient();
        for (uint256 i = 0; i < w.traders.length; ++i) _track(w.traders[i]);
        _track(address(w.market));
        _track(w.recipients[0]);
        _track(w.recipients[1]);
        _track(w.stranger);
    }

    // ================================================================ views for the invariants

    function claimAt(uint256 i) public view returns (ExitClaim memory) {
        return abi.decode(_claims[i], (ExitClaim));
    }

    function idOf(uint256 i) public view returns (bytes32) {
        return market.listingId(address(gateway), i + 1, _dest[i]);
    }

    function ownerOf(uint256 i) public view returns (address o) {
        (o,) = gateway.getExternalCall(i + 1, _dest[i], "");
    }

    function holders() external view returns (address[] memory) {
        return _holders;
    }

    function recipients() external view returns (address[2] memory) {
        return _recipients;
    }

    // ================================================================ legal actions

    function list(uint256 seed, uint256 priceSeed, uint256 ttlSeed) external {
        uint256 i = _pickIdle(seed);
        if (i == NONE) return _hit("list:skipped");
        ExitClaim memory c = claimAt(i);
        address seller = shadowOwner[i];
        uint256 price = _clamp(priceSeed, 1, c.amount * 2);
        uint64 expiry = uint64(block.timestamp + _clamp(ttlSeed, 1 hours, 3 days));
        uint16 feeNow = modelFeeBps;
        bytes memory data = abi.encode(IExitMarket.Action.LIST, c, abi.encode(price, expiry));

        vm.prank(seller);
        try gateway.transferExitAndCall(i + 1, c.initialDestination, address(market), "", data) {}
        catch (bytes memory err) {
            return _unexpected("list", err);
        }

        shadowOwner[i] = address(market);
        snapFee[i] = feeNow;
        termsPrice[i] = price;
        termsExpiry[i] = expiry;
        termsSeller[i] = seller;
        _expectStatus(i, IExitMarket.Status.Listed);
        _sync(i);
        _hit("list");
    }

    function buy(uint256 seed, uint256 buyerSeed, uint256 slackSeed) external {
        uint256 i = _pickListed(seed);
        if (i == NONE) return _hit("buy:skipped");
        bytes32 id = idOf(i);
        address b = _traders[buyerSeed % _traders.length];
        uint256 price = termsPrice[i];
        uint256 maxPrice = price + _clamp(slackSeed, 0, 1e6);
        _mint(usdg, b, price);

        bytes memory callData = abi.encodeCall(market.buy, (id, maxPrice));
        if (block.timestamp > termsExpiry[i]) {
            _mustRevert(b, address(market), callData, IExitMarket.ListingExpired.selector, "buy:expired");
            return _sync(NONE);
        }
        if (executed[i]) {
            _mustRevert(b, address(market), callData, IExitMarket.ExitAlreadySpent.selector, "buy:spent");
            return _sync(NONE);
        }

        vm.prank(b);
        try market.buy(id, maxPrice) {}
        catch (bytes memory err) {
            return _unexpected("buy", err);
        }

        // Fee uses the bps snapshotted when the listing was created, whatever setFee did since.
        uint256 fee = (price * snapFee[i]) / BPS;
        address seller = termsSeller[i];
        _debit(address(usdg), b, price);
        _credit(address(usdg), seller, price - fee);
        _credit(address(usdg), address(market), fee);
        accrued += fee;
        earned += fee;
        shadowOwner[i] = b;
        _expectStatus(i, IExitMarket.Status.Sold);
        _sync(i);
        _hit("buy");
    }

    function cancel(uint256 seed, uint256 mode) external {
        uint256 i = _pickListed(seed);
        if (i == NONE) return _hit("cancel:skipped");
        bytes32 id = idOf(i);
        address seller = termsSeller[i];
        mode = mode % 3;
        if (mode == 2 && block.timestamp <= termsExpiry[i]) vm.warp(termsExpiry[i] + 1);
        address caller = mode == 0 ? seller : stranger;

        if (caller != seller && block.timestamp <= termsExpiry[i]) {
            _mustRevert(caller, address(market), abi.encodeCall(market.cancel, (id)), IExitMarket.NotSeller.selector, "cancel:notSeller");
            return _sync(NONE);
        }

        vm.prank(caller);
        try market.cancel(id) {}
        catch (bytes memory err) {
            return _unexpected("cancel", err);
        }

        if (executed[i]) {
            // Spent while listed: the market forwards the escrowed payout instead of returning the exit.
            ExitClaim memory c = claimAt(i);
            _debit(c.l1Token, address(market), c.amount);
            _credit(c.l1Token, seller, c.amount);
            _expectStatus(i, IExitMarket.Status.Settled);
            _sync(i);
            return _hit("cancel:forwardedPayout");
        }
        shadowOwner[i] = seller;
        _expectStatus(i, IExitMarket.Status.Cancelled);
        _sync(i);
        _hit("cancel");
    }

    function settle(uint256 seed) external {
        uint256 i = _pickListed(seed);
        if (i == NONE) return _hit("settle:skipped");
        ExitClaim memory c = claimAt(i);
        bytes32 id = idOf(i);
        PayoutProof memory p = PayoutProof(c.index, c.sendRoot, new bytes32[](0));

        if (!executed[i]) {
            _mustRevert(stranger, address(market), abi.encodeCall(market.settle, (id, p)), IExitMarket.ExitNotPaidOut.selector, "settle:notPaidOut");
            return _sync(NONE);
        }

        vm.prank(stranger);
        try market.settle(id, p) {}
        catch (bytes memory err) {
            return _unexpected("settle", err);
        }
        _debit(c.l1Token, address(market), c.amount);
        _credit(c.l1Token, termsSeller[i], c.amount);
        _expectStatus(i, IExitMarket.Status.Settled);
        _sync(i);
        _hit("settle");
    }

    /// @dev The Outbox executes an exit: its root becomes confirmed and the current owner is paid. Execution is
    ///      irreversible and finite, so it is rare, and half of the time aimed at an exit the market holds.
    function execute(uint256 seed) external {
        if (!_gate(seed, 4)) return _hit("execute:gated");
        uint256 i = seed % 2 == 0 ? _pickUnspentListed(seed) : NONE;
        for (uint256 k = 0; i == NONE && k < exits; ++k) {
            uint256 j = (seed + k) % exits;
            if (!executed[j]) i = j;
        }
        if (i == NONE) return _hit("execute:skipped");
        ExitClaim memory c = claimAt(i);
        address payee = shadowOwner[i];

        outbox.setRoot(c.sendRoot, keccak256("confirmed"));
        gateway.simulateExecute(outbox, c.index, i + 1, c.initialDestination, MockERC20(c.l1Token), c.amount);
        executed[i] = true;
        minted[c.l1Token] += c.amount;
        _credit(c.l1Token, payee, c.amount);
        if (payee == address(market) && misdirected[i]) unsolicited[c.l1Token] += c.amount;
        _sync(NONE);
        _hit(payee == address(market) ? "execute:paidMarket" : "execute");
    }

    function sellToBuyer(uint256 seed, uint256 paySeed, uint256 minSeed, uint256 lieSeed) external {
        uint256 i = _pickIdle(seed);
        if (i == NONE) return _hit("sell:skipped");
        // Every 4th sale is tiny so that the fee rounds down to zero.
        uint256 pay = paySeed % 4 == 0 ? _clamp(paySeed / 4, 1, 400) : _clamp(paySeed, 1, claimAt(i).amount * 2);
        TestBuyer tb = new TestBuyer(IERC20(address(usdg)), pay);
        if (lieSeed % 2 == 0) tb.setClaimed(_clamp(lieSeed, 1, type(uint128).max)); // reported price is ignored
        _mint(usdg, address(tb), pay);
        _sell(i, address(tb), pay, _clamp(minSeed, 0, pay));
    }

    function _sell(uint256 i, address tb, uint256 pay, uint256 minPayout) internal {
        ExitClaim memory c = claimAt(i);
        address seller = shadowOwner[i];
        uint16 feeNow = modelFeeBps;
        bytes memory data = abi.encode(IExitMarket.Action.SELL_TO_BUYER, c, abi.encode(tb, minPayout));

        vm.prank(seller);
        try gateway.transferExitAndCall(i + 1, c.initialDestination, address(market), "", data) {}
        catch (bytes memory err) {
            return _unexpected("sell", err);
        }

        uint256 fee = (pay * feeNow) / BPS;
        _debit(address(usdg), tb, pay);
        _credit(address(usdg), seller, pay - fee);
        _credit(address(usdg), address(market), fee);
        accrued += fee;
        earned += fee;
        shadowOwner[i] = tb;
        _sync(NONE);
        _hit("sell");
    }

    function withdrawFees(uint256 callerSeed) external {
        if (!_gate(callerSeed, 3)) return _hit("withdrawFees:gated"); // let fees accumulate between withdrawals
        address caller = _traders[callerSeed % _traders.length];
        uint256 amount = accrued;
        if (market.accruedFees() != amount) _violate("accruedFees differs from the model before withdrawal");

        vm.prank(caller);
        try market.withdrawFees() {}
        catch (bytes memory err) {
            return _unexpected("withdrawFees", err);
        }
        _debit(address(usdg), address(market), amount);
        _credit(address(usdg), modelRecipient, amount);
        withdrawn += amount;
        accrued = 0;
        _sync(NONE);
        _hit(amount == 0 ? "withdrawFees:zero" : "withdrawFees");
    }

    function setFee(uint256 bpsSeed, uint256 recipientSeed) external {
        uint256 m = bpsSeed % 6;
        uint16 bps = m == 0 ? 0 : m == 1 ? 200 : m == 2 ? 199 : m == 3 ? 1 : uint16(_clamp(bpsSeed / 6, 0, 200));
        address r = _recipients[recipientSeed % 2];
        vm.prank(marketOwner);
        try market.setFee(bps, r) {}
        catch (bytes memory err) {
            return _unexpected("setFee", err);
        }
        modelFeeBps = bps;
        modelRecipient = r;
        _sync(NONE);
        _hit("setFee");
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + _clamp(secs, 1, 2 days));
        _hit("warp");
    }

    // ================================================================ unsolicited actions

    function donate(uint256 tokenSeed, uint256 donorSeed, uint256 amountSeed) external {
        if (!_gate(amountSeed, 3)) return _hit("donate:gated");
        MockERC20 token = tokenSeed % 2 == 0 ? usdg : other;
        address donor = _traders[donorSeed % _traders.length];
        uint256 amount = _clamp(amountSeed, 1, 1e12);
        _mint(token, donor, amount);
        vm.prank(donor);
        token.transfer(address(market), amount);
        _debit(address(token), donor, amount);
        _credit(address(token), address(market), amount);
        unsolicited[address(token)] += amount;
        _sync(NONE);
        _hit("donate");
    }

    /// @dev User error: redirecting an exit to the market without hook data. The market becomes its owner
    ///      but knows nothing about it, and the payout will arrive in the market with no claim on it.
    function misdirect(uint256 seed) external {
        if (!_gate(seed, 4)) return _hit("misdirect:gated");
        uint256 i = _pickIdle(seed);
        if (i == NONE) return _hit("misdirect:skipped");
        vm.prank(shadowOwner[i]);
        try gateway.transferExitAndCall(i + 1, _dest[i], address(market), "", "") {}
        catch (bytes memory err) {
            return _unexpected("misdirect", err);
        }
        shadowOwner[i] = address(market);
        misdirected[i] = true;
        _sync(NONE);
        _hit("misdirect");
    }

    /// @dev Plain peer-to-peer transfer of an exit, no market involved.
    function transferDirect(uint256 seed, uint256 toSeed) external {
        uint256 i = _pickIdle(seed);
        if (i == NONE) return _hit("transfer:skipped");
        address to = _traders[toSeed % _traders.length];
        vm.prank(shadowOwner[i]);
        try gateway.transferExitAndCall(i + 1, _dest[i], to, "", "") {}
        catch (bytes memory err) {
            return _unexpected("transfer", err);
        }
        shadowOwner[i] = to;
        _sync(NONE);
        _hit("transfer");
    }

    // ================================================================ hostile actions (must revert)

    function hostileNotListed(uint256 seed, uint256 kind) external {
        uint256 i = NONE;
        for (uint256 k = 0; k < exits; ++k) {
            uint256 j = (seed + k) % exits;
            if (_lastStatus[j] != IExitMarket.Status.Listed) {
                i = j;
                break;
            }
        }
        if (i == NONE) return _hit("hostileNotListed:skipped");
        ExitClaim memory c = claimAt(i);
        bytes32 id = idOf(i);
        kind = kind % 3;
        bytes memory callData = kind == 0
            ? abi.encodeCall(market.buy, (id, type(uint256).max))
            : kind == 1
                ? abi.encodeCall(market.cancel, (id))
                : abi.encodeCall(market.settle, (id, PayoutProof(c.index, c.sendRoot, c.proof)));
        _mustRevert(stranger, address(market), callData, IExitMarket.NotListed.selector, "hostile:notListed");
        _sync(NONE);
    }

    function hostileListOrSellSpent(uint256 seed, uint256 kind) external {
        uint256 i = NONE;
        for (uint256 k = 0; k < exits; ++k) {
            uint256 j = (seed + k) % exits;
            if (executed[j] && _isTrader(shadowOwner[j])) {
                i = j;
                break;
            }
        }
        if (i == NONE) return _hit("hostileSpent:skipped");
        ExitClaim memory c = claimAt(i);
        bytes memory params = kind % 2 == 0
            ? abi.encode(uint256(1_000), uint64(block.timestamp + 1 days))
            : abi.encode(address(new TestBuyer(IERC20(address(usdg)), 1)), uint256(0));
        bytes memory data = abi.encode(
            kind % 2 == 0 ? IExitMarket.Action.LIST : IExitMarket.Action.SELL_TO_BUYER, c, params
        );
        _mustRevert(
            shadowOwner[i],
            address(gateway),
            abi.encodeCall(gateway.transferExitAndCall, (i + 1, c.initialDestination, address(market), "", data)),
            IExitMarket.ExitAlreadySpent.selector,
            "hostile:spent"
        );
        _sync(NONE);
    }

    function hostileRelistWhileListed(uint256 seed) external {
        uint256 i = _pickStatus(seed, IExitMarket.Status.Listed);
        if (i == NONE) return _hit("hostileRelist:skipped");
        ExitClaim memory c = claimAt(i);
        bytes memory data = abi.encode(IExitMarket.Action.LIST, c, abi.encode(uint256(1), uint64(block.timestamp + 1 days)));
        // The previous owner no longer controls the exit: the gateway itself refuses.
        _mustRevert(
            termsSeller[i],
            address(gateway),
            abi.encodeCall(gateway.transferExitAndCall, (i + 1, c.initialDestination, address(market), "", data)),
            ERROR_STRING,
            "hostile:relistWhileListed"
        );
        _sync(NONE);
    }

    function hostileBuyTerms(uint256 seed, uint256 kind) external {
        uint256 i = _pickStatus(seed, IExitMarket.Status.Listed);
        if (i == NONE || termsPrice[i] < 2 || block.timestamp > termsExpiry[i]) return _hit("hostileBuyTerms:skipped");
        // Front-run guard: the price is above what the buyer is willing to pay.
        _mustRevert(
            _traders[kind % _traders.length],
            address(market),
            abi.encodeCall(market.buy, (idOf(i), termsPrice[i] - 1)),
            IExitMarket.PriceAboveMax.selector,
            "hostile:priceAboveMax"
        );
        _sync(NONE);
    }

    function hostileSetFee(uint256 bpsSeed, uint256 kind) external {
        bytes memory callData;
        bytes4 sel;
        address caller;
        if (kind % 2 == 0) {
            caller = marketOwner;
            callData = abi.encodeCall(market.setFee, (uint16(_clamp(bpsSeed, 201, type(uint16).max)), _recipients[0]));
            sel = IExitMarket.FeeTooHigh.selector;
        } else {
            caller = stranger;
            callData = abi.encodeCall(market.setFee, (uint16(_clamp(bpsSeed, 0, 200)), stranger));
            sel = bytes4(keccak256("OwnableUnauthorizedAccount(address)"));
        }
        _mustRevert(caller, address(market), callData, sel, "hostile:setFee");
        _sync(NONE);
    }

    function hostileSellTerms(uint256 seed, uint256 kind) external {
        uint256 i = _pickIdle(seed);
        if (i == NONE) return _hit("hostileSell:skipped");
        ExitClaim memory c = claimAt(i);
        // kind 0: buyer pays less than the seller's minimum; kind 1: buyer pays nothing.
        uint256 pay = kind % 2 == 0 ? 1_000 : 0;
        address tb = address(new TestBuyer(IERC20(address(usdg)), pay));
        _mint(usdg, tb, pay);
        bytes memory data = abi.encode(IExitMarket.Action.SELL_TO_BUYER, c, abi.encode(tb, pay + 1));
        _mustRevert(
            shadowOwner[i],
            address(gateway),
            abi.encodeCall(gateway.transferExitAndCall, (i + 1, c.initialDestination, address(market), "", data)),
            kind % 2 == 0 ? IExitMarket.PayoutBelowMin.selector : IExitMarket.ZeroPrice.selector,
            "hostile:sellTerms"
        );
        _sync(NONE);
    }

    // ================================================================ model plumbing

    function _mustRevert(address caller, address target, bytes memory callData, bytes4 sel, string memory name) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) = target.call(callData);
        if (ok) _violate(string.concat(name, " succeeded but must revert"));
        else if (bytes4(ret) != sel) _violate(string.concat(name, " reverted with the wrong error"));
        else _hit(name);
    }

    function _legal(IExitMarket.Status a, IExitMarket.Status b) internal pure returns (bool) {
        if (a == b) return true;
        if (b == IExitMarket.Status.Listed) return true; // (re)listing from None / Sold / Cancelled / Settled
        if (a == IExitMarket.Status.Listed) {
            return b == IExitMarket.Status.Sold || b == IExitMarket.Status.Cancelled || b == IExitMarket.Status.Settled;
        }
        return false; // Sold <-> Cancelled, Sold -> Settled, None -> Sold ... never legal
    }

    /// @dev Runs after every action: statuses only move along the legal machine, only on the acted exit, and
    ///      the gateway's owner of every exit is the model's owner.
    function _sync(uint256 acted) internal {
        for (uint256 i = 0; i < exits; ++i) {
            IExitMarket.Status s = market.getListing(idOf(i)).status;
            IExitMarket.Status prev = _lastStatus[i];
            if (s != prev) {
                if (i != acted) _violate("listing status changed on an exit the action did not touch");
                else if (!_legal(prev, s)) _violate("illegal listing status transition");
                _lastStatus[i] = s;
            }
            if (ownerOf(i) != shadowOwner[i]) _violate("gateway owner differs from the model owner");
        }
        if (market.feeBps() != modelFeeBps || market.feeRecipient() != modelRecipient) {
            _violate("market fee config differs from the model");
        }
    }

    function _expectStatus(uint256 i, IExitMarket.Status want) internal {
        if (market.getListing(idOf(i)).status != want) _violate("listing ended in the wrong status");
    }

    function _pickIdle(uint256 seed) internal view returns (uint256) {
        for (uint256 k = 0; k < exits; ++k) {
            uint256 i = (seed + k) % exits;
            if (!executed[i] && _isTrader(shadowOwner[i])) return i;
        }
        return NONE;
    }

    function _pickStatus(uint256 seed, IExitMarket.Status want) internal view returns (uint256) {
        for (uint256 k = 0; k < exits; ++k) {
            uint256 i = (seed + k) % exits;
            if (_lastStatus[i] == want) return i;
        }
        return NONE;
    }

    /// @dev A Listed exit; half the time one the Outbox already executed, to reach the spent / escrow paths.
    function _pickListed(uint256 seed) internal view returns (uint256) {
        if ((seed >> 64) % 2 == 0) {
            for (uint256 k = 0; k < exits; ++k) {
                uint256 i = (seed + k) % exits;
                if (_lastStatus[i] == IExitMarket.Status.Listed && executed[i]) return i;
            }
        }
        return _pickStatus(seed, IExitMarket.Status.Listed);
    }

    function _pickUnspentListed(uint256 seed) internal view returns (uint256) {
        for (uint256 k = 0; k < exits; ++k) {
            uint256 i = (seed + k) % exits;
            if (_lastStatus[i] == IExitMarket.Status.Listed && !executed[i]) return i;
        }
        return NONE;
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

    function _isTrader(address a) internal view returns (bool) {
        for (uint256 i = 0; i < _traders.length; ++i) {
            if (_traders[i] == a) return true;
        }
        return false;
    }

    function _mint(MockERC20 token, address to, uint256 amount) internal {
        token.mint(to, amount);
        minted[address(token)] += amount;
        _credit(address(token), to, amount);
    }

    function _credit(address token, address who, uint256 amount) internal {
        _track(who);
        ledger[token][who] += amount;
    }

    function _debit(address token, address who, uint256 amount) internal {
        if (ledger[token][who] < amount) {
            _violate("model ledger underflow");
            return;
        }
        ledger[token][who] -= amount;
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
