import { test } from "node:test";
import assert from "node:assert/strict";
import { readJSON, writeJSONAtomic } from "../storage.js";

test("storage round-trips JSON by key", () => {
  writeJSONAtomic("/seed/round-trip.json", { a: 1, b: [2, 3] });
  assert.deepEqual(readJSON("/seed/round-trip.json", {}), { a: 1, b: [2, 3] });
});

test("storage returns fallback for a missing key", () => {
  assert.deepEqual(readJSON("/seed/missing-xyz.json", { def: true }), { def: true });
  assert.deepEqual(readJSON("/seed/missing-fn.json", () => ({ fn: 1 })), { fn: 1 });
});

test("storage overwrites an existing key", () => {
  writeJSONAtomic("/seed/overwrite.json", { v: 1 });
  writeJSONAtomic("/seed/overwrite.json", { v: 2 });
  assert.equal(readJSON("/seed/overwrite.json", {}).v, 2);
});
