// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ExitMarket} from "../../ExitMarket.sol";
import {BoldRootVerifier} from "../../verifiers/BoldRootVerifier.sol";
import {IL1ArbitrumExtendedGateway} from "../../interfaces/IArbitrumBridge.sol";
import {ExitClaim, IExitMarket} from "../../interfaces/IExitMarket.sol";
import {MockERC20} from "../mocks/MockArbitrum.sol";
import {ArbOneExitFixture as F} from "./ArbOneExitFixture.sol";

/// @notice Arbitrum One (BOLD) on an Ethereum mainnet fork: a REAL pending token withdrawal is proven against
///         a REAL pending BOLD assertion and listed through the REAL Arbitrum One L1 gateway.
/// @dev Needs network: `FORK_TESTS=1 npx hardhat test solidity --grep arbOne`. Forks latest (pending assertions
///      stay pending ~6.4 days; regenerate the fixture with scripts/dev/makeArbOneFixture.ts afterwards).
contract ArbOneBoldForkTest is Test {
    string private constant RPC = "https://ethereum-rpc.publicnode.com";

    ExitMarket private market;
    BoldRootVerifier private verifier;
    IL1ArbitrumExtendedGateway private gateway = IL1ArbitrumExtendedGateway(F.L1_GATEWAY);
    bool private enabled;

    function setUp() public {
        enabled = vm.envOr("FORK_TESTS", false);
        if (!enabled) return;
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", RPC));

        MockERC20 usd = new MockERC20("USD", "USD", 6);
        market = new ExitMarket(address(usd), address(this), 25, address(this));
        verifier = new BoldRootVerifier();
        market.allowGateway(address(gateway), verifier);
    }

    function test_arbOne_realGatewayDerivesBoldRollupAndOutbox() public {
        if (!enabled) return vm.skip(true);
        IExitMarket.GatewayConfig memory cfg = market.getGatewayConfig(address(gateway));
        assertEq(cfg.rollup, F.ROLLUP);
        assertEq(cfg.outbox, 0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840);
    }

    function test_arbOne_registersRealPendingBoldAssertion() public {
        if (!enabled) return vm.skip(true);
        bytes32 h = verifier.register(F.ROLLUP, F.PARENT_ASSERTION_HASH, F.afterState(), F.INBOX_ACC);
        assertEq(h, F.ASSERTION_HASH);

        ExitClaim memory c = F.claim();
        (bool valid, bool pending, uint64 deadline) =
            verifier.verifyRoot(F.ROLLUP, 0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840, c.sendRoot, 0, F.ASSERTION_HASH);
        assertTrue(valid);
        assertTrue(pending);
        assertGt(deadline, block.number); // challenge period still running on mainnet
    }

    function test_arbOne_realPendingWithdrawalIsProvenAndListed() public {
        if (!enabled) return vm.skip(true);
        verifier.register(F.ROLLUP, F.PARENT_ASSERTION_HASH, F.afterState(), F.INBOX_ACC);
        ExitClaim memory c = F.claim();
        bytes memory data =
            abi.encode(IExitMarket.Action.LIST, c, abi.encode(uint256(1e6), uint64(block.timestamp + 1 days)));

        vm.prank(c.initialDestination);
        gateway.transferExitAndCall(F.EXIT_NUM, c.initialDestination, address(market), "", data);

        IExitMarket.Listing memory l = market.getListing(market.listingId(address(gateway), F.EXIT_NUM, c.initialDestination));
        assertEq(uint8(l.status), uint8(IExitMarket.Status.Listed));
        assertTrue(l.exit.pending);
        assertEq(l.exit.amount, c.amount);
        (address owner,) = gateway.getExternalCall(F.EXIT_NUM, c.initialDestination, "");
        assertEq(owner, address(market));
    }

    function test_arbOne_unregisteredAssertionIsRejected() public {
        if (!enabled) return vm.skip(true);
        ExitClaim memory c = F.claim();
        bytes memory data =
            abi.encode(IExitMarket.Action.LIST, c, abi.encode(uint256(1e6), uint64(block.timestamp + 1 days)));

        vm.prank(c.initialDestination);
        vm.expectRevert(); // InvalidRoot: the verifier only trusts registered, recomputed assertions
        gateway.transferExitAndCall(F.EXIT_NUM, c.initialDestination, address(market), "", data);
    }
}
