import { post, put, del, getDefaultAccountId } from "./client.js";
import { log } from "../logger.js";

function normalizeType(type) {
  const t = type.toLowerCase();
  if (t === "buy") return "POSITION_TYPE_BUY";
  if (t === "sell") return "POSITION_TYPE_SELL";
  return type;
}

export async function placeOrder({
  symbol,
  type,
  volume,
  sl = null,
  tp = null,
  orderType = "market",
  price = null,
  comment = "",
}) {
  const body = {
    symbol,
    type: normalizeType(type),
    volume,
    comment: comment || "Spectrun AI",
  };

  if (orderType === "limit" && price) body.price = price;
  if (sl) body.stopLoss = sl;
  if (tp) body.takeProfit = tp;

  log("metaapi", `Placing ${type.toUpperCase()} ${volume} lots ${symbol} @ ${price || "market"}${sl ? ` SL:${sl}` : ""}${tp ? ` TP:${tp}` : ""}`);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_place: body,
      message: `DRY RUN — would place ${type} ${volume} ${symbol}`,
    };
  }

  const accountId = await getDefaultAccountId();

  try {
    const result = await post(`/users/current/accounts/${accountId}/trade`, {
      actionType: "POSITION_OPEN",
      ...body,
    });
    log("metaapi", `Order placed: ${result.orderId || result.positionId || result.ticket || "ok"}`);
    return {
      success: true,
      ticket: result.orderId || result.positionId || result.ticket || result.id,
      symbol,
      type,
      volume,
      openPrice: result.price || result.openPrice || price,
      sl: result.stopLoss || sl,
      tp: result.takeProfit || tp,
    };
  } catch (error) {
    log("metaapi_error", `placeOrder failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function modifyPosition({ positionId, sl = null, tp = null }) {
  const body = {};
  if (sl != null) body.stopLoss = sl;
  if (tp != null) body.takeProfit = tp;

  if (Object.keys(body).length === 0) {
    return { success: false, error: "No SL or TP provided to modify" };
  }

  log("metaapi", `Modifying position ${positionId}: ${JSON.stringify(body)}`);

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_modify: { positionId, ...body } };
  }

  const accountId = await getDefaultAccountId();

  try {
    await put(`/users/current/accounts/${accountId}/positions/${positionId}`, body);
    return { success: true, positionId, ...body };
  } catch (error) {
    log("metaapi_error", `modifyPosition failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function closePosition({ positionId, volume = null }) {
  log("metaapi", `Closing position ${positionId}${volume ? ` (partial: ${volume} lots)` : ""}`);

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: positionId, volume };
  }

  const accountId = await getDefaultAccountId();

  try {
    const body = { actionType: "POSITION_CLOSE", positionId };
    if (volume) body.volume = volume;
    const result = await post(`/users/current/accounts/${accountId}/trade`, body);
    return {
      success: true,
      positionId,
      closePrice: result?.closePrice || result?.price || null,
      profit: result?.profit || result?.pnl || 0,
    };
  } catch (error) {
    log("metaapi_error", `closePosition failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function closeAllPositions() {
  const { getOpenPositions } = await import("./account.js");
  const positions = await getOpenPositions();

  if (positions.length === 0) {
    return { closed: 0, message: "No open positions" };
  }

  log("metaapi", `Closing ALL ${positions.length} positions`);

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: positions.length };
  }

  const results = await Promise.allSettled(
    positions.map((p) => closePosition({ positionId: p.id }))
  );

  const succeeded = results.filter((r) => r.status === "fulfilled" && r.value?.success).length;
  return { closed: succeeded, total: positions.length };
}

export async function calculateLotSize({ equity, riskPct, slPips, symbol }) {
  const { getPipValue } = await import("./market-data.js");
  const pipValuePerLot = await getPipValue(symbol, 1.0);

  if (slPips <= 0 || pipValuePerLot <= 0) return 0.01;

  const riskAmount = equity * (riskPct / 100);
  const lotsRaw = riskAmount / (slPips * pipValuePerLot);
  const lots = Math.floor(lotsRaw * 100) / 100;

  return Math.max(0.01, lots);
}
