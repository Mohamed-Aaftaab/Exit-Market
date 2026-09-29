/** Demand evidence: canonical Arbitrum One -> Ethereum token withdrawals finalized on the L1 gateways (last ~30 days). */
import { createPublicClient, formatUnits, http, keccak256, parseAbi, toHex } from "viem";
import { mainnet } from "viem/chains";
const eth = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") });
const TOPIC = keccak256(toHex("WithdrawalFinalized(address,address,address,uint256,uint256)"));
const GATEWAYS = {
  "L1 ERC20 gateway": "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC",
  "L1 custom gateway": "0xcEe284F754E854890e311e3280b767F80797180d",
  "L1 WETH gateway": "0xd92023E9d9911199a6711321D1277285e6d4e2db",
} as const;
const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const head = await eth.getBlockNumber();
const from = head - 216_000n; // ~30 days
for (const [name, address] of Object.entries(GATEWAYS)) {
  const j = await (await fetch(`https://eth.blockscout.com/api?module=logs&action=getLogs&address=${address}&topic0=${TOPIC}&fromBlock=${from}&toBlock=latest`)).json();
  const logs: { data: string }[] = j.result ?? [];
  const byToken: Record<string, bigint> = {};
  for (const l of logs) { const t = "0x" + l.data.slice(26, 66); byToken[t] = (byToken[t] ?? 0n) + BigInt("0x" + l.data.slice(66, 130)); }
  const top = Object.entries(byToken).sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 5);
  const pretty = await Promise.all(top.map(async ([t, a]) => { try { const [s, d] = await Promise.all([eth.readContract({ address: t as `0x${string}`, abi: erc20, functionName: "symbol" }), eth.readContract({ address: t as `0x${string}`, abi: erc20, functionName: "decimals" })]); return `${Number(formatUnits(a, d)).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${s}`; } catch { return t.slice(0, 10); } }));
  console.log(`${name.padEnd(18)} last ~30d: ${logs.length}${logs.length >= 1000 ? "+ (cap)" : ""} finalized | top: ${pretty.join(", ")}`);
}
