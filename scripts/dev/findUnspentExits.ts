/** Lists every Xai Testnet gateway withdrawal whose Outbox leaf is still unspent. Usage: node scripts/dev/findUnspentExits.ts */
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "../lib/networks.ts";
const parent = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_SEPOLIA.rpcUrl) });
const child = createPublicClient({ transport: http(XAI_TESTNET.rpcUrl) });
const ev = parseAbiItem("event WithdrawalInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _l2ToL1Id, uint256 _exitNum, uint256 _amount)");
const logs = await child.getLogs({ address: [XAI_TESTNET.tokenBridge.childErc20Gateway, XAI_TESTNET.tokenBridge.childCustomGateway], event: ev, fromBlock: 0n, toBlock: "latest" });
const outbox = parseAbi(["function isSpent(uint256) view returns (bool)"]);
for (const l of logs) {
  const spent = await parent.readContract({ address: XAI_TESTNET.ethBridge.outbox, abi: outbox, functionName: "isSpent", args: [l.args._l2ToL1Id!] });
  if (!spent) console.log("UNSPENT", { gw: l.address, exitNum: l.args._exitNum, index: l.args._l2ToL1Id, token: l.args.l1Token, amount: l.args._amount, to: l.args._to, tx: l.transactionHash });
}
console.log("checked", logs.length);
