/** Real testnet transactions behind every claim on the site (Xai Testnet → Arbitrum Sepolia). */
export type Chain = "arbitrumSepolia" | "xaiTestnet";

export type ProofTx = { label: string; detail: string; chain: Chain; hash: `0x${string}` };

const EXPLORER: Record<Chain, string> = {
  arbitrumSepolia: "https://sepolia.arbiscan.io/tx/",
  xaiTestnet: "https://testnet-explorer-v2.xai-chain.net/tx/",
};

export const txUrl = (tx: ProofTx) => `${EXPLORER[tx.chain]}${tx.hash}`;
export const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-4)}`;

export const LIVE_PROOF: ReadonlyArray<ProofTx> = [
  {
    label: "A 10 USDG withdrawal leaves Xai Testnet",
    detail: "Exit #6, a standard bridge withdrawal",
    chain: "xaiTestnet",
    hash: "0x462167a725202c8980cd6023fb5e13ad0dedc6f63dc6aab4a068f4bb631c7aac",
  },
  {
    label: "Sold while still pending, in one signature",
    detail: "The seller received 9.96 USDG; the vault now owns the exit",
    chain: "arbitrumSepolia",
    hash: "0xfc3a6c284974612332fb8e1ff2667a52e9c6415c7e9d23a96f00e1c174a6d87d",
  },
  {
    label: "Gasless: settled for a wallet holding 0 ETH",
    detail: "Exit #7, one signed order, the relayer paid the gas",
    chain: "arbitrumSepolia",
    hash: "0x06a3978b263d3f9743b3a2fb30fa81889b7732b3ea5d2ca668589975dca1b3eb",
  },
  {
    label: "The keeper executed the exit through the Outbox",
    detail: "Permissionless: anyone can run it after the challenge period",
    chain: "arbitrumSepolia",
    hash: "0xd44532020be37c7f2e72fbcff55fd1912c3a8de27a8105e5453252f1696ebecb",
  },
  {
    label: "The vault collected face value",
    detail: "The discount became LP yield: 19.00 → 19.015 USDG",
    chain: "arbitrumSepolia",
    hash: "0xd329b47b64202458c5f9513a562defd7777c6db2eb7031328348e615103cbfd9",
  },
];
