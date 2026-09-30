// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";

import {ExitClaim, IExitMarket} from "../../interfaces/IExitMarket.sol";
import {MockERC20} from "../mocks/MockArbitrum.sol";
import {ExitTreeFixture} from "../utils/ExitTreeFixture.sol";
import {MarketHandler} from "./MarketHandler.sol";

/// @dev Stateful invariants for ExitMarket, driven by MarketHandler (see there for the action set and the model).
///      Run alone: `npx hardhat test solidity contracts/test/invariant/ExitMarketInvariant.t.sol`.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 120
contract ExitMarketInvariantTest is ExitTreeFixture {
    /// @dev A storage variable, not a constant: with a constant 24 the IR optimizer unrolls into a stack-too-deep.
    uint256 internal exitCount;
    uint16 internal constant CAP = 200;

    MockERC20 internal other;
    MarketHandler internal handler;

    function setUp() public override {
        super.setUp();
        exitCount = 24;
        other = new MockERC20("Other Token", "OTH", 18);

        address[] memory sellers = new address[](3);
        sellers[0] = seller;
        sellers[1] = makeAddr("seller2");
        sellers[2] = makeAddr("seller3");
        address[] memory traders = _traders(sellers);

        LeafSpec[] memory specs = _specs(sellers);
        Withdrawal[] memory ws = _createMixed(NODE, specs);
        handler = new MarketHandler(_wiring(traders, specs, ws));
        _targetHandlerActions();
    }

    /// @dev Sellers plus three buyers; all approve the market for the payment token.
    function _traders(address[] memory sellers) internal returns (address[] memory traders) {
        traders = new address[](6);
        for (uint256 i = 0; i < 3; ++i) traders[i] = sellers[i];
        traders[3] = buyer;
        traders[4] = makeAddr("buyer2");
        traders[5] = makeAddr("buyer3");
        for (uint256 i = 0; i < traders.length; ++i) {
            vm.prank(traders[i]);
            usdg.approve(address(market), type(uint256).max);
        }
    }

    /// @dev 24 withdrawals in one tree: 3 senders, every 4th one in a second token, varied amounts.
    function _specs(address[] memory sellers) internal view returns (LeafSpec[] memory specs) {
        specs = new LeafSpec[](exitCount);
        for (uint256 i = 0; i < exitCount; ++i) {
            bool isOther = i % 4 == 3;
            address who = sellers[i % 3];
            specs[i] = LeafSpec({
                from: who,
                dest: who,
                token: isOther ? address(other) : address(usdg),
                amount: isOther ? (1 + i) * 1e18 : (1_000 + 500 * (i % 5)) * 1e6
            });
        }
    }

    function _wiring(address[] memory traders, LeafSpec[] memory specs, Withdrawal[] memory ws)
        internal
        returns (MarketHandler.Wiring memory w)
    {
        w.market = market;
        w.gateway = gateway;
        w.outbox = outbox;
        w.usdg = usdg;
        w.other = other;
        w.marketOwner = owner;
        w.stranger = stranger;
        w.traders = traders;
        w.recipients = [feeRecipient, makeAddr("feeRecipient2")];
        w.dest = new address[](specs.length);
        w.claims = new bytes[](specs.length);
        for (uint256 i = 0; i < specs.length; ++i) {
            w.dest[i] = specs[i].dest;
            w.claims[i] = abi.encode(ws[i].claim);
        }
    }

    function _targetHandlerActions() internal {
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](18);
        selectors[0] = MarketHandler.list.selector;
        selectors[1] = MarketHandler.buy.selector;
        selectors[2] = MarketHandler.cancel.selector;
        selectors[3] = MarketHandler.settle.selector;
        selectors[4] = MarketHandler.execute.selector;
        selectors[5] = MarketHandler.sellToBuyer.selector;
        selectors[6] = MarketHandler.withdrawFees.selector;
        selectors[7] = MarketHandler.setFee.selector;
        selectors[8] = MarketHandler.warp.selector;
        selectors[9] = MarketHandler.donate.selector;
        selectors[10] = MarketHandler.misdirect.selector;
        selectors[11] = MarketHandler.transferDirect.selector;
        selectors[12] = MarketHandler.hostileNotListed.selector;
        selectors[13] = MarketHandler.hostileListOrSellSpent.selector;
        selectors[14] = MarketHandler.hostileRelistWhileListed.selector;
        selectors[15] = MarketHandler.hostileSetFee.selector;
        selectors[16] = MarketHandler.hostileSellTerms.selector;
        selectors[17] = MarketHandler.hostileBuyTerms.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ================================================================ (a) conservation

    /// @dev The market's payment-token balance is exactly: fees accrued and not yet withdrawn + payouts of
    ///      Listed exits that were executed and not yet settled + unsolicited tokens (donations, payouts of
    ///      exits redirected to it without a hook). It is never short of what it owes.
    function invariant_marketPaymentBalanceEqualsFeesPlusEscrow() public view {
        uint256 bal = usdg.balanceOf(address(market));
        uint256 owed = market.accruedFees() + _escrowOf(address(usdg));
        assertGe(bal, owed, "market holds less than fees + escrow: insolvent");
        assertEq(bal, owed + handler.unsolicited(address(usdg)), "market balance has an unexplained delta");
        assertEq(
            other.balanceOf(address(market)),
            _escrowOf(address(other)) + handler.unsolicited(address(other)),
            "market holds an unexplained amount of the exit token"
        );
    }

    /// @dev Fees the model says were earned (floor(price x snapshot bps)) = still accrued + already withdrawn,
    ///      and every withdrawn wei sits with a recipient.
    function invariant_feesAreConservedAcrossSalesAndWithdrawals() public view {
        assertEq(market.accruedFees(), handler.accrued(), "accruedFees != model");
        assertEq(handler.earned(), market.accruedFees() + handler.withdrawn(), "fees created or destroyed");
        address[2] memory r = handler.recipients();
        assertEq(usdg.balanceOf(r[0]) + usdg.balanceOf(r[1]), handler.withdrawn(), "recipients hold != fees withdrawn");
    }

    /// @dev Closed system: every balance of every participant equals the model ledger, and total supply is
    ///      exactly what the handler minted (the market never creates or burns tokens).
    function invariant_everyBalanceMatchesTheIndependentLedger() public view {
        address[] memory hs = handler.holders();
        uint256 sumUsdg;
        uint256 sumOther;
        for (uint256 i = 0; i < hs.length; ++i) {
            assertEq(usdg.balanceOf(hs[i]), handler.ledger(address(usdg), hs[i]), "payment token balance != ledger");
            assertEq(other.balanceOf(hs[i]), handler.ledger(address(other), hs[i]), "exit token balance != ledger");
            sumUsdg += usdg.balanceOf(hs[i]);
            sumOther += other.balanceOf(hs[i]);
        }
        assertEq(sumUsdg, usdg.totalSupply(), "payment token left the tracked set");
        assertEq(sumOther, other.totalSupply(), "exit token left the tracked set");
        assertEq(usdg.totalSupply(), handler.minted(address(usdg)));
    }

    // ================================================================ (b) single owner, status machine

    /// @dev The gateway names exactly one owner per exit and it is the model's owner. The market owns an exit
    ///      only while Listed, after a payout settlement (Settled), or if a user misdirected it to it. Sold and
    ///      Cancelled listings never leave the market as owner.
    function invariant_exitHasExactlyOneOwnerConsistentWithListingStatus() public view {
        for (uint256 i = 0; i < exitCount; ++i) {
            address o = handler.ownerOf(i);
            IExitMarket.Status s = market.getListing(handler.idOf(i)).status;
            bool marketOwns = o == address(market);
            assertEq(o, handler.shadowOwner(i), "gateway owner != model owner");
            if (s == IExitMarket.Status.Listed) assertTrue(marketOwns, "Listed but the market does not own the exit");
            if (marketOwns) {
                assertTrue(
                    s == IExitMarket.Status.Listed || s == IExitMarket.Status.Settled || handler.misdirected(i),
                    "market owns an exit whose listing is Sold, Cancelled or unknown"
                );
            }
            if (s == IExitMarket.Status.Settled) {
                assertTrue(marketOwns && outbox.isSpent(handler.claimAt(i).index), "Settled without a spent slot");
            }
            assertEq(outbox.isSpent(handler.claimAt(i).index), handler.executed(i), "spent bit != model");
        }
    }

    /// @dev No handler call ever produced: an illegal status move (e.g. Sold -> Cancelled, Cancelled -> Sold,
    ///      Sold -> Settled), a status change on an exit the call did not touch, a legal action that reverted,
    ///      or a hostile action that succeeded.
    function invariant_statusMachineAndHostileActionsBehave() public view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }

    // ================================================================ (d) fee snapshot

    /// @dev A listing's feeBps is the bps at listing time, never above the 200 cap, and never rewritten later.
    function invariant_feeBpsSnapshotNeverExceedsCapAndNeverChanges() public view {
        assertLe(market.feeBps(), CAP, "live fee above the cap");
        assertEq(market.MAX_FEE_BPS(), CAP);
        for (uint256 i = 0; i < exitCount; ++i) {
            IExitMarket.Listing memory l = market.getListing(handler.idOf(i));
            if (l.status == IExitMarket.Status.None) continue;
            assertLe(l.feeBps, CAP, "snapshotted fee above the cap");
            assertEq(l.feeBps, handler.snapFee(i), "snapshotted fee was rewritten");
        }
    }

    /// @dev Seller, price and expiry of a listing are fixed for its whole life (Sold, Cancelled or Settled too).
    function invariant_listingTermsNeverChangeAfterListing() public view {
        for (uint256 i = 0; i < exitCount; ++i) {
            IExitMarket.Listing memory l = market.getListing(handler.idOf(i));
            if (l.status == IExitMarket.Status.None) continue;
            assertEq(l.seller, handler.termsSeller(i), "seller changed");
            assertEq(l.price, handler.termsPrice(i), "price changed");
            assertEq(l.expiry, handler.termsExpiry(i), "expiry changed");
            assertEq(l.exit.amount, handler.claimAt(i).amount, "exit amount changed");
        }
    }

    // ================================================================ helpers

    /// @dev Payout tokens the market must be holding for Listed exits that the Outbox already executed.
    function _escrowOf(address token) internal view returns (uint256 total) {
        for (uint256 i = 0; i < exitCount; ++i) {
            ExitClaim memory c = handler.claimAt(i);
            if (c.l1Token != token) continue;
            if (market.getListing(handler.idOf(i)).status == IExitMarket.Status.Listed && outbox.isSpent(c.index)) {
                total += c.amount;
            }
        }
    }

    // ================================================================ non-vacuity guard

    string[] internal outcomes;
    mapping(string => uint256) internal seen;

    /// @dev The invariants only mean something if the handler really reaches every outcome. A deterministic
    ///      pseudo-random walk over 24 fresh deployments must hit each legal, hostile and unsolicited path at
    ///      least once with zero violations; a handler edit that silently disables an action fails here.
    function test_handlerReachesEveryOutcomeWithoutViolations() public {
        _registerOutcomes();
        uint256 r = uint256(keccak256("market-walk"));
        for (uint256 world = 0; world < 24; ++world) {
            if (world != 0) this.setUp();
            for (uint256 step = 0; step < 200; ++step) {
                r = uint256(keccak256(abi.encode(r, step)));
                _step(r);
            }
            assertEq(handler.violations(), 0, handler.firstViolation());
            for (uint256 k = 0; k < outcomes.length; ++k) seen[outcomes[k]] += handler.hits(outcomes[k]);
        }
        for (uint256 k = 0; k < outcomes.length; ++k) assertGt(seen[outcomes[k]], 0, outcomes[k]);
    }

    function _step(uint256 r) internal {
        uint256 a = r % 18;
        uint256 x = uint256(keccak256(abi.encode(r, 1)));
        uint256 y = uint256(keccak256(abi.encode(r, 2)));
        uint256 z = uint256(keccak256(abi.encode(r, 3)));
        if (a == 0) handler.list(x, y, z);
        else if (a == 1) handler.buy(x, y, z);
        else if (a == 2) handler.cancel(x, y);
        else if (a == 3) handler.settle(x);
        else if (a == 4) handler.execute(x);
        else if (a == 5) handler.sellToBuyer(x, y, z, uint256(keccak256(abi.encode(r, 4))));
        else if (a == 6) handler.withdrawFees(x);
        else if (a == 7) handler.setFee(x, y);
        else if (a == 8) handler.warp(x);
        else if (a == 9) handler.donate(x, y, z);
        else if (a == 10) handler.misdirect(x);
        else if (a == 11) handler.transferDirect(x, y);
        else if (a == 12) handler.hostileNotListed(x, y);
        else if (a == 13) handler.hostileListOrSellSpent(x, y);
        else if (a == 14) handler.hostileRelistWhileListed(x);
        else if (a == 15) handler.hostileSetFee(x, y);
        else if (a == 16) handler.hostileBuyTerms(x, y);
        else handler.hostileSellTerms(x, y);
    }

    function _registerOutcomes() internal {
        delete outcomes;
        outcomes.push("list");
        outcomes.push("buy");
        outcomes.push("buy:expired");
        outcomes.push("buy:spent");
        outcomes.push("cancel");
        outcomes.push("cancel:notSeller");
        outcomes.push("cancel:forwardedPayout");
        outcomes.push("settle");
        outcomes.push("settle:notPaidOut");
        outcomes.push("execute");
        outcomes.push("execute:paidMarket");
        outcomes.push("sell");
        outcomes.push("withdrawFees");
        outcomes.push("setFee");
        outcomes.push("donate");
        outcomes.push("misdirect");
        outcomes.push("transfer");
        outcomes.push("hostile:notListed");
        outcomes.push("hostile:spent");
        outcomes.push("hostile:relistWhileListed");
        outcomes.push("hostile:priceAboveMax");
        outcomes.push("hostile:setFee");
        outcomes.push("hostile:sellTerms");
    }
}
