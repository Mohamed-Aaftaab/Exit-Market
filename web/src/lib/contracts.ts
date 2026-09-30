import { getAddress, parseAbi, type Address } from "viem";
import { exitMarketAbi, exitVaultAbi } from "@shared/abis.ts";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "@shared/networks.ts";
import deploymentFile from "../../../deployments/arbitrumSepolia.json";

export { ARBITRUM_SEPOLIA, XAI_TESTNET };

function parseAddress(value: string | undefined): Address | undefined {
  if (!value) return undefined;
  try {
    return getAddress(value);
  } catch {
    return undefined;
  }
}

/** Env wins; unset (or malformed, which must not white-screen the app) falls back to the deployment file. */
function pickAddress(name: string, envValue: string | undefined, fileValue: string | undefined): Address | undefined {
  const fromEnv = parseAddress(envValue);
  if (envValue && !fromEnv) console.warn(`Ignoring malformed ${name}=${envValue}; using deployments/arbitrumSepolia.json`);
  return fromEnv ?? parseAddress(fileValue);
}

const FILE: { market?: string; vault?: string; router?: string } = deploymentFile;

/**
 * Live contracts: deployments/arbitrumSepolia.json (written by the deploy scripts), so a fresh clone runs with no
 * config. NEXT_PUBLIC_* overrides point a build at other contracts (see web/.env.example). Each process.env access
 * stays literal so Next inlines it into the client bundle.
 */
export const DEPLOYMENT = {
  market: pickAddress("NEXT_PUBLIC_EXIT_MARKET", process.env.NEXT_PUBLIC_EXIT_MARKET, FILE.market),
  vault: pickAddress("NEXT_PUBLIC_EXIT_VAULT", process.env.NEXT_PUBLIC_EXIT_VAULT, FILE.vault),
  router: pickAddress("NEXT_PUBLIC_EXIT_INTENT_ROUTER", process.env.NEXT_PUBLIC_EXIT_INTENT_ROUTER, FILE.router),
} as const;

/** ABIs generated from the compiled contracts (scripts/dev/exportAbis.ts). */
export const vaultAbi = exitVaultAbi;
export const marketAbi = exitMarketAbi;

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

/** Flat fee paid to whoever relays a gasless exit (USDG, 6 decimals). */
export const RELAYER_FEE = 20_000n; // 0.02 USDG
/** Seller-side slippage bound for gasless orders: accept at least 99% of face value (minus relayer fee). */
export const GASLESS_MIN_BPS = 9_900n;

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
