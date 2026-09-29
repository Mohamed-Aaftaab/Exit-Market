import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arbitrumSepolia } from "wagmi/chains";
import { defineChain } from "viem";

export const xaiTestnet = defineChain({
  id: 37714555429,
  name: "Xai Testnet",
  nativeCurrency: { name: "sXAI", symbol: "sXAI", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-v2.xai-chain.net/rpc"] } },
  blockExplorers: { default: { name: "Xai Explorer", url: "https://testnet-explorer-v2.xai-chain.net" } },
  testnet: true,
});

export const wagmiConfig = createConfig({
  chains: [arbitrumSepolia, xaiTestnet],
  connectors: [injected()],
  transports: {
    [arbitrumSepolia.id]: http("https://sepolia-rollup.arbitrum.io/rpc"),
    [xaiTestnet.id]: http("https://testnet-v2.xai-chain.net/rpc"),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
