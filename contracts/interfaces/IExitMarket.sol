// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRootVerifier} from "./IRootVerifier.sol";

/// @notice Everything a seller supplies to prove a pending withdrawal (built by scripts/lib/exitProof.ts,
///         encoded by scripts/lib/hookData.ts).
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

/// @notice A verified exit, as recorded by the market and handed to buyers.
struct ExitRecord {
    address gateway;
    uint256 exitNum;
    address initialDestination;
    address l1Token;
    uint256 amount;
    uint256 index; // position in the child chain's send tree (Outbox spent-bitmap key)
    bytes32 itemHash; // Outbox item hash of the withdrawal: lets anyone re-prove it against a confirmed root
    bytes32 sendRoot; // root the exit was proven against at verification time
    uint64 nodeNum;
    bytes32 blockHash;
    bool pending; // true = proven against an unconfirmed node
    uint64 deadlineBlock; // L1 block after which the node can confirm (0 if already confirmed)
}

/// @notice Instant-exit counterparty (e.g. ExitVault). Called by the market inside the seller's
///         transferExitAndCall; must transfer the price in the market's payment token to the market.
interface IExitBuyer {
    /// @param exit verified exit being sold; ownership is redirected to the buyer right after this call
    /// @return price amount of payment token transferred to the market (the market measures the real delta)
    function buyExit(ExitRecord calldata exit) external returns (uint256 price);
}

interface IExitMarket {
    /// @notice First field of the hook data: abi.encode(uint8(Action), ExitClaim, params).
    ///         LIST params = abi.encode(uint256 price, uint64 expiry);
    ///         SELL_TO_BUYER params = abi.encode(address buyer, uint256 minPayout).
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

    /// @notice A fixed-price listing. The market is the exit's owner while Listed.
    struct Listing {
        ExitRecord exit;
        address seller;
        uint256 price;
        uint16 feeBps; // snapshotted at listing time
        uint64 expiry;
        Status status;
    }

    /// @notice Verification sources derived from a gateway and frozen when it is first allowed.
    struct GatewayConfig {
        address childGateway;
        address outbox;
        address rollup;
        IRootVerifier verifier;
        bool allowed; // new listings, sales and buys accepted
        bool known; // ever allowed: cancel/settle keep working after disallow
    }

    event GatewayAllowed(address indexed gateway, address childGateway, address outbox, address rollup, address verifier);
    event GatewayDisallowed(address indexed gateway);
    event FeeUpdated(uint16 feeBps, address feeRecipient);
    event FeesWithdrawn(address indexed recipient, uint256 amount);
    /// @notice Full verified record, emitted for every exit the market accepts (indexers/keepers need it).
    event ExitVerified(bytes32 indexed id, ExitRecord exit);
    event ExitListed(
        bytes32 indexed id, address indexed seller, address indexed l1Token, uint256 amount, uint256 price, uint64 expiry, bool pending
    );
    event ExitBought(bytes32 indexed id, address indexed buyer, uint256 price, uint256 fee);
    event ExitSoldToBuyer(bytes32 indexed id, address indexed seller, address indexed buyer, uint256 price, uint256 fee);
    event ListingCancelled(bytes32 indexed id);
    event ListingSettled(bytes32 indexed id, uint256 amount);
    /// @notice Emitted because the gateway's own WithdrawRedirected events arrive out of order on instant sales.
    event ExitOwnerChanged(bytes32 indexed id, address indexed newOwner);

    error ZeroAddress();
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
    /// @notice The exit's Outbox slot is not spent by THIS exit under a confirmed root.
    error ExitNotPaidOut(uint256 index);
    /// @notice The slot is spent but not provably by this exit: settle with a proof against a confirmed root.
    error ExitNeedsSettlement(uint256 index);
    error FeeTooHigh(uint16 feeBps);
    error BadExpiry();

    /// @notice Allowlist a parent-chain gateway. Derives inbox -> bridge -> rollup -> outbox from it and
    ///         freezes those sources and `verifier` on first allow.
    /// @dev Owner-trusted: the owner chooses which gateways and which root verifier are trusted.
    function allowGateway(address gateway, IRootVerifier verifier) external;

    /// @notice Stop accepting new listings, sales and buys for `gateway`; cancel/settle keep working.
    function disallowGateway(address gateway) external;

    /// @notice Set the fee (max MAX_FEE_BPS) for future listings/sales and its recipient.
    function setFee(uint16 feeBps, address feeRecipient) external;

    /// @notice Buy a listed exit; the exit is redirected to msg.sender.
    /// @param maxPrice front-running guard: revert if the listing price is higher
    function buy(bytes32 id, uint256 maxPrice) external;

    /// @notice Seller cancels anytime; anyone may cancel after expiry. The exit returns to the seller.
    ///         If the exit already paid out to the market, the tokens are forwarded instead (settlement).
    function cancel(bytes32 id) external;

    /// @notice Forward the tokens of a listed exit that was executed while the market held it.
    /// @param confirmedRoot a confirmed Outbox root containing the exit (use exit.sendRoot once confirmed)
    /// @param proof merkle proof of exit.itemHash at exit.index in `confirmedRoot` (empty if == exit.sendRoot)
    function settle(bytes32 id, bytes32 confirmedRoot, bytes32[] calldata proof) external;

    /// @notice Send accrued fees to the fee recipient. Callable by anyone.
    function withdrawFees() external;

    /// @return id keccak256(abi.encode(gateway, exitNum, initialDestination)): unique per exit
    function listingId(address gateway, uint256 exitNum, address initialDestination) external pure returns (bytes32);

    function getListing(bytes32 id) external view returns (Listing memory);

    /// @notice True if the exit is unspent and its root is confirmed or its node is still unresolved.
    /// @dev Reverts GatewayUnknown for a gateway that was never allowed.
    function isExitLive(ExitRecord calldata exit) external view returns (bool);

    /// @notice True only if the exit's Outbox slot is spent AND the slot provably holds this exit's item
    ///         under a confirmed root, i.e. the exit's tokens were actually paid to its owner.
    /// @dev Reverts GatewayUnknown for a gateway that was never allowed.
    function isExitPaidOut(ExitRecord calldata exit, bytes32 confirmedRoot, bytes32[] calldata proof)
        external
        view
        returns (bool);

    /// @notice Fraud proof that `exit` does not exist: a CONFIRMED root holds a different item with the same
    ///         gateway and exitNum. Exit numbers are unique per child gateway, so the claimed exit was fake.
    /// @param canonical the real withdrawal for exit.exitNum (fields, index, proof, confirmed sendRoot);
    ///        its nodeNum/blockHash are ignored and its initialDestination may differ from exit's
    /// @dev Reverts GatewayUnknown for a gateway that was never allowed.
    function isExitDisproven(ExitRecord calldata exit, ExitClaim calldata canonical) external view returns (bool);

    function getGatewayConfig(address gateway) external view returns (GatewayConfig memory);

    function paymentToken() external view returns (address);
}
