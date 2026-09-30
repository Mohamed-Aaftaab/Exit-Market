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
    label: "A 5 USDG withdrawal leaves Xai Testnet",
    detail: "Exit #12, a standard bridge withdrawal",
    chain: "xaiTestnet",
    hash: "0xf2acf5520923833e07abf580bf43596facf890dcf9acde596a66540a9393dda4",
  },
  {
    label: "Sold while still pending, in one signature",
    detail: "v3 market: proven on-chain, price pulled from the vault, which now owns the exit",
    chain: "arbitrumSepolia",
    hash: "0x20ba5315574be5a0884a0c43cae52d798bcd22a3656a4a2440a218601c1dc782",
  },
  {
    label: "Gasless: settled for a wallet holding 0 ETH",
    detail: "Exit #13, one signed order; this site's relayer paid the gas",
    chain: "arbitrumSepolia",
    hash: "0x7a9d6168e9bc171af415495716e600f50c91df6a0bd85e8bdcaf8ce3cfb1658f",
  },
  {
    label: "The keeper executed the exit through the Outbox",
    detail: "Exit #6: permissionless, anyone can run it after the challenge period",
    chain: "arbitrumSepolia",
    hash: "0xd44532020be37c7f2e72fbcff55fd1912c3a8de27a8105e5453252f1696ebecb",
  },
  {
    label: "The vault collected face value",
    detail: "Exit #6 (v2 vault): the purchase discount became LP yield",
    chain: "arbitrumSepolia",
    hash: "0xd329b47b64202458c5f9513a562defd7777c6db2eb7031328348e615103cbfd9",
  },
];
