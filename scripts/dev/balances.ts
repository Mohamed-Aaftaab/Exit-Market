import { createPublicClient, formatEther, formatUnits, http, parseAbi } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "../lib/networks.ts";
const who = (process.argv[2] ?? "0xF194AE05D7BAccFB13A5A01e9D2adF50ea0c8A69") as `0x${string}`;
const parent = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_SEPOLIA.rpcUrl) });
const child = createPublicClient({ transport: http(XAI_TESTNET.rpcUrl) });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const [eth, usdg, sxaiParent, sxaiL3, usdgL3] = await Promise.all([
  parent.getBalance({ address: who }),
  parent.readContract({ address: ARBITRUM_SEPOLIA.usdg, abi: erc20, functionName: "balanceOf", args: [who] }),
  parent.readContract({ address: XAI_TESTNET.nativeToken, abi: erc20, functionName: "balanceOf", args: [who] }),
  child.getBalance({ address: who }),
  child.getCode({ address: ARBITRUM_SEPOLIA.usdgOnXai }).then((c) => (c && c !== "0x" ? child.readContract({ address: ARBITRUM_SEPOLIA.usdgOnXai, abi: erc20, functionName: "balanceOf", args: [who] }) : 0n)),
]);
console.log({ who, arbSepoliaETH: formatEther(eth), arbSepoliaUSDG: formatUnits(usdg, 6), arbSepoliaSXAI: formatEther(sxaiParent), xaiSXAI: formatEther(sxaiL3), xaiUSDG: formatUnits(usdgL3, 6) });
