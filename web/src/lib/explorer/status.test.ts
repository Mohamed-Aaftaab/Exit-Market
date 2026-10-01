// Run: node --test web/src/lib/explorer/status.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { marketRole } from "./status.ts";

test("marketRole: an exit the market holds is listed, one that passed through it is sold, others are neither", () => {
  assert.equal(marketRole({ status: "transferred", ownerContract: "market", viaExitMarket: true }), "listed");
  assert.equal(marketRole({ status: "transferred", ownerContract: "vault", viaExitMarket: true }), "sold");
  assert.equal(marketRole({ status: "transferred", ownerContract: undefined, viaExitMarket: true }), "sold"); // bought from a listing
  assert.equal(marketRole({ status: "transferred", ownerContract: undefined, viaExitMarket: false }), undefined);
  assert.equal(marketRole({ status: "claimed", ownerContract: "market", viaExitMarket: true }), undefined);
  assert.equal(marketRole({ status: "in-window", ownerContract: undefined, viaExitMarket: false }), undefined);
});