import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNewsBuffer, formatNewsForPrompt } from "../news.js";

const soon = () => new Date(Date.now() + 5 * 60000).toISOString();
const highImpactEUR = () => ({ currency: "EUR", event: "CPI", time: soon(), impact: 3, impactSeverity: 4 });

test("checkNewsBuffer accepts the getForexNews() object form and blocks", () => {
  const res = checkNewsBuffer({ symbol: "EURUSD", newsEvents: { events: [highImpactEUR()] } });
  assert.equal(res.blocked, true);
});

test("checkNewsBuffer accepts a plain array and blocks", () => {
  const res = checkNewsBuffer({ symbol: "EURUSD", newsEvents: [highImpactEUR()] });
  assert.equal(res.blocked, true);
});

test("checkNewsBuffer is clear with no relevant events", () => {
  assert.equal(checkNewsBuffer({ symbol: "EURUSD", newsEvents: { events: [] } }).blocked, false);
});

test("formatNewsForPrompt tolerates the object form", () => {
  assert.doesNotThrow(() => formatNewsForPrompt({ events: [] }));
  assert.doesNotThrow(() => formatNewsForPrompt([]));
});
