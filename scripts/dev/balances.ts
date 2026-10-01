/**
 * Prints an address's test balances on Arbitrum Sepolia and Xai Testnet.
 * Usage: node scripts/dev/balances.ts [address]   (defaults to the DEPLOYER_PRIVATE_KEY account in .env)
 */
import { createPublicClient, formatEther, formatUnits, getAddress, http, parseAbi } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { getClients } from "../lib/clients.ts";
import { ARBITRUM_SEPOLIA, XAI_TESTNET, xaiTestnet } from "../lib/networks.ts";

// An explicit address needs no key; only the default reads DEPLOYER_PRIVATE_KEY (getClients loads .env).
const who = process.argv[2] ? getAddress(process.argv[2]) : getClients().account.address;
const parent = createPublicClient({ chain: arbitrumSepolia, transport: http(process.env.ARB_SEPOLIA_RPC_URL ?? ARBITRUM_SEPOLIA.rpcUrl) });
const child = createPublicClient({ chain: xaiTestnet, transport: http(XAI_TESTNET.rpcUrl) });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const [eth, usdg, sxaiParent, sxaiL3, usdgL3] = await Promise.all([
  parent.getBalance({ address: who }),
  parent.readContract({ address: ARBITRUM_SEPOLIA.usdg, abi: erc20, functionName: "balanceOf", args: [who] }),
  parent.readContract({ address: XAI_TESTNET.nativeToken, abi: erc20, functionName: "balanceOf", args: [who] }),
  child.getBalance({ address: who }),
  child
    .getCode({ address: ARBITRUM_SEPOLIA.usdgOnXai })
    .then((c) => (c && c !== "0x" ? child.readContract({ address: ARBITRUM_SEPOLIA.usdgOnXai, abi: erc20, functionName: "balanceOf", args: [who] }) : 0n)),
]);
console.log({
  who,
  arbSepoliaETH: formatEther(eth),
  arbSepoliaUSDG: formatUnits(usdg, 6),
  arbSepoliaSXAI: formatEther(sxaiParent),
  xaiSXAI: formatEther(sxaiL3),
  xaiUSDG: formatUnits(usdgL3, 6),
});
