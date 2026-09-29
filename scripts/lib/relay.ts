import { type Address, type Hex, type PublicClient, type WalletClient, parseAbi } from "viem";
import { buildExitProof } from "./exitProof.ts";

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

const routerAbi = parseAbi([
  "struct ExitClaim { address initialDestination; address l1Token; address from; uint256 amount; uint256 l2Block; uint256 l1Block; uint256 l2Timestamp; uint256 index; bytes32[] proof; bytes32 sendRoot; uint64 nodeNum; bytes32 blockHash; }",
  "struct SellOrder { address gateway; uint256 exitNum; address buyer; uint256 minProceeds; uint256 relayerFee; uint64 deadline; }",
  "function settle(ExitClaim claim, SellOrder order, bytes signature) returns (uint256)",
]);

export type RelayResult =
  | { status: "waiting"; reason: string }
  | { status: "settled"; txHash: Hex };

/**
 * Settles a gasless exit if its withdrawal is already committed by a rollup node; otherwise reports
 * "waiting". Stateless and idempotent from the caller's point of view: safe to poll.
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
  let w;
  try {
    w = await buildExitProof({
      parent,
      child,
      rollup: params.rollup,
      childGateway: params.childGateway,
      withdrawalTx: params.withdrawalTx,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not yet asserted")) return { status: "waiting", reason: message };
    throw err;
  }
  if (w.exitNum !== order.exitNum) throw new Error("Order exitNum does not match the withdrawal");
  if (w.initialDestination.toLowerCase() !== router.toLowerCase()) throw new Error("Withdrawal was not sent to the router");

  const p = w.proof;
  const claim = {
    initialDestination: w.initialDestination,
    l1Token: p.l1Token,
    from: p.from,
    amount: p.amount,
    l2Block: p.l2Block,
    l1Block: p.l1Block,
    l2Timestamp: p.l2Timestamp,
    index: p.index,
    proof: p.merkleProof,
    sendRoot: p.sendRoot,
    nodeNum: p.nodeNum,
    blockHash: p.blockHash,
  };
  const account = wallet.account;
  if (!account) throw new Error("Relayer wallet has no account");
  // Simulate first: the relayer never pays gas for a settlement that would revert.
  const { request } = await parent.simulateContract({
    address: router,
    abi: routerAbi,
    functionName: "settle",
    args: [claim, order, params.signature],
    account,
  });
  const txHash = await wallet.writeContract({ ...request, chain: wallet.chain, account });
  const receipt = await parent.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`Settlement reverted: ${txHash}`);
  return { status: "settled", txHash };
}
