/** Shows which parent gateway handles USDG and whether its Xai Testnet token exists. Usage: node scripts/dev/checkUsdgOnXai.ts */
import { createPublicClient, http, parseAbi } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { ARBITRUM_SEPOLIA, XAI_TESTNET, xaiTestnet } from "../lib/networks.ts";

const parent = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_SEPOLIA.rpcUrl) });
const child = createPublicClient({ chain: xaiTestnet, transport: http(XAI_TESTNET.rpcUrl) });
const a = parseAbi(["function getGateway(address) view returns (address)", "function calculateL2TokenAddress(address) view returns (address)"]);
const router = XAI_TESTNET.tokenBridge.parentGatewayRouter;
const gw = await parent.readContract({ address: router, abi: a, functionName: "getGateway", args: [ARBITRUM_SEPOLIA.usdg] });
const l3 = await parent.readContract({ address: router, abi: a, functionName: "calculateL2TokenAddress", args: [ARBITRUM_SEPOLIA.usdg] });
const code = await child.getCode({ address: l3 });
console.log({ gatewayForUSDG: gw, l3Token: l3, matchesNetworks: l3 === ARBITRUM_SEPOLIA.usdgOnXai, deployedOnL3: !!code && code !== "0x" });