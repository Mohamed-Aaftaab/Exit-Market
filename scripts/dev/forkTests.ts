/**
 * Runs the Solidity suite with the fork tests enabled (FORK_TESTS=1) on any OS: an inline `FORK_TESTS=1 cmd` only
 * works in POSIX shells, and npm runs scripts with cmd.exe on Windows. Extra arguments go to hardhat, e.g. one file:
 *   npm run test:fork
 *   npm run test:fork -- contracts/test/fork/XaiFork.t.sol
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Hardhat's own CLI, run with this Node binary: no shell, so arguments are passed as-is on every OS.
const require = createRequire(import.meta.url);
const pkgPath = require.resolve("hardhat/package.json");
const { bin } = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: Record<string, string> };
const cli = join(dirname(pkgPath), bin.hardhat);

const result = spawnSync(process.execPath, [cli, "test", "solidity", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, FORK_TESTS: "1" },
});
process.exitCode = result.status ?? 1;