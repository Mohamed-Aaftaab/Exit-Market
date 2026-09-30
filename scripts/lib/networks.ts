import { defineChain, getAddress, type Address } from "viem";

/**
 * Xai Testnet (Orbit L3, custom gas token sXAI) settling to Arbitrum Sepolia.
 * Source: OffchainLabs/arbitrum-token-bridge orbitChainsData.json; every address re-verified on-chain
 * (gateway -> inbox -> bridge -> rollup -> outbox derivation, allowedOutboxes = true) on 2026-09-29.
 */
export const XAI_TESTNET = {
  name: "Xai Testnet",
  chainId: 37714555429,
  parentChainId: 421614,
  rpcUrl: "https://testnet-v2.xai-chain.net/rpc",
  explorerUrl: "https://testnet-explorer-v2.xai-chain.net",
  confirmPeriodBlocks: 150,
  nativeToken: getAddress("0x4e6f41acbfa8eb4a3b25e151834d9a14b49b69d2"),
  ethBridge: {
    bridge: getAddress("0x6c7FAC4edC72E86B3388B48979eF37Ecca5027e6"),
    inbox: getAddress("0x6396825803B720bc6A43c63caa1DcD7B31EB4dd0"),
    outbox: getAddress("0xc7491a559b416540427f9f112C5c98b1412c5d51"),
    rollup: getAddress("0xeedE9367Df91913ab149e828BDd6bE336df2c892"),
    sequencerInbox: getAddress("0x529a2061A1973be80D315770bA9469F3Da40D938"),
  },
  tokenBridge: {
    parentGatewayRouter: getAddress("0x185b868DBBF41554465fcb99C6FAb9383E15f47A"),
    parentErc20Gateway: getAddress("0xCcB451C4Df22addCFe1447c58bC6b2f264Bb1256"),
    parentCustomGateway: getAddress("0x04e14E04949D49ae9c551ca8Cc3192310Ce65D88"),
    parentMultiCall: getAddress("0xA115146782b7143fAdB3065D86eACB54c169d092"),
    parentProxyAdmin: getAddress("0x022c515aEAb29aaFf82e86A10950cE14eA89C9c5"),
    parentWeth: "0x0000000000000000000000000000000000000000" as Address,
    parentWethGateway: "0x0000000000000000000000000000000000000000" as Address,
    childGatewayRouter: getAddress("0x3B8ba769a43f34cdD67a20aF60d08D54C9C8f1AD"),
    childErc20Gateway: getAddress("0xD840761a09609394FaFA3404bEEAb312059AC558"),
    childCustomGateway: getAddress("0xea1ce1CC75C948488515A3058E10aa82da40cE8F"),
    childMultiCall: getAddress("0x5CBd60Ae5Af80A42FA8b0F20ADF95A8879844984"),
    childProxyAdmin: getAddress("0x7C1BA251d812fb34aF5C2566040C3C30585aFed9"),
    childWeth: "0x0000000000000000000000000000000000000000" as Address,
    childWethGateway: "0x0000000000000000000000000000000000000000" as Address,
  },
} as const;

/** viem chain for Xai Testnet: the one definition shared by scripts and the web app's wagmi config. */
export const xaiTestnet = defineChain({
  id: XAI_TESTNET.chainId,
  name: XAI_TESTNET.name,
  nativeCurrency: { name: "sXAI", symbol: "sXAI", decimals: 18 },
  rpcUrls: { default: { http: [XAI_TESTNET.rpcUrl] } },
  blockExplorers: { default: { name: "Xai Explorer", url: XAI_TESTNET.explorerUrl } },
  testnet: true,
});

export const ARBITRUM_SEPOLIA = {
  chainId: 421614,
  rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  usdg: getAddress("0xFFC95faa3d63Cde504a05B567C600B78C0b41892"),
  /** USDG's token on Xai Testnet via the standard gateway (deployed on first deposit). */
  usdgOnXai: getAddress("0x61Ce5eC0795090C0Bb434699324EBf9A169B11a5"),
} as const;
