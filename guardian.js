/**
 * Equity Guardian — real-time safety net.
 *
 * The scanner/manager cron cycles only run every several minutes, so a fast
 * market move (news spike, gap) could blow through the daily-loss or total
 * drawdown limit between cycles. The guardian polls equity on a short interval
 * and, when the account approaches a limit, it CLOSES ALL POSITIONS and halts
 * new entries for the rest of the UTC day.
 *
 * Triggers act *before* the hard limit (default 90% of the budget) to leave
 * room for slippage on the emergency close. All thresholds are configurable.
 */

import { getAccountStatus, getOpenPositions } from "./broker/account.js";
import { checkChallengeRules, updateDailySnapshot } from "./risk-manager.js";
import { haltTrading, isTradingHalted } from "./trading-halt.js";
import { executeTool } from "./tools/executor.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { sendMessage, isEnabled as telegramEnabled } from "./telegram.js";

let _timer = null;
let _busy = false;

export async function guardianTick() {
  if (_busy) return;
  _busy = true;
  try {
    const account = await getAccountStatus();
    updateDailySnapshot(account); // keep peak/trough fresh for drawdown math
    const positions = await getOpenPositions();
    const rules = checkChallengeRules({ accountStatus: account, openPositions: positions, closedToday: [] });

    const dailyTrigger = config.risk.guardianDailyLossTriggerPct ?? 0.9;
    const ddTrigger = config.risk.guardianTotalDDTriggerPct ?? 0.9;

    const maxDailyLoss = rules.todayStartEquity * (config.challenge.maxDailyLossPct / 100);
    const dailyLossFrac = maxDailyLoss > 0 ? rules.dailyLossUsed / maxDailyLoss : 0;
    const ddFrac = config.challenge.maxTotalLossPct > 0 ? rules.totalDrawdownPct / config.challenge.maxTotalLossPct : 0;

    const breaches = [];
    if (rules.dailyLossLimitHit || dailyLossFrac >= dailyTrigger) {
      breaches.push(`daily loss ${(dailyLossFrac * 100).toFixed(0)}% of budget ($${rules.dailyLossUsed.toFixed(2)}/$${maxDailyLoss.toFixed(2)})`);
    }
    if (rules.totalLossLimitHit || ddFrac >= ddTrigger) {
      breaches.push(`drawdown ${rules.totalDrawdownPct.toFixed(2)}% of ${config.challenge.maxTotalLossPct}% max`);
    }

    if (breaches.length === 0) return;
    if (isTradingHalted()) return; // already handled today

    const reason = `🛑 EQUITY GUARDIAN: ${breaches.join(" + ")}`;
    log("guardian", `${reason} — closing all positions & halting until next UTC day`);
    haltTrading(reason);

    if (positions.length > 0) {
      try {
        await executeTool("close_all_trades", { reason });
      } catch (e) {
        log("guardian_error", `close_all failed: ${e.message}`);
      }
    }

    if (telegramEnabled()) {
      sendMessage(`${reason}\n\nAll positions closed. New entries blocked until tomorrow (UTC).\nEquity: $${account.equity.toFixed(2)}`).catch(() => {});
    }
  } catch (e) {
    log("guardian_error", `tick failed: ${e.message}`);
  } finally {
    _busy = false;
  }
}

export function startGuardian() {
  stopGuardian();
  const sec = Math.max(10, config.schedule.guardianIntervalSec ?? 45);
  _timer = setInterval(() => { guardianTick().catch(() => {}); }, sec * 1000);
  if (typeof _timer.unref === "function") _timer.unref();
  log(
    "guardian",
    `Equity Guardian active — checking every ${sec}s (daily-loss trigger ${((config.risk.guardianDailyLossTriggerPct ?? 0.9) * 100).toFixed(0)}%, DD trigger ${((config.risk.guardianTotalDDTriggerPct ?? 0.9) * 100).toFixed(0)}%)`
  );
  guardianTick().catch(() => {}); // run an immediate first check
}

export function stopGuardian() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
