import {
  encodeAbiParameters,
  getAbiItem,
  keccak256,
  parseAbiParameters,
  type Address,
  type ContractFunctionReturnType,
  type Hex,
  type PublicClient,
} from "viem";
import { exitMarketAbi } from "./abis.ts";
import { netOfMarketFee } from "./hookData.ts";
import { getLogsChunked } from "./logScan.ts";

/** Mirrors IExitMarket.Status. */
export const ListingStatus = { None: 0, Listed: 1, Sold: 2, Cancelled: 3, Settled: 4 } as const;

/** A listing as ExitMarket.getListing returns it. */
export type MarketListing = ContractFunctionReturnType<typeof exitMarketAbi, "view", "getListing">;

export interface OpenListing {
  id: Hex;
  listing: MarketListing;
  /** ExitMarket.isExitLive: unspent, and its root still verifies (for a pending root: no rival on its node chain). */
  live: boolean;
}

const EXIT_LISTED = getAbiItem({ abi: exitMarketAbi, name: "ExitListed" });
/** Arbitrum Sepolia getLogs span (a failing chunk is bisected). */
const LOG_CHUNK = 1_000_000n;
const SECONDS_PER_L1_BLOCK = 12n;
const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
const BPS = 10_000n;

/** The market's id for an exit; mirrors contracts/libraries/ExitKeys.sol. */
export function listingIdOf(gateway: Address, exitNum: bigint, initialDestination: Address): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, uint256, address"), [gateway, exitNum, initialDestination]),
  );
}

/**
 * Every listing of `market` that is still open, newest first, read live from chain: ExitListed logs since
 * `fromBlock`, then getListing (status, price, expiry) and isExitLive for each.
 */
export async function loadOpenListings(client: PublicClient, market: Address, fromBlock: bigint): Promise<OpenListing[]> {
  const head = await client.getBlockNumber();
  const { logs } = await getLogsChunked(
    (from, to) => client.getLogs({ address: market, event: EXIT_LISTED, fromBlock: from, toBlock: to }),
    fromBlock,
    head,
    LOG_CHUNK,
  );
  // An exit can be listed, cancelled and listed again under the same id: keep each id once.
  const ids = [...new Set(logs.map((l) => l.args.id).filter((id): id is Hex => id !== undefined))].reverse();
  const listings = await Promise.all(
    ids.map((id) => client.readContract({ address: market, abi: exitMarketAbi, functionName: "getListing", args: [id] })),
  );
  const open = ids
    .map((id, i) => ({ id, listing: listings[i] }))
    .filter(({ listing }) => listing.status === ListingStatus.Listed);
  const live = await Promise.all(
    open.map(({ listing }) =>
      client
        .readContract({ address: market, abi: exitMarketAbi, functionName: "isExitLive", args: [listing.exit] })
        .catch(() => false),
    ),
  );
  return open.map((entry, i) => ({ ...entry, live: live[i] }));
}

export interface ListingEconomics {
  /** What the seller receives when the listing sells: price minus the fee snapshotted at listing time. */
  sellerNet: bigint;
  /** Face value minus price: what the buyer gains at payout (negative for a listing above face value). */
  discount: bigint;
  /** Seconds until the exit's node can confirm (0 once it can, or for an exit proven against a confirmed root). */
  secondsToPayout: bigint;
  /** The buyer's annualised return in basis points; undefined without a discount or a wait to annualise over. */
  aprBps: bigint | undefined;
}

/** What a listing means for both sides, given the current parent-chain (L1) block. */
export function listingEconomics(
  listing: Pick<MarketListing, "price" | "feeBps"> & { exit: Pick<MarketListing["exit"], "amount" | "deadlineBlock"> },
  currentL1Block: bigint,
): ListingEconomics {
  const { price, feeBps, exit } = listing;
  const discount = exit.amount - price;
  const blocks = exit.deadlineBlock > currentL1Block ? exit.deadlineBlock - currentL1Block : 0n;
  const secondsToPayout = blocks * SECONDS_PER_L1_BLOCK;
  const aprBps =
    discount > 0n && secondsToPayout > 0n && price > 0n
      ? (discount * BPS * SECONDS_PER_YEAR) / (price * secondsToPayout)
      : undefined;
  return { sellerNet: netOfMarketFee(price, feeBps), discount, secondsToPayout, aprBps };
}
