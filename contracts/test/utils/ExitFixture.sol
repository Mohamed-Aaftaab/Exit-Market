// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ExitLeaf} from "../../libraries/ExitLeaf.sol";
import {ExitClaim, ExitRecord, IExitMarket, PayoutProof} from "../../interfaces/IExitMarket.sol";
import {ExitMarket} from "../../ExitMarket.sol";
import {LegacyRootVerifier} from "../../verifiers/LegacyRootVerifier.sol";
import {
    MockBridge,
    MockERC20,
    MockExtendedGateway,
    MockInbox,
    MockLegacyRollup,
    MockOutbox
} from "../mocks/MockArbitrum.sol";

/// @dev Shared test base: full mock gateway stack + market + verifier + real merkle trees over withdrawals.
abstract contract ExitFixture is Test {
    uint64 internal constant NODE = 100;
    uint64 internal constant CONFIRM_BLOCKS = 150;
    bytes32 internal constant BLOCK_HASH = keccak256("l2 block hash");
    address internal constant CHILD_GATEWAY = address(0xC0FFEE);
    uint16 internal constant FEE_BPS = 50;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant AMOUNT = 10_000e6;

    /// @dev A withdrawal that exists in the send tree, plus the claim a seller would submit.
    struct Withdrawal {
        address gateway;
        uint256 exitNum;
        ExitClaim claim;
    }

    MockERC20 internal usdg;
    bool internal wethLeaves; // build leaves with callvalue = amount, like the WETH gateway
    MockERC20 internal exitToken; // l1Token of created withdrawals (defaults to usdg)
    MockOutbox internal outbox;
    MockLegacyRollup internal rollup;
    MockBridge internal bridge;
    MockInbox internal inbox;
    MockExtendedGateway internal gateway;
    ExitMarket internal market;
    LegacyRootVerifier internal verifier;

    address internal owner;
    address internal feeRecipient;
    address internal seller;
    address internal buyer;
    address internal stranger;

    function setUp() public virtual {
        vm.roll(1_000_000);
        vm.warp(1_700_000_000);
        owner = makeAddr("owner");
        feeRecipient = makeAddr("feeRecipient");
        seller = makeAddr("seller");
        buyer = makeAddr("buyer");
        stranger = makeAddr("stranger");

        usdg = new MockERC20("Global Dollar", "USDG", 6);
        exitToken = usdg;
        outbox = new MockOutbox();
        rollup = new MockLegacyRollup(address(outbox));
        bridge = new MockBridge(address(rollup));
        inbox = new MockInbox(address(bridge));
        gateway = new MockExtendedGateway(CHILD_GATEWAY, address(inbox));
        verifier = new LegacyRootVerifier();
        market = new ExitMarket(address(usdg), owner, FEE_BPS, feeRecipient);

        vm.prank(owner);
        market.allowGateway(address(gateway), verifier);
    }

    // ------------------------------------------------------------------ funding

    function _fund(address who, address spender, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.prank(who);
        usdg.approve(spender, type(uint256).max);
    }

    // ------------------------------------------------------------------ withdrawals

    function _createWithdrawals(uint256 n, address dest, uint256 amount) internal returns (Withdrawal[] memory) {
        return _createOn(gateway, NODE, 1, n, dest, amount);
    }

    /// @dev Builds `n` withdrawals on `gw` (exitNum firstExitNum..), a real merkle tree over their item hashes,
    ///      and publishes the root as an unresolved rollup node `nodeNum`.
    function _createOn(
        MockExtendedGateway gw,
        uint64 nodeNum,
        uint256 firstExitNum,
        uint256 n,
        address dest,
        uint256 amount
    ) internal returns (Withdrawal[] memory) {
        return _createFrom(gw, nodeNum, firstExitNum, n, dest, dest, amount);
    }

    /// @dev Like _createOn, but the child-chain sender (`from_`) differs from the initial destination `dest`,
    ///      e.g. a user withdrawing to a router contract.
    function _createFrom(
        MockExtendedGateway gw,
        uint64 nodeNum,
        uint256 firstExitNum,
        uint256 n,
        address from_,
        address dest,
        uint256 amount
    ) internal returns (Withdrawal[] memory ws) {
        bytes32[] memory items = new bytes32[](n);
        ExitClaim[] memory claims = new ExitClaim[](n);
        for (uint256 i = 0; i < n; ++i) {
            ExitLeaf.Leaf memory leaf = ExitLeaf.Leaf({
                childGateway: gw.counterpartGateway(),
                parentGateway: address(gw),
                l1Token: address(exitToken),
                from: from_,
                initialDestination: dest,
                amount: amount,
                exitNum: firstExitNum + i,
                l2Block: 1000 + i,
                l1Block: 500 + i,
                l2Timestamp: 1_700_000_000 + i
            });
            items[i] = _leafHash(leaf);
            claims[i] = ExitClaim({
                initialDestination: dest,
                l1Token: address(exitToken),
                from: from_,
                amount: amount,
                l2Block: leaf.l2Block,
                l1Block: leaf.l1Block,
                l2Timestamp: leaf.l2Timestamp,
                index: i,
                proof: new bytes32[](0),
                sendRoot: bytes32(0),
                nodeNum: nodeNum,
                blockHash: BLOCK_HASH
            });
        }

        (bytes32 root, bytes32[][] memory proofs) = _buildTree(items);
        _publishPending(root, nodeNum);

        ws = new Withdrawal[](n);
        for (uint256 i = 0; i < n; ++i) {
            claims[i].proof = proofs[i];
            claims[i].sendRoot = root;
            ws[i] = Withdrawal({gateway: address(gw), exitNum: firstExitNum + i, claim: claims[i]});
        }
    }

    /// @dev Publishes `root` as unresolved node `nodeNum` on the honest chain (see MockLegacyRollup.publishNodeAt).
    function _publishPending(bytes32 root, uint64 nodeNum) internal {
        rollup.publishNodeAt(nodeNum, keccak256(abi.encodePacked(BLOCK_HASH, root)), uint64(block.number) + CONFIRM_BLOCKS);
    }

    /// @dev Publishes `root` as unresolved node `nodeNum` under an explicit parent, e.g. a rival sibling.
    function _publishChild(bytes32 root, uint64 nodeNum, uint64 parent) internal {
        rollup.publishChildAt(
            nodeNum, parent, keccak256(abi.encodePacked(BLOCK_HASH, root)), uint64(block.number) + CONFIRM_BLOCKS
        );
    }

    /// @dev Pairwise keccak like MerkleLib; leaves are keccak(item); padded with zero hashes to a power of two.
    function _buildTree(bytes32[] memory items) internal pure returns (bytes32 root, bytes32[][] memory proofs) {
        uint256 n = items.length;
        uint256 size = 1;
        uint256 depth = 0;
        while (size < n) {
            size <<= 1;
            ++depth;
        }

        bytes32[][] memory layers = new bytes32[][](depth + 1);
        layers[0] = new bytes32[](size);
        for (uint256 i = 0; i < n; ++i) {
            layers[0][i] = keccak256(abi.encodePacked(items[i]));
        }
        for (uint256 d = 1; d <= depth; ++d) {
            layers[d] = new bytes32[](size >> d);
            for (uint256 j = 0; j < (size >> d); ++j) {
                layers[d][j] = keccak256(abi.encodePacked(layers[d - 1][2 * j], layers[d - 1][2 * j + 1]));
            }
        }
        root = layers[depth][0];

        proofs = new bytes32[][](n);
        for (uint256 i = 0; i < n; ++i) {
            proofs[i] = new bytes32[](depth);
            uint256 idx = i;
            for (uint256 d = 0; d < depth; ++d) {
                proofs[i][d] = layers[d][idx ^ 1];
                idx >>= 1;
            }
        }
    }

    // ------------------------------------------------------------------ exit actions

    function _hookData(IExitMarket.Action action, ExitClaim memory claim, bytes memory params)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(action, claim, params);
    }

    /// @dev `caller` (the current exit owner) redirects the exit to `newDest` with hook data.
    function _transfer(
        Withdrawal memory w,
        address caller,
        address newDest,
        IExitMarket.Action action,
        bytes memory params
    ) internal {
        bytes memory data = _hookData(action, w.claim, params);
        vm.prank(caller);
        MockExtendedGateway(w.gateway).transferExitAndCall(w.exitNum, w.claim.initialDestination, newDest, "", data);
    }

    function _list(Withdrawal memory w, address who, uint256 price) internal returns (bytes32) {
        return _listUntil(w, who, price, uint64(block.timestamp + 1 days));
    }

    function _listUntil(Withdrawal memory w, address who, uint256 price, uint64 expiry) internal returns (bytes32) {
        _transfer(w, who, address(market), IExitMarket.Action.LIST, abi.encode(price, expiry));
        return _id(w);
    }

    function _sellTo(Withdrawal memory w, address who, address to, uint256 minPayout) internal {
        _transfer(w, who, address(market), IExitMarket.Action.SELL_TO_BUYER, abi.encode(to, minPayout));
    }

    function _id(Withdrawal memory w) internal view returns (bytes32) {
        return market.listingId(w.gateway, w.exitNum, w.claim.initialDestination);
    }

    function _ownerOf(Withdrawal memory w) internal view returns (address target) {
        (target,) = MockExtendedGateway(w.gateway).getExternalCall(w.exitNum, w.claim.initialDestination, "");
    }

    /// @dev Outbox executes the exit: marks it spent and pays the current owner.
    function _execute(Withdrawal memory w) internal {
        MockExtendedGateway(w.gateway)
            .simulateExecute(
                outbox, w.claim.index, w.exitNum, w.claim.initialDestination, MockERC20(w.claim.l1Token), w.claim.amount
            );
    }

    /// @dev The ExitRecord the market builds for a pending exit (deadline read from the rollup node).
    function _record(Withdrawal memory w) internal view returns (ExitRecord memory) {
        return ExitRecord({
            gateway: w.gateway,
            exitNum: w.exitNum,
            initialDestination: w.claim.initialDestination,
            l1Token: w.claim.l1Token,
            amount: w.claim.amount,
            index: w.claim.index,
            itemHash: _leafHash(_leafOf(w)),
            sendRoot: w.claim.sendRoot,
            nodeNum: w.claim.nodeNum,
            blockHash: w.claim.blockHash,
            pending: true,
            deadlineBlock: rollup.getNode(w.claim.nodeNum).deadlineBlock
        });
    }

    /// @dev Root becomes confirmed in the Outbox; the rollup node is irrelevant afterwards.
    function _confirm(Withdrawal memory w) internal {
        outbox.setRoot(w.claim.sendRoot, keccak256("confirmed"));
    }

    /// @dev Same item at the same index, committed under a DIFFERENT send root (e.g. the child chain's
    ///      canonical tree after the node the exit was first proven against was rejected).
    ///      The new root is registered as confirmed in the Outbox.
    function _recommitConfirmed(Withdrawal memory w) internal returns (bytes32 root, bytes32[] memory proof) {
        return _recommitConfirmedAt(w, w.claim.index);
    }

    /// @dev Like _recommitConfirmed but the item sits at `idx` in the canonical tree (may differ from the proven index).
    function _recommitConfirmedAt(Withdrawal memory w, uint256 idx)
        internal
        returns (bytes32 root, bytes32[] memory proof)
    {
        bytes32[] memory items = new bytes32[](idx + 1);
        for (uint256 i = 0; i < idx; ++i) {
            items[i] = keccak256(abi.encode("filler", i));
        }
        items[idx] = _record(w).itemHash;
        bytes32[][] memory proofs;
        (root, proofs) = _buildTree(items);
        proof = proofs[idx];
        outbox.setRoot(root, keccak256("confirmed2"));
    }

    /// @dev Payout proof for the (index, root) the exit was proven against at verification time.
    function _ownPayout(Withdrawal memory w) internal pure returns (PayoutProof memory) {
        return PayoutProof(w.claim.index, w.claim.sendRoot, new bytes32[](0));
    }

    function _noProof() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    function _leafHash(ExitLeaf.Leaf memory leaf) internal view returns (bytes32) {
        return wethLeaves ? ExitLeaf.itemHashWithValue(leaf, leaf.amount) : ExitLeaf.itemHash(leaf);
    }

    function _leafOf(Withdrawal memory w) internal view returns (ExitLeaf.Leaf memory) {
        return ExitLeaf.Leaf({
            childGateway: MockExtendedGateway(w.gateway).counterpartGateway(),
            parentGateway: w.gateway,
            l1Token: w.claim.l1Token,
            from: w.claim.from,
            initialDestination: w.claim.initialDestination,
            amount: w.claim.amount,
            exitNum: w.exitNum,
            l2Block: w.claim.l2Block,
            l1Block: w.claim.l1Block,
            l2Timestamp: w.claim.l2Timestamp
        });
    }

    function _fee(uint256 price) internal pure returns (uint256) {
        return (price * FEE_BPS) / BPS;
    }
}
