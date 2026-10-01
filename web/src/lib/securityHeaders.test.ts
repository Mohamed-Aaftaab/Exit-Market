// Run: node --test web/src/lib/securityHeaders.test.ts
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "../../../scripts/lib/networks.ts";

test("the CSP's connect-src allows exactly the RPC origins the app reads from (scripts/lib/networks.ts)", () => {
  const config = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
  const declared = /RPC_ORIGINS = \[([^\]]*)\]/.exec(config)?.[1];
  assert.ok(declared, "RPC_ORIGINS not found in web/next.config.ts");
  const origins = [...declared.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const expected = [ARBITRUM_SEPOLIA.rpcUrl, XAI_TESTNET.rpcUrl].map((u) => new URL(u).origin).sort();
  assert.deepEqual(origins, expected);
});