import { test } from "node:test";
import assert from "node:assert/strict";
import { trackTrade, getOpenTrackedTrades, getTrackedTrade } from "../state.js";
import { reconcile } from "../reconcile.js";

test("reconcile closes phantom local trades the broker no longer reports", async () => {
  trackTrade({ ticket: "PH-TEST-1", symbol: "EURUSD", type: "buy", volume: 0.1, openPrice: 1.1, sl: 1.09, tp: 1.12, reason: "seed" });
  assert.ok(getOpenTrackedTrades().some((t) => String(t.id) === "PH-TEST-1"));

  // Broker (DRY_RUN/metaapi) reports no open positions -> the local trade is a phantom
  const res = await reconcile();
  assert.ok(res.closedPhantom >= 1, `expected >=1 phantom closed, got ${res.closedPhantom}`);

  assert.equal(getOpenTrackedTrades().some((t) => String(t.id) === "PH-TEST-1"), false);
  assert.ok(getTrackedTrade("PH-TEST-1")?.closedAt, "phantom should be marked closed");
});
