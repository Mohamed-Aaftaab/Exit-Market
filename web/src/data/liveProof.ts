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
    label: "A 2.5 USDG withdrawal leaves Xai Testnet",
    detail: "Exit #14, a standard bridge withdrawal",
    chain: "xaiTestnet",
    hash: "0x15e38d3a378ff54e899a24d5b50483fb34d5f66d5562894540f66e4c6d655488",
  },
  {
    label: "Sold while still pending, in one signature",
    detail: "v4 market: proven on-chain, no rival on its node chain, price pulled from the vault",
    chain: "arbitrumSepolia",
    hash: "0xa6eb8d37170fa78f4d386a30a27f8779c08f2a90c9ffa53d138b53f6cce3bf55",
  },
  {
    label: "Gasless: settled for a wallet holding 0 ETH",
    detail: "Exit #16, one signed order; this site's relayer paid the gas",
    chain: "arbitrumSepolia",
    hash: "0xdcabb327855c2c00a6dad593f0cd7dd3af7a629ab1bd17f6708625b29d472f57",
  },
  {
    label: "Listed at the seller's price, bought by another wallet",
    detail: "Exit #15: 2 USDG for 1.99; the Outbox later paid the buyer face value",
    chain: "arbitrumSepolia",
    hash: "0x6ff67081cdb80666962905f0414ffcdb4902df940b2e6ac54ec35c5bbcd77031",
  },
  {
    label: "Executed through the Outbox, face value collected",
    detail: "Exit #14 after the window: the permissionless keeper ran it, the vault collected",
    chain: "arbitrumSepolia",
    hash: "0x69afb2b235cf1e5a06ce1203b369e91678b4c6a29a97d69ce00987cefa0d8181",
  },
];
