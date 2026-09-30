// Run: node --test web/src/lib/format.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { blocksToDuration, bps, errorText, parseUsdgInput, shortHex, usdg } from "./format.ts";

const BLOCKS_PER_MINUTE = 5n; // 12s L1 blocks
const BLOCKS_PER_HOUR = 60n * BLOCKS_PER_MINUTE;
const BLOCKS_PER_DAY = 24n * BLOCKS_PER_HOUR;

test("blocksToDuration: nothing left reads as now", () => {
  assert.equal(blocksToDuration(0n), "now");
  assert.equal(blocksToDuration(-3n), "now");
});

test("blocksToDuration: partial minutes round up", () => {
  assert.equal(blocksToDuration(1n), "1m");
  assert.equal(blocksToDuration(BLOCKS_PER_MINUTE), "1m");
  assert.equal(blocksToDuration(BLOCKS_PER_MINUTE + 1n), "2m");
});

test("blocksToDuration: rounding up to a full hour or day carries instead of printing 60m", () => {
  assert.equal(blocksToDuration(BLOCKS_PER_HOUR - 1n), "1h 0m");
  assert.equal(blocksToDuration(2n * BLOCKS_PER_HOUR - 1n), "2h 0m");
  assert.equal(blocksToDuration(BLOCKS_PER_DAY - 1n), "1d 0h");
});

test("blocksToDuration: hours and days", () => {
  assert.equal(blocksToDuration(BLOCKS_PER_HOUR + 30n * BLOCKS_PER_MINUTE), "1h 30m");
  assert.equal(blocksToDuration(BLOCKS_PER_DAY + BLOCKS_PER_HOUR + 1n), "1d 1h");
  assert.equal(blocksToDuration(6n * BLOCKS_PER_DAY + 9n * BLOCKS_PER_HOUR + 36n * BLOCKS_PER_MINUTE), "6d 9h");
});

test("parseUsdgInput accepts up to 6 decimals and rejects zero or malformed input", () => {
  assert.equal(parseUsdgInput("1"), 1_000_000n);
  assert.equal(parseUsdgInput(" 2.5 "), 2_500_000n);
  assert.equal(parseUsdgInput("0.000001"), 1n);
  for (const bad of ["", "0", "0.0", "1.0000001", "-1", "1e3", "abc", "1."]) {
    assert.equal(parseUsdgInput(bad), undefined, bad);
  }
});

test("usdg formats 6-decimal amounts and shows a dash when unknown", () => {
  assert.equal(usdg(1_234_560_000n), "1,234.56");
  assert.equal(usdg(1n, 6), "0.000001");
  assert.equal(usdg(undefined), "—");
});

test("shortHex, bps and errorText", () => {
  assert.equal(shortHex("0x1234567890abcdef1234"), "0x123456…1234");
  assert.equal(shortHex("0x1234"), "0x1234");
  assert.equal(bps(125), "1.25%");
  assert.equal(errorText({ shortMessage: "User rejected the request." }), "User rejected the request.");
  assert.equal(errorText(new Error("first line\nstack detail")), "first line");
  assert.equal(errorText(42), "Something went wrong");
});
