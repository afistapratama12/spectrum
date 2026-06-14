import { get, getDefaultAccountId } from "./client.js";
import { log } from "../logger.js";

const DRY_RUN_MODE = process.env.DRY_RUN === "true" && (!process.env.METAAPI_API_KEY || !process.env.METAAPI_ACCOUNT_ID);

function dummyAccount() {
  return {
    accountId: "dry-run-metaapi",
    balance: 100_000,
    equity: 100_000,
    margin: 0,
    freeMargin: 100_000,
    marginLevel: 0,
    profit: 0,
    currency: "USD",
    leverage: 100,
    isDemo: true,
  };
}

export async function getAccountStatus() {
  if (DRY_RUN_MODE) return dummyAccount();

  const accountId = await getDefaultAccountId();
  const data = await get(`/users/current/accounts/${accountId}/account-information`);

  return {
    accountId,
    balance: parseFloat(data.balance ?? 0),
    equity: parseFloat(data.equity ?? 0),
    margin: parseFloat(data.margin ?? 0),
    freeMargin: parseFloat(data.freeMargin ?? data.free_margin ?? 0),
    marginLevel: parseFloat(data.marginLevel ?? data.margin_level ?? 0),
    profit: parseFloat(data.profit ?? data.unrealizedProfit ?? 0),
    currency: data.currency || "USD",
    leverage: data.leverage || 100,
    isDemo: !(data.type === "real" || data.isReal),
  };
}

export async function getOpenPositions() {
  if (DRY_RUN_MODE) return [];

  try {
    const accountId = await getDefaultAccountId();
    const data = await get(`/users/current/accounts/${accountId}/positions`);
    const positions = Array.isArray(data) ? data : (data?.positions || data?.data || []);

    return positions.map((p) => ({
      id: p.id || p.positionId,
      ticket: p.id || p.positionId || p.ticket,
      symbol: p.symbol || p.instrument,
      type: (p.type || "").replace("POSITION_TYPE_", "").toLowerCase(),
      volume: parseFloat(p.volume || p.lots || 0),
      openPrice: parseFloat(p.openPrice || p.open_price || p.price || 0),
      currentPrice: parseFloat(p.currentPrice || p.current_price || p.currentTickPrice || 0),
      sl: parseFloat(p.stopLoss || p.sl || 0) || null,
      tp: parseFloat(p.takeProfit || p.tp || 0) || null,
      profit: parseFloat(p.profit || p.unrealizedProfit || p.pnl || 0),
      profitPct: parseFloat(p.profitPct || p.pnlPct || 0),
      swap: parseFloat(p.swap || p.commission || 0),
      openTime: p.time || p.openTime || p.open_time || p.createdAt,
      comment: p.comment || "",
    }));
  } catch (error) {
    log("metaapi_warn", `getOpenPositions failed: ${error.message}`);
    return [];
  }
}

export async function getPendingOrders() {
  try {
    const accountId = await getDefaultAccountId();
    const data = await get(`/users/current/accounts/${accountId}/orders`);
    return Array.isArray(data) ? data : (data?.orders || []);
  } catch (error) {
    log("metaapi_warn", `getPendingOrders failed: ${error.message}`);
    return [];
  }
}

export async function getTodayClosedTrades() {
  if (DRY_RUN_MODE) return [];

  try {
    const accountId = await getDefaultAccountId();
    const today = new Date().toISOString().slice(0, 10);
    const data = await get(`/users/current/accounts/${accountId}/history-deals`, {
      from: `${today}T00:00:00Z`,
      to: new Date().toISOString(),
    });
    const trades = Array.isArray(data) ? data : (data?.deals || data?.history || []);
    return trades.filter((t) => t.closed || t.closeTime || t.close_time);
  } catch (error) {
    log("metaapi_warn", `getTodayClosedTrades failed: ${error.message}`);
    return [];
  }
}
