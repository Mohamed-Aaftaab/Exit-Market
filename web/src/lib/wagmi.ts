import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arbitrumSepolia } from "wagmi/chains";
import { ARBITRUM_SEPOLIA, XAI_TESTNET, xaiTestnet } from "@shared/networks.ts";

export { xaiTestnet };

export const wagmiConfig = createConfig({
  chains: [arbitrumSepolia, xaiTestnet],
  connectors: [injected()],
  transports: {
    [arbitrumSepolia.id]: http(ARBITRUM_SEPOLIA.rpcUrl),
    [xaiTestnet.id]: http(XAI_TESTNET.rpcUrl),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
