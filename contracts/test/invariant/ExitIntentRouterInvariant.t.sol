// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IExitMarket} from "../../interfaces/IExitMarket.sol";
import {ExitIntentRouter} from "../../ExitIntentRouter.sol";
import {ExitVault} from "../../ExitVault.sol";
import {ExitTreeFixture} from "../utils/ExitTreeFixture.sol";
import {RouterHandler} from "./RouterHandler.sol";

/// forge-config: default.invariant.runs = 100
/// forge-config: default.invariant.depth = 150
/// @dev Stateful invariants for ExitIntentRouter (+ ExitMarket + ExitVault behind it), driven by RouterHandler.
///      Run alone: `npx hardhat test solidity contracts/test/invariant/ExitIntentRouterInvariant.t.sol`.
contract ExitIntentRouterInvariantTest is ExitTreeFixture {
    // Same deployment as IntentFixture (whose setUp is not virtual, so it cannot be extended with a handler).
    uint256 internal constant USER_PK = 0xA11CE;
    uint256 internal constant USER2_PK = 0xB0B;
    uint256 internal constant USER3_PK = 0xC0DE;
    uint256 internal constant LP_DEPOSIT = 500_000e6;

    ExitVault internal vault;
    ExitIntentRouter internal router;
    address internal relayer;
    address internal lp;

    /// @dev A storage variable, not a constant: keeps the IR optimizer from unrolling loops into stack-too-deep.
    uint256 internal exitCount;
    RouterHandler internal handler;

    function setUp() public override {
        super.setUp(); // gateway stack, market allowing the gateway
        relayer = makeAddr("relayer");
        lp = makeAddr("lp");
        vault = new ExitVault(IERC20(address(usdg)), IExitMarket(address(market)), owner, "Exit Vault USDG", "xvUSDG");
        router = new ExitIntentRouter(address(market), address(vault));
        _fund(lp, address(vault), LP_DEPOSIT);
        vm.prank(lp);
        vault.deposit(LP_DEPOSIT, lp);
        exitCount = 20;

        uint256[] memory keys = new uint256[](3);
        keys[0] = USER_PK;
        keys[1] = USER2_PK;
        keys[2] = USER3_PK;
        LeafSpec[] memory specs = _specs(keys);
        Withdrawal[] memory ws = _createMixed(NODE, specs);
        handler = new RouterHandler(_wiring(keys, ws));
        _targetHandlerActions();
    }

    /// @dev 20 withdrawals in one tree by 3 users, all with the router as initial destination.
    function _specs(uint256[] memory keys) internal view returns (LeafSpec[] memory specs) {
        specs = new LeafSpec[](exitCount);
        for (uint256 i = 0; i < exitCount; ++i) {
            specs[i] = LeafSpec({
                from: vm.addr(keys[i % 3]),
                dest: address(router),
                token: address(usdg),
                amount: (1_000 + 400 * (i % 4)) * 1e6
            });
        }
    }

    function _wiring(uint256[] memory keys, Withdrawal[] memory ws) internal returns (RouterHandler.Wiring memory w) {
        w.market = market;
        w.router = router;
        w.vault = vault;
        w.gateway = gateway;
        w.outbox = outbox;
        w.rollup = rollup;
        w.usdg = usdg;
        w.vaultOwner = owner;
        w.stranger = stranger;
        w.userKeys = keys;
        w.relayers = new address[](3);
        w.relayers[0] = relayer;
        w.relayers[1] = makeAddr("relayer2");
        w.relayers[2] = vm.addr(keys[0]); // a user relaying their own (or a friend's) order
        w.extraHolders = new address[](1);
        w.extraHolders[0] = lp;
        w.claims = new bytes[](ws.length);
        for (uint256 i = 0; i < ws.length; ++i) w.claims[i] = abi.encode(ws[i].claim);
    }

    function _targetHandlerActions() internal {
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = RouterHandler.settleOrder.selector;
        selectors[1] = RouterHandler.reclaim.selector;
        selectors[2] = RouterHandler.execute.selector;
        selectors[3] = RouterHandler.recover.selector;
        selectors[4] = RouterHandler.donate.selector;
        selectors[5] = RouterHandler.warp.selector;
        selectors[6] = RouterHandler.setVaultParams.selector;
        selectors[7] = RouterHandler.hostileSettle.selector;
        selectors[8] = RouterHandler.hostileReplay.selector;
        selectors[9] = RouterHandler.hostileRecover.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ================================================================ (c) router never strands or creates tokens

    /// @dev Between calls the router holds exactly the payouts of executed, still router-owned exits that nobody
    ///      has recovered yet, plus unsolicited donations. A settlement never leaves anything behind or takes
    ///      anything it did not receive.
    function invariant_routerHoldsOnlyUnrecoveredPayoutsAndDonations() public view {
        assertEq(
            usdg.balanceOf(address(router)),
            handler.stranded() + handler.donated(),
            "router balance != unrecovered payouts + donations"
        );

        uint256 owedToSenders;
        for (uint256 i = 0; i < exitCount; ++i) {
            if (handler.executed(i) && handler.ownerOf(i) == address(router) && !handler.recovered(i)) {
                owedToSenders += handler.claimAt(i).amount;
            }
        }
        assertEq(owedToSenders, handler.stranded(), "payouts still recoverable != model");
        assertGe(usdg.balanceOf(address(router)), owedToSenders, "router cannot cover the payouts it owes");
    }

    /// @dev Over any sequence of settlements: what the vault paid = what sellers and relayers received + what the
    ///      market kept as its fee; the market holds exactly its fees (no exit payout ever routes through it).
    function invariant_sellersAndRelayersReceiveWhatTheVaultPaidMinusMarketFee() public view {
        assertEq(
            handler.buyersPaid(),
            handler.toSellers() + handler.toRelayers() + handler.marketFees(),
            "value created or destroyed by settlements"
        );
        assertEq(market.accruedFees(), handler.marketFees(), "market fee != floor(paid x bps) summed");
        assertEq(usdg.balanceOf(address(market)), market.accruedFees(), "market holds more than its fees");
    }

    /// @dev Closed system: every token is with a tracked participant and the supply is exactly the LP deposit plus
    ///      what the handler minted (payouts of executed exits, donations).
    function invariant_paymentTokenSupplyIsFullyAccountedFor() public view {
        address[] memory hs = handler.holders();
        uint256 sum;
        for (uint256 i = 0; i < hs.length; ++i) sum += usdg.balanceOf(hs[i]);
        assertEq(sum, usdg.totalSupply(), "tokens left the tracked set");
        assertEq(usdg.totalSupply(), LP_DEPOSIT + handler.minted(), "supply != deposit + minted");
    }

    // ================================================================ ownership

    /// @dev The gateway names one owner per exit and it is the model's: the router until the exit is settled
    ///      (vault) or reclaimed (sender). An executed exit never leaves the router except through settle-before-
    ///      execution or recoverExecuted's aftermath, so its payout can always be recovered.
    function invariant_exitOwnershipMatchesTheModel() public view {
        for (uint256 i = 0; i < exitCount; ++i) {
            address o = handler.ownerOf(i);
            assertEq(o, handler.ownerModel(i), "gateway owner != model owner");
            if (handler.settled(i)) assertEq(o, address(vault), "settled exit not with the vault");
            if (handler.executed(i) && !handler.settled(i) && o != address(router)) {
                assertEq(o, handler.claimAt(i).from, "executed exit moved to someone other than its sender");
            }
        }
    }

    // ================================================================ per-call properties

    /// @dev No handler call ever produced: a wrong split of the buyer's payment, a changed router balance, a
    ///      settlement that ignored the seller's minimum, a hostile call that succeeded (bad signature, expired
    ///      order, foreign buyer or gateway, replay, reclaim after execution, double / premature recovery), a
    ///      revert that changed balances or moved the exit, or a legal action that reverted.
    function invariant_settlementsAndHostileCallsBehave() public view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }
}
