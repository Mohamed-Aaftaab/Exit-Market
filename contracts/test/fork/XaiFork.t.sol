// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ExitMarket} from "../../ExitMarket.sol";
import {LegacyRootVerifier} from "../../verifiers/LegacyRootVerifier.sol";
import {IL1ArbitrumExtendedGateway} from "../../interfaces/IArbitrumBridge.sol";
import {ExitClaim, IExitMarket} from "../../interfaces/IExitMarket.sol";
import {MockERC20} from "../mocks/MockArbitrum.sol";
import {XaiExitFixture} from "./XaiExitFixture.sol";

/// @notice End-to-end against the REAL Xai Testnet contracts on an Arbitrum Sepolia fork: real gateway,
///         real rollup (pending node), real Outbox. Proves the whole design works on live infrastructure.
/// @dev Run with FORK_TESTS=1 (network access): `FORK_TESTS=1 npx hardhat test solidity --grep XaiFork`.
contract XaiForkTest is Test {
    string private constant RPC = "https://sepolia-rollup.arbitrum.io/rpc";

    ExitMarket private market;
    IL1ArbitrumExtendedGateway private gateway = IL1ArbitrumExtendedGateway(XaiExitFixture.PARENT_GATEWAY);
    bool private enabled;

    function setUp() public {
        enabled = vm.envOr("FORK_TESTS", false);
        if (!enabled) return;
        vm.createSelectFork(RPC, XaiExitFixture.FORK_BLOCK);

        MockERC20 usd = new MockERC20("USD", "USD", 6);
        market = new ExitMarket(address(usd), address(this), 25, address(this));
        market.allowGateway(address(gateway), new LegacyRootVerifier());
    }

    function test_realGateway_derivesRealXaiSources() public {
        if (!enabled) return vm.skip(true);
        IExitMarket.GatewayConfig memory cfg = market.getGatewayConfig(address(gateway));
        assertEq(cfg.childGateway, 0xD840761a09609394FaFA3404bEEAb312059AC558);
        assertEq(cfg.outbox, 0xc7491a559b416540427f9f112C5c98b1412c5d51);
        assertEq(cfg.rollup, 0xeedE9367Df91913ab149e828BDd6bE336df2c892);
    }

    function test_realUnspentExit_isVerifiedAndListedThroughRealGateway() public {
        if (!enabled) return vm.skip(true);
        ExitClaim memory c = XaiExitFixture.claim();
        bytes memory data = abi.encode(IExitMarket.Action.LIST, c, abi.encode(uint256(1e6), uint64(block.timestamp + 1 days)));

        vm.prank(c.initialDestination);
        gateway.transferExitAndCall(XaiExitFixture.EXIT_NUM, c.initialDestination, address(market), "", data);

        bytes32 id = market.listingId(address(gateway), XaiExitFixture.EXIT_NUM, c.initialDestination);
        IExitMarket.Listing memory l = market.getListing(id);
        assertEq(uint8(l.status), uint8(IExitMarket.Status.Listed));
        assertEq(l.exit.amount, c.amount);
        assertEq(l.exit.index, c.index);
        (address owner,) = gateway.getExternalCall(XaiExitFixture.EXIT_NUM, c.initialDestination, "");
        assertEq(owner, address(market));
    }

    function test_realExit_withTamperedAmount_isRejected() public {
        if (!enabled) return vm.skip(true);
        ExitClaim memory c = XaiExitFixture.claim();
        c.amount += 1;
        bytes memory data = abi.encode(IExitMarket.Action.LIST, c, abi.encode(uint256(1e6), uint64(block.timestamp + 1 days)));

        vm.prank(c.initialDestination);
        vm.expectRevert(); // ProofMismatch bubbles up through the gateway
        gateway.transferExitAndCall(XaiExitFixture.EXIT_NUM, c.initialDestination, address(market), "", data);
    }
}
