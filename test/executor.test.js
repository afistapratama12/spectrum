import { test, before } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../tools/executor.js";
import { haltTrading, clearHalt } from "../trading-halt.js";
import { recordDailySnapshot } from "../state.js";

// Make sure challenge rules allow trading regardless of state left by other
// test files: a tiny start-equity means current equity is never a daily loss.
before(() => {
  const date = new Date().toISOString().slice(0, 10);
  recordDailySnapshot({ date, startEquity: 1, peakEquity: 1, troughEquity: 1, tradesCount: 0 });
  clearHalt();
});

test("place_trade computes JPY pip SL/TP (0.01) in dry-run", async () => {
  const r = await executeTool("place_trade", {
    symbol: "USDJPY", type: "buy", volume: 0.01, sl_pips: 20, tp_pips: 40, reason: "test",
  });
  assert.equal(r.dry_run, true);
  // JPY pip = 0.01 -> SL gap 20*0.01 = 0.20, TP gap 40*0.01 = 0.40 (allow 3-digit rounding)
  assert.ok(Math.abs((r.currentPrice - r.slPrice) - 0.2) < 0.005, `SL gap ${r.currentPrice - r.slPrice}`);
  assert.ok(Math.abs((r.tpPrice - r.currentPrice) - 0.4) < 0.005, `TP gap ${r.tpPrice - r.currentPrice}`);
});

test("place_trade is blocked while the Equity Guardian halt is active", async () => {
  haltTrading("test halt");
  const r = await executeTool("place_trade", { symbol: "EURUSD", type: "buy", volume: 0.01, sl_pips: 20, tp_pips: 40 });
  clearHalt();
  assert.equal(r.blocked, true);
  assert.match(r.reason, /Guardian/);
});

test("place_pending_order rejects a wrong-side entry price", async () => {
  // buy_stop must trigger ABOVE current price; an absurdly low entry is wrong-side
  const r = await executeTool("place_pending_order", {
    symbol: "EURUSD", order_type: "buy_stop", entry_price: 0.0001, sl_pips: 20, tp_pips: 40,
  });
  assert.equal(r.success, false);
});
