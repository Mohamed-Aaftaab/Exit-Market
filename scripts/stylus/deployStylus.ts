/**
 * Deploys + activates a Stylus WASM program without cargo-stylus (which does not build on Windows):
 *   code = 0xEFF000 ++ dictionary(0x00) ++ brotli(wasm), wrapped in a CODECOPY/RETURN init code,
 *   then ArbWasm(0x71).activateProgram(program) paying the quoted data fee.
 * Usage: node scripts/stylus/deployStylus.ts [path/to/program.wasm]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";
import wabtInit from "wabt";
import { concat, formatEther, parseAbi, toHex, type Hex } from "viem";
import { getClients } from "../lib/clients.ts";

const WASM = process.argv[2] ?? "stylus/exit-proof/target/wasm32-unknown-unknown/release/exit_proof.wasm";
const ARB_WASM = "0x0000000000000000000000000000000000000071";
const EOF_PREFIX: Hex = "0xeff00000"; // Stylus magic (0xEFF000) + empty dictionary (0x00)
const MAX_CODE_SIZE = 24_576;
const FEE_BUFFER_BPS = 12_000n; // +20% over the quoted data fee (unused part is refunded)
const arbWasmAbi = parseAbi(["function activateProgram(address program) payable returns (uint16 version, uint256 dataFee)"]);

/**
 * Mirrors cargo-stylus process_wasm: a WASM -> WAT -> WASM round trip drops dangling reference-type
 * encodings (unsupported by Arbitrum's parser), then every custom section is stripped.
 */
async function processWasm(raw: Uint8Array): Promise<Uint8Array> {
  const wabt = await wabtInit();
  const features = { reference_types: true, bulk_memory: true, sign_extension: true, mutable_globals: true, multi_value: true };
  const parsed = wabt.readWasm(raw, { readDebugNames: false, ...features });
  const text = parsed.toText({ foldExprs: false, inlineExport: false });
  parsed.destroy();
  const reparsed = wabt.parseWat("program.wat", text, features);
  const { buffer } = reparsed.toBinary({ log: false, write_debug_names: false });
  reparsed.destroy();
  return stripCustomSections(buffer);
}

function readLeb128(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
  }
}

/** Drops custom sections (id 0): names, producers, target_features. */
function stripCustomSections(wasm: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [wasm.subarray(0, 8)]; // magic + version
  let pos = 8;
  while (pos < wasm.length) {
    const id = wasm[pos];
    const [size, payloadStart] = readLeb128(wasm, pos + 1);
    const end = payloadStart + size;
    if (id !== 0) parts.push(wasm.subarray(pos, end));
    pos = end;
  }
  return Buffer.concat(parts);
}

function initCode(code: Uint8Array): Hex {
  // PUSH32 len | DUP1 | PUSH1 0x2a (prelude length = 42 bytes) | PUSH1 0 | CODECOPY | PUSH1 0 | RETURN
  const prelude = concat(["0x7f", toHex(code.length, { size: 32 }), "0x80602a60003960" as Hex, "0x00f3"]);
  if ((prelude.length - 2) / 2 !== 0x2a) throw new Error("prelude length mismatch");
  return concat([prelude, toHex(code)]);
}

async function main() {
  const wasm = await processWasm(readFileSync(WASM));
  const compressed = brotliCompressSync(wasm, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 22 },
  });
  const code = Buffer.concat([Buffer.from(EOF_PREFIX.slice(2), "hex"), compressed]);
  console.log(`wasm ${wasm.length} B -> brotli ${compressed.length} B -> code ${code.length} B`);
  if (code.length > MAX_CODE_SIZE) throw new Error("Compressed program exceeds 24KB");

  const { account, parent, parentWallet } = getClients();
  const deployHash = await parentWallet.sendTransaction({ data: initCode(code), account, chain: parentWallet.chain });
  const deployed = await parent.waitForTransactionReceipt({ hash: deployHash });
  const program = deployed.contractAddress;
  if (!program || deployed.status !== "success") throw new Error(`Deploy failed: ${deployHash}`);
  console.log(`deployed program ${program} (${deployHash})`);

  // Quote the activation data fee by simulating with a generous value.
  const { result } = await parent.simulateContract({
    address: ARB_WASM, abi: arbWasmAbi, functionName: "activateProgram", args: [program], account, value: 10n ** 16n,
  });
  const dataFee = (result[1] * FEE_BUFFER_BPS) / 10_000n;
  console.log(`stylus version ${result[0]}, data fee ${formatEther(result[1])} ETH (sending ${formatEther(dataFee)})`);

  const activateHash = await parentWallet.writeContract({
    address: ARB_WASM, abi: arbWasmAbi, functionName: "activateProgram", args: [program], value: dataFee, account, chain: parentWallet.chain,
  });
  const activated = await parent.waitForTransactionReceipt({ hash: activateHash });
  if (activated.status !== "success") throw new Error(`Activation failed: ${activateHash}`);
  console.log(`activated (${activateHash})`);

  mkdirSync("deployments", { recursive: true });
  writeFileSync("deployments/stylus.arbitrumSepolia.json", `${JSON.stringify({ exitProof: program, deployHash, activateHash }, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
