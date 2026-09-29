// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Everything a seller supplies to prove a pending withdrawal (built by scripts/lib/exitProof.ts).
/// @dev exitNum and the parent gateway are NOT here: they come from the gateway's hook call.
struct ExitClaim {
    address initialDestination;
    address l1Token;
    address from;
    uint256 amount;
    uint256 l2Block;
    uint256 l1Block;
    uint256 l2Timestamp;
    uint256 index;
    bytes32[] proof;
    bytes32 sendRoot;
    uint64 nodeNum; // ignored when sendRoot is already confirmed in the Outbox
    bytes32 blockHash; // ignored when sendRoot is already confirmed in the Outbox
}

/// @notice A verified exit. Stored by the market; passed to buyers.
struct ExitRecord {
    address gateway;
    uint256 exitNum;
    address initialDestination;
    address l1Token;
    uint256 amount;
    uint256 index;
    bytes32 sendRoot;
    uint64 nodeNum;
    bytes32 blockHash;
    bool pending; // true = proven against an unconfirmed node
    uint64 deadlineBlock; // L1 block after which the node can confirm (0 if already confirmed)
}

/// @notice Instant-exit counterparty (e.g. ExitVault). Called by the market inside the seller's
///         transferExitAndCall; must transfer the returned price in the market's payment token to the market.
interface IExitBuyer {
    /// @return price amount of payment token transferred to the market
    function buyExit(ExitRecord calldata exit) external returns (uint256 price);
}

/// @notice Checks that a send root is authentic for a given rollup (legacy now, BOLD later).
interface IRootVerifier {
    /// @return valid root is confirmed, or belongs to a node that is still unresolved
    /// @return pending true if the root is not yet confirmed
    /// @return deadlineBlock L1 block after which the node can be confirmed (0 if confirmed)
    function verifyRoot(address rollup, address outbox, bytes32 sendRoot, uint64 nodeNum, bytes32 blockHash)
        external
        view
        returns (bool valid, bool pending, uint64 deadlineBlock);
}

interface IExitMarket {
    enum Action {
        LIST,
        SELL_TO_BUYER
    }

    enum Status {
        None,
        Listed,
        Sold,
        Cancelled,
        Settled
    }

    struct Listing {
        ExitRecord exit;
        address seller;
        uint256 price;
        uint16 feeBps; // snapshotted at listing time
        uint64 expiry;
        Status status;
    }

    struct GatewayConfig {
        address childGateway;
        address outbox;
        address rollup;
        IRootVerifier verifier;
        bool allowed; // new listings/sales accepted
        bool known; // ever allowed: cancel/settle keep working after disallow
    }

    event GatewayAllowed(address indexed gateway, address childGateway, address outbox, address rollup, address verifier);
    event GatewayDisallowed(address indexed gateway);
    event FeeUpdated(uint16 feeBps, address feeRecipient);
    event ExitListed(
        bytes32 indexed id, address indexed seller, address indexed l1Token, uint256 amount, uint256 price, uint64 expiry, bool pending
    );
    event ExitBought(bytes32 indexed id, address indexed buyer, uint256 price, uint256 fee);
    event ExitSoldToBuyer(bytes32 indexed id, address indexed seller, address indexed buyer, uint256 price, uint256 fee);
    event ListingCancelled(bytes32 indexed id);
    event ListingSettled(bytes32 indexed id, uint256 amount);
    /// @notice Emitted because the gateway's own WithdrawRedirected events arrive out of order on instant sales.
    event ExitOwnerChanged(bytes32 indexed id, address indexed newOwner);

    error GatewayNotAllowed(address gateway);
    error GatewayUnknown(address gateway);
    /// @notice Re-allowing a gateway must not change its snapshotted verification sources.
    error GatewaySourcesChanged(address gateway);
    error OutboxNotAllowed(address outbox);
    error InvalidRoot(bytes32 sendRoot, uint64 nodeNum);
    error ProofMismatch(bytes32 computed, bytes32 claimed);
    error ExitAlreadySpent(uint256 index);
    error ExitNotHeld();
    error ListingExists(bytes32 id);
    error NotListed(bytes32 id);
    error ListingExpired(bytes32 id);
    error PriceAboveMax(uint256 price, uint256 maxPrice);
    error PayoutBelowMin(uint256 payout, uint256 minPayout);
    error ZeroPrice();
    error NotSeller();
    error ExitNotSpent(uint256 index);
    error FeeTooHigh(uint16 feeBps);
    error BadExpiry();

    function allowGateway(address gateway, IRootVerifier verifier) external;

    function disallowGateway(address gateway) external;

    function setFee(uint16 feeBps, address feeRecipient) external;

    /// @notice Buy a listed exit; the exit is redirected to msg.sender.
    function buy(bytes32 id, uint256 maxPrice) external;

    /// @notice Seller cancels anytime; anyone may cancel after expiry. Exit returns to the seller.
    function cancel(bytes32 id) external;

    /// @notice If a listed exit was executed while the market held it, forward the tokens to the seller.
    function settle(bytes32 id) external;

    function withdrawFees() external;

    function listingId(address gateway, uint256 exitNum, address initialDestination) external pure returns (bytes32);

    function getListing(bytes32 id) external view returns (Listing memory);

    /// @notice True if a pending exit's node is still unresolved (or its root is confirmed) and it is unspent.
    function isExitLive(ExitRecord calldata exit) external view returns (bool);

    /// @notice True once the exit has been executed through the Outbox.
    function isExitSpent(ExitRecord calldata exit) external view returns (bool);

    function getGatewayConfig(address gateway) external view returns (GatewayConfig memory);

    function paymentToken() external view returns (address);
}

/// @notice ERC-4626 USDG vault that buys USDG exits instantly at a time-based discount.
interface IExitVault is IExitBuyer {
    event ExitPurchased(bytes32 indexed key, uint256 amount, uint256 price);
    event ExitCollected(bytes32 indexed key, uint256 amount);
    event ExitWrittenOff(bytes32 indexed key, uint256 amount);
    event ParamsUpdated(uint16 baseFeeBps, uint16 aprBps, uint256 maxExitAmount, bool acceptPending);

    error OnlyMarket();
    error WrongToken(address l1Token);
    error PendingNotAccepted();
    error ExitTooLarge(uint256 amount);
    error InsufficientLiquidity(uint256 needed, uint256 idle);
    error UnknownExit(bytes32 key);
    error ExitStillLive(bytes32 key);
    error BadParams();

    /// @notice price = amount - amount*baseFeeBps/1e4 - amount*aprBps*secondsToConfirm/(1e4*365 days),
    ///         secondsToConfirm = max(deadlineBlock - block.number, 0) * 12 (block.number is L1 on Arbitrum).
    function quote(ExitRecord calldata exit) external view returns (uint256 price);

    /// @notice Permissionless: after the exit executed (tokens arrived), move face value from outstanding to idle.
    function collect(ExitRecord calldata exit) external;

    /// @notice Permissionless: if the exit's node was rejected (not live, not spent), realize the loss.
    function writeOff(ExitRecord calldata exit) external;

    function setParams(uint16 baseFeeBps, uint16 aprBps, uint256 maxExitAmount, bool acceptPending) external;

    function idleAssets() external view returns (uint256);

    function outstandingFace() external view returns (uint256);
}
