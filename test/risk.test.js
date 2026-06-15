import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkChallengeRules,
  computeRiskPositionSize,
  evaluateTrailingStop,
  evaluateTimeDecay,
} from "../risk-manager.js";
import { recordDailySnapshot } from "../state.js";

function seedToday(startEquity) {
  const date = new Date().toISOString().slice(0, 10);
  recordDailySnapshot({ date, startEquity, peakEquity: startEquity, troughEquity: startEquity, tradesCount: 0 });
}

test("daily loss limit blocks trading", () => {
  seedToday(10000); // maxDailyLossPct default 4% -> $400 budget
  const rules = checkChallengeRules({
    accountStatus: { equity: 9500, balance: 10000 }, // $500 lost
    openPositions: [],
    closedToday: [],
  });
  assert.equal(rules.dailyLossLimitHit, true);
  assert.equal(rules.canTrade, false);
});

test("within limits allows trading", () => {
  seedToday(10000);
  const rules = checkChallengeRules({
    accountStatus: { equity: 9950, balance: 10000 }, // $50 lost, under budget
    openPositions: [],
    closedToday: [],
  });
  assert.equal(rules.dailyLossLimitHit, false);
  assert.equal(rules.canTrade, true);
});

test("position size = risk / (slPips * pipValue)", () => {
  // riskPerTradePct default 0.5% of $10,000 = $50 ; $50 / (20 * $10) = 0.25 lots
  const r = computeRiskPositionSize({ equity: 10000, symbol: "EURUSD", slPips: 20, pipValue: 10 });
  assert.ok(Math.abs(r.lots - 0.25) < 1e-9, `expected 0.25, got ${r.lots}`);
});

test("trailing stop uses JPY pip size (0.01)", () => {
  const r = evaluateTrailingStop({
    position: { type: "buy", symbol: "USDJPY", openPrice: 150.0, sl: 149.5 },
    currentPrice: 150.4, // +40 pips at 0.01 pip
  });
  assert.ok(r, "should activate trailing");
  // newSL = 150.40 - distance(5) * 0.01 = 150.35
  assert.ok(Math.abs(r.newSL - 150.35) < 1e-6, `newSL ${r.newSL}`);
});

test("time decay flags a stagnant losing trade but not a winner", () => {
  const openTime = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  assert.ok(evaluateTimeDecay({ position: { openTime, profit: -10 }, maxHours: 4 }));
  assert.equal(evaluateTimeDecay({ position: { openTime, profit: 5 }, maxHours: 4 }), null);
});
