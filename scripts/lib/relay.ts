import {
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  parseAbi,
} from "viem";
import { exitIntentRouterAbi, exitMarketAbi, exitVaultAbi } from "./abis.ts";
import { InvalidWithdrawalError, NotYetAssertedError, buildExitProof } from "./exitProof.ts";
import { claimOf } from "./hookData.ts";

/** Mirrors IExitIntentRouter.SellOrder (field order matters for EIP-712). */
export interface SellOrder {
  gateway: Address;
  exitNum: bigint;
  buyer: Address;
  minProceeds: bigint;
  relayerFee: bigint;
  deadline: bigint;
}

export const SELL_ORDER_TYPES = {
  SellOrder: [
    { name: "gateway", type: "address" },
    { name: "exitNum", type: "uint256" },
    { name: "buyer", type: "address" },
    { name: "minProceeds", type: "uint256" },
    { name: "relayerFee", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

/** EIP-712 domain of ExitIntentRouter on `chainId`. */
export function routerDomain(router: Address, chainId: number) {
  return { name: "ExitIntentRouter", version: "1", chainId, verifyingContract: router } as const;
}

/**
 * The router's ABI plus every custom error that can surface inside settle(): the market's and the vault's revert
 * data bubbles up through the gateway call, and viem can only name an error it has in the ABI.
 */
const settleAbi = [
  ...exitIntentRouterAbi,
  ...exitMarketAbi.filter((item) => item.type === "error"),
  ...exitVaultAbi.filter((item) => item.type === "error"),
] as const;

const gatewayOwnerAbi = parseAbi([
  "function getExternalCall(uint256 exitNum, address initialDestination, bytes initialData) view returns (address target, bytes data)",
]);

export type RelayResult =
  | { status: "waiting"; reason: string }
  | { status: "settled"; txHash: Hex }
  /** The router no longer owns the exit: another relayer settled it, or the seller reclaimed it. */
  | { status: "done-elsewhere"; owner: Address };

/** A settlement the chain rejected, with the contract's reason (a custom error name or a revert string). */
export class SettlementRevertedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Settlement would revert: ${reason}`);
    this.name = "SettlementRevertedError";
    this.reason = reason;
  }
}

/**
 * What a seller is waiting for when a settlement reverts for a reason that clears up by itself, or undefined when the
 * order itself is at fault (bad signature, expired, below the vault's minimum...) and needs the seller.
 *   InsufficientLiquidity / TooManyOpenPositions: the vault refills as the exits it holds clear their window;
 *   InvalidRoot: the node the proof uses is disputed (or not provable yet); each retry rebuilds the proof, and once a
 *     covering node confirms, its root works;
 *   PendingNotAccepted: the vault is not buying pending exits right now; it buys this one once its node confirms.
 */
export function transientSettlementWait(reason: string): string | undefined {
  switch (reason.split("(")[0]) {
    case "InsufficientLiquidity":
    case "TooManyOpenPositions":
      return "Waiting for vault liquidity: it refills as earlier exits clear their window";
    case "InvalidRoot":
      return "Its rollup node is disputed or not provable yet: waiting for a confirmed root";
    case "PendingNotAccepted":
      return "The vault buys this exit once its rollup node confirms";
    default:
      return undefined;
  }
}

/** Names the revert reason inside a viem error: a custom error (with args), a revert string, or the raw selector. */
export function revertReason(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined;
  if (reverted.data?.errorName) {
    const args = reverted.data.args?.map((a) => String(a)).join(", ");
    return args ? `${reverted.data.errorName}(${args})` : reverted.data.errorName;
  }
  return reverted.reason ?? reverted.signature ?? "unknown revert";
}

/**
 * Settles a gasless exit if its withdrawal is already committed by a rollup node; otherwise reports
 * "waiting". Stateless and idempotent from the caller's point of view: safe to poll, and safe to call after
 * someone else settled (reports "done-elsewhere" instead of spending gas on a doomed transaction).
 */
export async function trySettle(params: {
  parent: PublicClient;
  child: PublicClient;
  wallet: WalletClient;
  router: Address;
  rollup: Address;
  childGateway: Address;
  withdrawalTx: Hex;
  order: SellOrder;
  signature: Hex;
}): Promise<RelayResult> {
  const { parent, child, wallet, router, order } = params;

  // Cheapest check first: once the router no longer owns the exit there is nothing left to settle.
  const [owner] = await parent.readContract({
    address: order.gateway,
    abi: gatewayOwnerAbi,
    functionName: "getExternalCall",
    args: [order.exitNum, router, "0x"],
  });
  if (owner.toLowerCase() !== router.toLowerCase()) return { status: "done-elsewhere", owner };

  let w;
  try {
    w = await buildExitProof({
      parent,
      child,
      rollup: params.rollup,
      childGateway: params.childGateway,
      withdrawalTx: params.withdrawalTx,
      exitNum: order.exitNum,
    });
  } catch (err) {
    if (err instanceof NotYetAssertedError) return { status: "waiting", reason: err.message };
    throw err;
  }
  if (w.initialDestination.toLowerCase() !== router.toLowerCase()) {
    throw new InvalidWithdrawalError("Withdrawal was not sent to the router");
  }

  const account = wallet.account;
  if (!account) throw new Error("Relayer wallet has no account");
  // Simulate first: the relayer never pays gas for a settlement that would revert.
  let request;
  try {
    ({ request } = await parent.simulateContract({
      address: router,
      abi: settleAbi,
      functionName: "settle",
      args: [claimOf(w), order, params.signature],
      account,
    }));
  } catch (err) {
    const reason = revertReason(err);
    if (reason) throw new SettlementRevertedError(reason);
    throw err;
  }
  const txHash = await wallet.writeContract({ ...request, chain: wallet.chain, account });
  const receipt = await parent.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`Settlement reverted: ${txHash}`);
  return { status: "settled", txHash };
}
