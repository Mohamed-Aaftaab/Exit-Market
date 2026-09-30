// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IBoldRollup} from "../../interfaces/IBoldRollup.sol";
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

    /// @dev AssertionStatus.Confirmed in the BOLD rollup.
    uint8 private constant CONFIRMED = 2;

    function setUp() public {
        enabled = vm.envOr("FORK_TESTS", false);
        if (!enabled) return;
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", RPC));
        // The fixture is a real withdrawal that was pending when recorded. Once its assertion confirms on mainnet
        // there is nothing pending left to prove: skip (loudly) instead of failing, and say how to refresh it.
        if (IBoldRollup(F.ROLLUP).getAssertion(F.ASSERTION_HASH).status == CONFIRMED) {
            console.log("ArbOne fixture expired (assertion confirmed): run scripts/dev/makeArbOneFixture.ts");
            enabled = false;
            return;
        }

        MockERC20 usd = new MockERC20("USD", "USD", 6);
        market = new ExitMarket(address(usd), address(this), 25, address(this));
        verifier = new BoldRootVerifier();
        market.allowGateway(address(gateway), verifier);
    }

    /// @dev Registers every real pending assertion from the latest confirmed one down to the target.
    function _registerPendingChain() private returns (bytes32 last) {
        F.ChainLink[] memory links = F.chain();
        for (uint256 i = 0; i < links.length; ++i) {
            last = verifier.register(F.ROLLUP, links[i].parent, links[i].afterState, links[i].inboxAcc);
        }
    }

    function test_arbOne_realGatewayDerivesBoldRollupAndOutbox() public {
        if (!enabled) return vm.skip(true);
        IExitMarket.GatewayConfig memory cfg = market.getGatewayConfig(address(gateway));
        assertEq(cfg.rollup, F.ROLLUP);
        assertEq(cfg.outbox, 0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840);
    }

    function test_arbOne_registersRealPendingBoldAssertion() public {
        if (!enabled) return vm.skip(true);
        bytes32 h = _registerPendingChain();
        assertEq(h, F.ASSERTION_HASH);
        assertGt(F.chain().length, 1); // a real multi-level pending chain is walked

        ExitClaim memory c = F.claim();
        (bool valid, bool pending, uint64 deadline) =
            verifier.verifyRoot(F.ROLLUP, 0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840, c.sendRoot, 0, F.ASSERTION_HASH);
        assertTrue(valid);
        assertTrue(pending);
        assertGt(deadline, block.number); // challenge period still running on mainnet
    }

    function test_arbOne_realPendingWithdrawalIsProvenAndListed() public {
        if (!enabled) return vm.skip(true);
        _registerPendingChain();
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

    /// @dev Gas of the full ancestor walk over the real pending chain, and of the whole listing hook on top of it.
    function test_arbOne_gas_fullPendingChainWalk() public {
        if (!enabled) return vm.skip(true);
        _registerPendingChain();
        ExitClaim memory c = F.claim();
        address outbox = 0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840;
        _coolAll(outbox);

        uint256 before = gasleft();
        (bool valid,,) = verifier.verifyRoot(F.ROLLUP, outbox, c.sendRoot, 0, F.ASSERTION_HASH);
        uint256 walkGas = before - gasleft();
        assertTrue(valid);

        bytes memory data =
            abi.encode(IExitMarket.Action.LIST, c, abi.encode(uint256(1e6), uint64(block.timestamp + 1 days)));
        _coolAll(outbox);
        vm.prank(c.initialDestination);
        before = gasleft();
        gateway.transferExitAndCall(F.EXIT_NUM, c.initialDestination, address(market), "", data);
        uint256 listGas = before - gasleft();

        emit log_named_uint("pending chain depth", F.chain().length);
        emit log_named_uint("verifyRoot gas (cold)", walkGas);
        emit log_named_uint("transferExitAndCall LIST gas", listGas);
        assertLt(listGas, 3_000_000);
    }

    /// @dev Registration warmed every slot; mark them cold so the measurement matches a fresh transaction.
    function _coolAll(address outbox) private {
        vm.cool(address(verifier));
        vm.cool(address(market));
        vm.cool(address(gateway));
        vm.cool(F.ROLLUP);
        vm.cool(outbox);
    }

    function test_arbOne_targetRegisteredButAncestorsMissingIsRejected() public {
        if (!enabled) return vm.skip(true);
        verifier.register(F.ROLLUP, F.PARENT_ASSERTION_HASH, F.afterState(), F.INBOX_ACC);
        (bool valid,,) =
            verifier.verifyRoot(F.ROLLUP, 0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840, F.claim().sendRoot, 0, F.ASSERTION_HASH);
        assertFalse(valid); // fail closed: every pending ancestor must be known and unchallenged
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
