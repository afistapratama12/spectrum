/**
 * Broker reconciliation (B2) — the broker is the source of truth.
 *
 * The local state registry can drift from reality: the process may crash after
 * an order fills but before it's tracked, a position may be closed manually in
 * the broker UI, or another process may have acted. Reconciliation pulls the
 * broker's live positions and repairs local state on startup and periodically:
 *
 *  - ADOPT  — a position open at the broker but missing locally is tracked.
 *  - CLOSE  — a locally-open ("phantom") trade no longer at the broker is
 *             marked closed so risk math and reporting stay honest.
 *
 * Pending orders are read for visibility only; they carry no open risk and are
 * not mirrored in the trade registry.
 */

import { getOpenPositions, getPendingOrders, getTodayClosedTrades } from "./broker/account.js";
import {
  getTrackedTrades,
  getOpenTrackedTrades,
  trackTrade,
  recordTradeClose,
  syncOpenTrades,
} from "./state.js";
import { log } from "./logger.js";

export async function reconcile() {
  let positions = [];
  try {
    positions = await getOpenPositions();
  } catch (e) {
    log("reconcile_error", `getOpenPositions failed — skipping reconcile: ${e.message}`);
    return { skipped: true, reason: e.message };
  }

  const brokerIds = new Set(positions.map((p) => String(p.id ?? p.ticket)));
  const trackedById = new Map(
    getTrackedTrades().map((t) => [String(t.id ?? t.ticket), t])
  );

  let adopted = 0;
  let closedPhantom = 0;

  // ADOPT: broker positions we aren't tracking yet
  for (const p of positions) {
    const id = String(p.id ?? p.ticket);
    if (!trackedById.has(id)) {
      trackTrade({
        ticket: id,
        symbol: p.symbol,
        type: p.type,
        volume: p.volume,
        openPrice: p.openPrice,
        sl: p.sl ?? null,
        tp: p.tp ?? null,
        reason: "adopted via reconcile",
      });
      adopted++;
      log("reconcile", `Adopted untracked broker position ${id} (${p.symbol} ${p.type})`);
    }
  }

  // Pull today's closed deals so externally-closed trades get their real P&L
  // instead of a placeholder 0 (B3).
  let closedDeals = [];
  try {
    closedDeals = await getTodayClosedTrades();
  } catch {
    // best-effort — fall back to 0 P&L
  }
  const realizedFor = (id) => {
    const d = closedDeals.find(
      (x) => String(x.positionId ?? x.orderId ?? x.id ?? x.ticket) === id
    );
    if (!d) return null;
    return {
      pnl: Number(d.profit ?? d.pnl ?? d.realizedProfit ?? 0) || 0,
      closePrice: Number(d.price ?? d.closePrice ?? d.close_price ?? 0) || null,
    };
  };

  // CLOSE: locally-open trades the broker no longer reports
  for (const t of getOpenTrackedTrades()) {
    const id = String(t.id ?? t.ticket);
    if (!brokerIds.has(id)) {
      const realized = realizedFor(id);
      recordTradeClose({
        ticket: id,
        closePrice: realized?.closePrice ?? t.closePrice ?? t.tp ?? t.openPrice ?? 0,
        pnl: realized?.pnl ?? t.pnl ?? 0,
        reason: realized ? "reconciled: closed on broker" : "reconciled: not open on broker",
      });
      closedPhantom++;
      log("reconcile", `Closed phantom local trade ${id} (${t.symbol})${realized ? ` — realized P&L $${realized.pnl.toFixed(2)}` : " — gone from broker"}`);
    }
  }

  // Align openTradeIds with broker truth
  syncOpenTrades([...brokerIds]);

  let pendingCount = 0;
  try {
    pendingCount = (await getPendingOrders()).length;
  } catch {
    // visibility only — ignore
  }

  if (adopted || closedPhantom) {
    log("reconcile", `Done — adopted ${adopted}, closed ${closedPhantom} phantom(s). Broker open: ${positions.length}, pending: ${pendingCount}`);
  }

  return { brokerOpen: positions.length, pending: pendingCount, adopted, closedPhantom };
}
