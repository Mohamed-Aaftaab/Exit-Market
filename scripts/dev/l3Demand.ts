/** Demand evidence: canonical token withdrawals finalized on Arbitrum One from major Orbit L3s. */
import { createPublicClient, http, keccak256, toHex, formatUnits, parseAbi } from "viem";
import { arbitrum } from "viem/chains";
const one = createPublicClient({ chain: arbitrum, transport: http("https://arb1.arbitrum.io/rpc") });
const TOPIC = keccak256(toHex("WithdrawalFinalized(address,address,address,uint256,uint256)"));
const L3 = {
  ApeChain: "0xB603a1C07A11945bFe4855347c88583e31b8ddB0",
  Xai: "0xb591cE747CF19cF30e11d656EB94134F523A9e77",
  "EDU Chain": "0x419e439e5c0B839d6e31d7C438939EEE1A4f4184",
  Sanko: "0xb4951c0C41CFceB0D195A95FE66280457A80a990",
  Superposition: "0x62bEd4b862254789825Cd6F2352aa2b76B16145e",
  "RARI Mainnet": "0x46406c88285AD9BE2fB23D9aD96Cb578d824cAb6",
};
const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
for (const [name, gw] of Object.entries(L3)) {
  const url = `https://arbitrum.blockscout.com/api?module=logs&action=getLogs&address=${gw}&topic0=${TOPIC}&fromBlock=0&toBlock=latest`;
  const j = await (await fetch(url)).json();
  const logs: any[] = j.result ?? [];
  const byToken: Record<string, bigint> = {};
  let last90 = 0; const cutoff = Date.now() / 1000 - 90 * 86400;
  for (const l of logs) {
    const token = "0x" + l.data.slice(26, 66); const amount = BigInt("0x" + l.data.slice(66, 130));
    byToken[token] = (byToken[token] ?? 0n) + amount;
    if (parseInt(l.timeStamp, 16) > cutoff) last90++;
  }
  const top = Object.entries(byToken).sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 3);
  const pretty = await Promise.all(top.map(async ([t, a]) => {
    try { const [s, d] = await Promise.all([one.readContract({ address: t as `0x${string}`, abi: erc20, functionName: "symbol" }), one.readContract({ address: t as `0x${string}`, abi: erc20, functionName: "decimals" })]); return `${Number(formatUnits(a, d)).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${s}`; } catch { return `${t.slice(0, 8)}…`; }
  }));
  console.log(`${name.padEnd(14)} finalized withdrawals: ${String(logs.length).padStart(5)}${logs.length >= 1000 ? "+ (API cap)" : ""} | last 90d: ${last90} | top: ${pretty.join(", ")}`);
}
