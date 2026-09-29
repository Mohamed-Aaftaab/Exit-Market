// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitClaim, PayoutProof} from "./IExitMarket.sol";

/// @notice Gasless "sign-once" exits. A user withdraws on the child chain with `to = router`, so the router
///         owns the exit from birth. The user then signs a SellOrder off-chain (no gas on the parent chain);
///         any relayer settles it: the router redirects the exit into ExitMarket's SELL_TO_BUYER path, pays
///         the relayer its fee and forwards the rest to the seller.
/// @dev The seller is `claim.from` (the child-chain sender), which ExitMarket proves as part of the leaf.
///      Only EOA signatures (ECDSA) are accepted: an EOA key controls the same address on every chain,
///      whereas a contract at the same address on the parent chain may have a different owner.
interface IExitIntentRouter {
    /// @param gateway parent-chain gateway of the withdrawal
    /// @param exitNum exit number of the withdrawal (unique per gateway)
    /// @param buyer IExitBuyer to sell to (e.g. ExitVault)
    /// @param minProceeds minimum payment-token amount the seller must receive after all fees
    /// @param relayerFee payment-token amount paid to whoever submits the settlement
    /// @param deadline unix time after which the order is void
    struct SellOrder {
        address gateway;
        uint256 exitNum;
        address buyer;
        uint256 minProceeds;
        uint256 relayerFee;
        uint64 deadline;
    }

    event IntentSettled(
        bytes32 indexed id, address indexed seller, address indexed relayer, uint256 proceeds, uint256 relayerFee
    );
    event ExitReclaimed(bytes32 indexed id, address indexed seller);
    /// @notice A router-owned exit was executed before settlement; its tokens were forwarded to the sender.
    event ExecutedExitRecovered(bytes32 indexed id, address indexed seller, address token, uint256 amount);

    error NotRouterExit();
    error OrderExpired(uint64 deadline);
    error BadSignature();
    error ProceedsBelowMin(uint256 received, uint256 required);
    error GatewayUnknown(address gateway);
    error ProofMismatch(bytes32 computed, bytes32 claimed);
    error InvalidRoot(bytes32 sendRoot, uint64 nodeNum);
    error ReclaimLocked(uint256 unlockTime);
    error ExitNotPaidOut(uint256 index);
    error AlreadyRecovered(bytes32 itemHash);

    /// @notice Settle a signed order. Callable by anyone (the relayer is msg.sender and earns relayerFee).
    /// @return proceeds payment-token amount sent to the seller
    function settle(ExitClaim calldata claim, SellOrder calldata order, bytes calldata signature)
        external
        returns (uint256 proceeds);

    /// @notice Return a router-owned exit to its proven child-chain sender, who then claims it the normal way.
    ///         Proves the leaf (value 0 or WETH-style value = amount) against a valid root. Callable by the
    ///         sender at any time, or by anyone RECLAIM_GRACE after the withdrawal (so relayers can settle
    ///         signed orders without being griefed by third-party reclaims).
    function reclaim(address gateway, uint256 exitNum, ExitClaim calldata claim) external;

    /// @notice Permissionless: if a router-owned exit was executed through the Outbox before being settled, the
    ///         tokens sit in the router; forward them to the proven sender. Requires the payout slot to hold
    ///         this exit's item under a confirmed root (same rule as IExitMarket.isExitPaidOut). Once per exit.
    function recoverExecuted(address gateway, uint256 exitNum, ExitClaim calldata claim, PayoutProof calldata payout)
        external;

    /// @notice EIP-712 digest the seller signs for `order`.
    function orderDigest(SellOrder calldata order) external view returns (bytes32);

    function market() external view returns (address);

    function paymentToken() external view returns (address);
}
