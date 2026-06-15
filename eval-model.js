/**
 * Model evaluation harness (B6).
 *
 * Runs the real SCANNER agent loop N times against a candidate model (in
 * DRY_RUN — no live orders) and scores what actually matters for this app:
 * tool-calling reliability, process adherence, decision validity, latency, and
 * action stability. This lets you *qualify a cheap model empirically* — "does
 * DeepSeek/Kimi call tools reliably and follow the process?" — instead of
 * trusting a leaderboard.
 *
 * It does NOT measure trading alpha (that's what backtests are for); it measures
 * whether the model can drive the agent correctly.
 */

import { agentLoop } from "./agent.js";
import { config } from "./config.js";

const SCANNER_GOAL = `SCANNER CYCLE

Follow the mandatory steps in the system prompt:
1. Check news first
2. Check rules
3. Scan markets
4. Only deploy if you have REAL conviction — no trade is better than a bad trade
5. Report result in 1-3 lines.`;

// A disciplined scanner must verify rules and scan before deciding.
const EXPECTED_TOOLS = ["check_challenge_rules", "scan_markets"];

function classifyAction(uniqueTools) {
  if (uniqueTools.includes("place_trade")) return "market";
  if (uniqueTools.includes("place_pending_order")) return "pending";
  return "skip";
}

export async function evalModel(model, { runs = 5, role = "SCANNER" } = {}) {
  // Hard safety: never place a live order during an eval.
  process.env.DRY_RUN = "true";

  const results = [];
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    let r;
    try {
      r = await agentLoop(SCANNER_GOAL, config.llm.maxSteps, [], role, model, 2048);
    } catch (e) {
      r = { error: e.message, toolsUsed: [], steps: 0, content: "" };
    }
    const durationMs = Date.now() - t0;
    const toolsUsed = r.toolsUsed || [];
    const uniqueTools = [...new Set(toolsUsed)];

    results.push({
      run: i + 1,
      ok: !r.error,
      error: r.error || null,
      calledAnyTool: toolsUsed.length > 0,
      followedProcess: EXPECTED_TOOLS.every((t) => uniqueTools.includes(t)),
      action: classifyAction(uniqueTools),
      toolCount: toolsUsed.length,
      uniqueTools,
      steps: r.steps || 0,
      maxStepsReached: !!r.maxStepsReached,
      hasDecisionText: !!(r.content && r.content.trim().length > 0),
      durationMs,
    });
  }

  return { model, runs, scorecard: aggregate(results), runsDetail: results };
}

function aggregate(results) {
  const n = results.length || 1;
  const pct = (pred) => Math.round((results.filter(pred).length / n) * 100);
  const avg = (f) => Math.round(results.reduce((s, r) => s + f(r), 0) / n);

  const actions = { market: 0, pending: 0, skip: 0 };
  for (const r of results) actions[r.action]++;

  // Action stability: share of runs landing on the most common action.
  const topAction = Math.max(actions.market, actions.pending, actions.skip);
  const stability = Math.round((topAction / n) * 100);

  return {
    completionRate: pct((r) => r.ok),
    toolCallReliability: pct((r) => r.calledAnyTool),
    processAdherence: pct((r) => r.followedProcess),
    validDecisionRate: pct((r) => r.hasDecisionText),
    maxStepsHitRate: pct((r) => r.maxStepsReached),
    actionStability: stability,
    avgSteps: avg((r) => r.steps),
    avgDurationMs: avg((r) => r.durationMs),
    actionDistribution: actions,
    errors: results.filter((r) => r.error).map((r) => r.error),
  };
}
