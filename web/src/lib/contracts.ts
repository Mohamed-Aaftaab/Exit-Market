import { getAddress, parseAbi, type Address } from "viem";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "@shared/networks.ts";

export { ARBITRUM_SEPOLIA, XAI_TESTNET };

function envAddress(value: string | undefined): Address | undefined {
  return value ? getAddress(value) : undefined;
}

/** Filled after `npx hardhat run scripts/deploy.ts --network arbitrumSepolia` (see web/.env.example). */
export const DEPLOYMENT = {
  market: envAddress(process.env.NEXT_PUBLIC_EXIT_MARKET),
  vault: envAddress(process.env.NEXT_PUBLIC_EXIT_VAULT),
} as const;

export const USDG_DECIMALS = 6;
/** Rollup deadlines are in L1 blocks; Ethereum targets 12s blocks. */
export const SECONDS_PER_L1_BLOCK = 12;

export const EXIT_RECORD =
  "struct ExitRecord { address gateway; uint256 exitNum; address initialDestination; address l1Token; uint256 amount; uint256 index; bytes32 itemHash; bytes32 sendRoot; uint64 nodeNum; bytes32 blockHash; bool pending; uint64 deadlineBlock; }";

export const vaultAbi = parseAbi([
  EXIT_RECORD,
  "function quote(ExitRecord exit) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function idleAssets() view returns (uint256)",
  "function outstandingCost() view returns (uint256)",
  "function baseFeeBps() view returns (uint16)",
  "function aprBps() view returns (uint16)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
]);

export const marketAbi = parseAbi([
  "function feeBps() view returns (uint16)",
  "event ExitSoldToBuyer(bytes32 indexed id, address indexed seller, address indexed buyer, uint256 price, uint256 fee)",
  "event ExitListed(bytes32 indexed id, address indexed seller, address indexed l1Token, uint256 amount, uint256 price, uint64 expiry, bool pending)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const parentGatewayAbi = parseAbi([
  "function transferExitAndCall(uint256 exitNum, address initialDestination, address newDestination, bytes newData, bytes data)",
  "function getExternalCall(uint256 exitNum, address initialDestination, bytes initialData) view returns (address target, bytes data)",
]);

export const childRouterAbi = parseAbi([
  "function outboundTransfer(address l1Token, address to, uint256 amount, bytes data) payable returns (bytes)",
]);

export const withdrawalInitiatedEvent = parseAbi([
  "event WithdrawalInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _l2ToL1Id, uint256 _exitNum, uint256 _amount)",
])[0];

export const outboxAbi = parseAbi(["function isSpent(uint256 index) view returns (bool)"]);

export const rollupAbi = [
  ...parseAbi([
    "function firstUnresolvedNode() view returns (uint64)",
    "function latestNodeCreated() view returns (uint64)",
    "function latestConfirmed() view returns (uint64)",
  ]),
  {
    type: "function",
    name: "getNode",
    stateMutability: "view",
    inputs: [{ name: "nodeNum", type: "uint64" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "stateHash", type: "bytes32" },
          { name: "challengeHash", type: "bytes32" },
          { name: "confirmData", type: "bytes32" },
          { name: "prevNum", type: "uint64" },
          { name: "deadlineBlock", type: "uint64" },
          { name: "noChildConfirmedBeforeBlock", type: "uint64" },
          { name: "stakerCount", type: "uint64" },
          { name: "childStakerCount", type: "uint64" },
          { name: "firstChildBlock", type: "uint64" },
          { name: "latestChildNumber", type: "uint64" },
          { name: "createdAtBlock", type: "uint64" },
          { name: "nodeHash", type: "bytes32" },
        ],
      },
    ],
  },
] as const;
