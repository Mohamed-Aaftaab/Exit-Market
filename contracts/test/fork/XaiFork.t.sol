// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ExitMarket} from "../../ExitMarket.sol";
import {LegacyRootVerifier} from "../../verifiers/LegacyRootVerifier.sol";
import {IL1ArbitrumExtendedGateway, ILegacyRollup, LegacyNode} from "../../interfaces/IArbitrumBridge.sol";
import {ExitClaim, IExitMarket} from "../../interfaces/IExitMarket.sol";
import {MockERC20} from "../mocks/MockArbitrum.sol";
import {XaiExitFixture} from "./XaiExitFixture.sol";

/// @notice End-to-end against the REAL Xai Testnet contracts on an Arbitrum Sepolia fork: real gateway,
///         real rollup (pending node), real Outbox. Proves the whole design works on live infrastructure.
/// @dev Run with FORK_TESTS=1 (network access): `npm run test:fork -- contracts/test/fork/XaiFork.t.sol`. The fixture is pinned
///      to the block where its withdrawal was pending; public endpoints serve old state only intermittently, so the
///      tests skip (with a message) when the RPC no longer serves that block. ARB_SEPOLIA_RPC_URL = an archive node fixes it.
contract XaiForkTest is Test {
    string private constant RPC = "https://sepolia-rollup.arbitrum.io/rpc";
    /// @dev Xai Testnet's rollup and Outbox on Arbitrum Sepolia (scripts/lib/networks.ts; the test checks the gateway
    ///      derives exactly these).
    address private constant XAI_ROLLUP = 0xeedE9367Df91913ab149e828BDd6bE336df2c892;
    address private constant XAI_OUTBOX = 0xc7491a559b416540427f9f112C5c98b1412c5d51;

    ExitMarket private market;
    IL1ArbitrumExtendedGateway private gateway = IL1ArbitrumExtendedGateway(XaiExitFixture.PARENT_GATEWAY);
    bool private enabled;

    function setUp() public {
        enabled = vm.envOr("FORK_TESTS", false);
        if (!enabled) return;
        string memory rpc = vm.envOr("ARB_SEPOLIA_RPC_URL", RPC);
        // Probe BEFORE forking: once forked onto a block whose state the endpoint dropped, every read fails fatally.
        if (!_servesForkBlock(rpc)) {
            console.log("Xai fork fixture block is no longer served by the RPC: set ARB_SEPOLIA_RPC_URL to an archive node,");
            console.log("or regenerate the fixture: node scripts/dev/makeForkFixture.ts <unspent withdrawal tx> (see its header)");
            enabled = false;
            return;
        }
        vm.createSelectFork(rpc, XaiExitFixture.FORK_BLOCK);

        MockERC20 usd = new MockERC20("USD", "USD", 6);
        market = new ExitMarket(address(usd), address(this), 25, address(this));
        market.allowGateway(address(gateway), new LegacyRootVerifier());
    }

    function test_realGateway_derivesRealXaiSources() public {
        if (!enabled) return vm.skip(true);
        IExitMarket.GatewayConfig memory cfg = market.getGatewayConfig(address(gateway));
        assertEq(cfg.childGateway, 0xD840761a09609394FaFA3404bEEAb312059AC558);
        assertEq(cfg.outbox, XAI_OUTBOX);
        assertEq(cfg.rollup, XAI_ROLLUP);
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

    /// The rival walk on the live rollup: the real pending node is uncontested all the way to the latest confirmed
    /// node, and the same node stops verifying once its parent records a newer (rival) child.
    function test_realPendingNode_passesTheRivalWalkAndARivalStopsIt() public {
        if (!enabled) return vm.skip(true);
        ExitClaim memory c = XaiExitFixture.claim();
        IExitMarket.GatewayConfig memory cfg = market.getGatewayConfig(address(gateway));
        LegacyRootVerifier v = LegacyRootVerifier(address(cfg.verifier));
        ILegacyRollup r = ILegacyRollup(cfg.rollup);

        assertGe(c.nodeNum, r.firstUnresolvedNode(), "fixture node must still be pending: regenerate the fixture");
        uint256 depth = 1;
        for (uint64 n = r.getNode(c.nodeNum).prevNum; n != r.latestConfirmed() && depth < 512; n = r.getNode(n).prevNum) ++depth;
        uint256 gasBefore = gasleft();
        (bool valid, bool pending, uint64 deadline) = v.verifyRoot(cfg.rollup, cfg.outbox, c.sendRoot, c.nodeNum, c.blockHash);
        uint256 walkGas = gasBefore - gasleft();
        emit log_named_uint("pending levels walked", depth);
        emit log_named_uint("verifyRoot gas (cold)", walkGas);
        assertTrue(valid);
        assertTrue(pending);
        assertEq(deadline, r.getNode(c.nodeNum).deadlineBlock);

        // A dispute: when a validator creates a rival child, RollupCore sets the parent's latestChildNumber to it.
        // Only that field of the live parent node is changed.
        uint64 rival = r.latestNodeCreated() + 1; // the next node a disputing validator would create
        uint64 parentNum = r.getNode(c.nodeNum).prevNum;
        LegacyNode memory parent = r.getNode(parentNum);
        parent.latestChildNumber = rival;
        vm.mockCall(cfg.rollup, abi.encodeCall(ILegacyRollup.getNode, (parentNum)), abi.encode(parent));
        (valid,,) = v.verifyRoot(cfg.rollup, cfg.outbox, c.sendRoot, c.nodeNum, c.blockHash);
        assertFalse(valid, "a contested node must not verify");
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

    /// @dev The fixture reads state of the gateway, the rollup and the Outbox at FORK_BLOCK: ask for each directly.
    function _servesForkBlock(string memory rpc) private returns (bool) {
        address[3] memory touched = [XaiExitFixture.PARENT_GATEWAY, XAI_ROLLUP, XAI_OUTBOX];
        string memory atBlock = _hexQuantity(XaiExitFixture.FORK_BLOCK);
        for (uint256 i = 0; i < touched.length; ++i) {
            string memory params = string.concat('["', vm.toString(touched[i]), '","0x0","', atBlock, '"]');
            try vm.rpc(rpc, "eth_getStorageAt", params) returns (bytes memory word) {
                if (word.length != 32) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    /// @dev JSON-RPC quantity: 0x-prefixed hex without leading zeros.
    function _hexQuantity(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0x0";
        uint256 digits = 0;
        for (uint256 v = value; v != 0; v >>= 4) ++digits;
        bytes16 hex16 = "0123456789abcdef";
        bytes memory out = new bytes(digits + 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = digits + 1; i > 1; --i) {
            out[i] = hex16[value & 0xf];
            value >>= 4;
        }
        return string(out);
    }
}