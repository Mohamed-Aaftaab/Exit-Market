import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from "viem";
import type { Withdrawal } from "./exitProof.ts";

/** Mirrors IExitMarket.Action. */
export const Action = { LIST: 0, SELL_TO_BUYER: 1 } as const;

/** Mirrors the ExitClaim struct in contracts/interfaces/IExitMarket.sol (field order matters). */
const EXIT_CLAIM =
  "(address initialDestination, address l1Token, address from, uint256 amount, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 index, bytes32[] proof, bytes32 sendRoot, uint64 nodeNum, bytes32 blockHash)";

function claimOf(w: Withdrawal) {
  const p = w.proof;
  return {
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
}

function encode(action: number, w: Withdrawal, params: Hex): Hex {
  return encodeAbiParameters(parseAbiParameters(`uint8, ${EXIT_CLAIM}, bytes`), [action, claimOf(w), params]);
}

/** `data` for gateway.transferExitAndCall that lists the exit at a fixed USDG price. */
export function encodeList(w: Withdrawal, price: bigint, expiry: bigint): Hex {
  return encode(Action.LIST, w, encodeAbiParameters(parseAbiParameters("uint256, uint64"), [price, expiry]));
}

/** `data` for gateway.transferExitAndCall that sells the exit instantly to `buyer` (e.g. ExitVault). */
export function encodeSellToBuyer(w: Withdrawal, buyer: Address, minPayout: bigint): Hex {
  return encode(
    Action.SELL_TO_BUYER,
    w,
    encodeAbiParameters(parseAbiParameters("address, uint256"), [buyer, minPayout]),
  );
}

const FINALIZE_ABI = parseAbi(["function finalizeInboundTransfer(address,address,address,uint256,bytes)"]);

/** Outbox item hash of a gateway withdrawal; mirrors contracts/libraries/ExitLeaf.sol#itemHash. */
export function exitItemHash(w: Withdrawal, childGateway: Address, parentGateway: Address): Hex {
  const p = w.proof;
  const data = encodeFunctionData({
    abi: FINALIZE_ABI,
    functionName: "finalizeInboundTransfer",
    args: [p.l1Token, p.from, w.initialDestination, p.amount, encodeAbiParameters(parseAbiParameters("uint256, bytes"), [w.exitNum, "0x"])],
  });
  return keccak256(
    encodePacked(
      ["address", "address", "uint256", "uint256", "uint256", "uint256", "bytes"],
      [childGateway, parentGateway, p.l2Block, p.l1Block, p.l2Timestamp, 0n, data],
    ),
  );
}

/** The ExitRecord the market will build, for calling ExitVault.quote before selling. */
export function toExitRecord(
  w: Withdrawal,
  gateways: { parent: Address; child: Address },
  deadlineBlock: bigint,
  pending: boolean,
) {
  const p = w.proof;
  return {
    gateway: gateways.parent,
    exitNum: w.exitNum,
    initialDestination: w.initialDestination,
    l1Token: p.l1Token,
    amount: p.amount,
    index: p.index,
    itemHash: exitItemHash(w, gateways.child, gateways.parent),
    sendRoot: p.sendRoot,
    nodeNum: p.nodeNum,
    blockHash: p.blockHash,
    pending,
    deadlineBlock,
  };
}
