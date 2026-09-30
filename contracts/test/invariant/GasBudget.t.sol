// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IExitMarket} from "../../interfaces/IExitMarket.sol";
import {IExitIntentRouter} from "../../interfaces/IExitIntentRouter.sol";
import {IntentFixture} from "../utils/IntentFixture.sol";
import {TestBuyer} from "../utils/TestBuyers.sol";

/// forge-config: default.isolate = true
/// @dev Gas of each user-facing operation measured in isolation (`gasleft()` around one call, fresh listing per
///      test, mock Arbitrum stack, viaIR + 200 optimizer runs), with a ceiling ~30% above the measured value
///      (isolate = true: every top-level call runs as its own transaction, so storage is cold like on-chain;
///      the 21,000 base cost and calldata gas are not included) so
///      that an accidental regression fails CI. Numbers are recorded in docs/audit/GAS.md; run with `-vv` to print them:
///      `npx hardhat test solidity contracts/test/invariant/GasBudget.t.sol -vv`.
contract GasBudgetTest is IntentFixture {
    uint256 internal constant PRICE = 9_900e6;

    function _report(string memory name, uint256 gasUsed, uint256 budget) internal pure {
        console2.log(name, gasUsed);
        require(gasUsed <= budget, string.concat("gas budget exceeded: ", name));
    }

    function _hook(IExitMarket.Action action, Withdrawal memory w, bytes memory params) internal {
        bytes memory data = _hookData(action, w.claim, params);
        vm.prank(seller);
        uint256 g = gasleft();
        gateway.transferExitAndCall(w.exitNum, w.claim.initialDestination, address(market), "", data);
        g -= gasleft();
        lastGas = g;
    }

    uint256 internal lastGas;

    // ---------------------------------------------------------------- ExitMarket

    function test_gas_market_listViaHook() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _hook(IExitMarket.Action.LIST, ws[0], abi.encode(PRICE, uint64(block.timestamp + 1 days)));
        _report("market list (transferExitAndCall -> onExitTransfer, LIST)", lastGas, 560_000);
    }

    function test_gas_market_sellToBuyerViaHook_cheapBuyer() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        TestBuyer tb = new TestBuyer(IERC20(address(usdg)), PRICE);
        usdg.mint(address(tb), PRICE);
        _hook(IExitMarket.Action.SELL_TO_BUYER, ws[0], abi.encode(address(tb), 0));
        _report("market sell-to-buyer, mock buyer (hook overhead only)", lastGas, 335_000);
    }

    function test_gas_market_sellToBuyerViaHook_exitVault() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _hook(IExitMarket.Action.SELL_TO_BUYER, ws[0], abi.encode(address(vault), 0));
        _report("market sell-to-buyer, ExitVault buyer", lastGas, 560_000);
    }

    function test_gas_market_buy() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _fund(buyer, address(market), PRICE);
        vm.prank(buyer);
        uint256 g = gasleft();
        market.buy(id, PRICE);
        g -= gasleft();
        _report("market buy", g, 270_000);
    }

    function test_gas_market_cancel() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        vm.prank(seller);
        uint256 g = gasleft();
        market.cancel(id);
        g -= gasleft();
        _report("market cancel", g, 120_000);
    }

    function test_gas_market_settleAfterExecution() public {
        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        bytes32 id = _list(ws[0], seller, PRICE);
        _confirm(ws[0]);
        _execute(ws[0]);
        vm.prank(stranger);
        uint256 g = gasleft();
        market.settle(id, _ownPayout(ws[0]));
        g -= gasleft();
        _report("market settle", g, 140_000);
    }

    // ---------------------------------------------------------------- ExitVault

    function test_gas_vault_depositRedeemCollect() public {
        address lp2 = makeAddr("lp2");
        _fund(lp2, address(vault), 100_000e6);
        vm.prank(lp2);
        uint256 g = gasleft();
        uint256 shares = vault.deposit(100_000e6, lp2);
        g -= gasleft();
        _report("vault deposit (second LP)", g, 140_000);

        Withdrawal[] memory ws = _createWithdrawals(1, seller, AMOUNT);
        _sellTo(ws[0], seller, address(vault), 0);
        _confirm(ws[0]);
        _execute(ws[0]);
        vm.prank(stranger);
        g = gasleft();
        vault.collect(_record(ws[0]), _ownPayout(ws[0]));
        g -= gasleft();
        _report("vault collect (1 open position)", g, 150_000);

        vm.warp(block.timestamp + vault.SHARE_LOCK());
        vm.prank(lp2);
        g = gasleft();
        vault.redeem(shares, lp2, lp2);
        g -= gasleft();
        _report("vault redeem (0 open positions)", g, 110_000);
    }

    // ---------------------------------------------------------------- ExitIntentRouter

    function test_gas_router_settleGaslessSale() public {
        Withdrawal[] memory ws = _intents(1);
        IExitIntentRouter.SellOrder memory o = _order(ws[0], 0, RELAYER_FEE);
        bytes memory sig = _signed(o);
        vm.prank(relayer);
        uint256 g = gasleft();
        router.settle(ws[0].claim, o, sig);
        g -= gasleft();
        _report("router settle (signature + market hook + vault purchase + 2 payouts)", g, 620_000);
    }

    function test_gas_router_reclaim() public {
        Withdrawal[] memory ws = _intents(1);
        vm.prank(user);
        uint256 g = gasleft();
        router.reclaim(ws[0].gateway, ws[0].exitNum, ws[0].claim);
        g -= gasleft();
        _report("router reclaim", g, 160_000);
    }
}
