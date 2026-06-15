import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { haltTrading, clearHalt, isTradingHalted, getHaltReason } from "../trading-halt.js";

afterEach(() => clearHalt());

test("halt lifecycle: set, read, clear", () => {
  assert.equal(isTradingHalted(), false);
  assert.equal(getHaltReason(), null);

  haltTrading("daily loss near limit");
  assert.equal(isTradingHalted(), true);
  assert.equal(getHaltReason(), "daily loss near limit");

  clearHalt();
  assert.equal(isTradingHalted(), false);
  assert.equal(getHaltReason(), null);
});
