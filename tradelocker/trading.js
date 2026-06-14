import { post, put, del, getDefaultAccountId } from "./client.js";
import { log } from "../logger.js";

/**
 * Place a market or limit order with SL and TP.
 *
 * @param {Object} params
 * @param {string} params.symbol       — e.g. "EURUSD"
 * @param {string} params.type         — "buy" or "sell"
 * @param {number} params.volume       — lot size (e.g. 0.10)
 * @param {number} params.sl           — stop loss price (optional but recommended)
 * @param {number} params.tp           — take profit price (optional but recommended)
 * @param {string} params.orderType    — "market" (default) or "limit"
 * @param {number} params.price        — limit price (required for limit orders)
 * @param {string} params.comment      — optional comment
 */
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
    type: type.toLowerCase(),
    volume,
    orderType: orderType.toLowerCase(),
    comment: comment || "Spectrun AI",
  };

  if (orderType === "limit" && price) body.price = price;
  if (sl) body.stopLoss = sl;
  if (tp) body.takeProfit = tp;

  log("trading", `Placing ${type.toUpperCase()} ${volume} lots ${symbol} @ ${price || "market"}${sl ? ` SL:${sl}` : ""}${tp ? ` TP:${tp}` : ""}`);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_place: body,
      message: `DRY RUN — would place ${type} ${volume} ${symbol}`,
    };
  }

  const accountId = await getDefaultAccountId();

  try {
    const result = await post(`/v1/trade/accounts/${accountId}/orders`, body);
    log("trading", `Order placed: ${result.ticket || result.orderId || "ok"}`);
    return {
      success: true,
      ticket: result.ticket || result.orderId || result.id,
      symbol,
      type,
      volume,
      openPrice: result.price || result.openPrice || price,
      sl: result.sl || sl,
      tp: result.tp || tp,
    };
  } catch (error) {
    log("trading_error", `placeOrder failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Place a pending order (buy/sell × stop/limit) at a specific entry price.
 */
export async function placePendingOrder({
  symbol,
  type,
  orderType,
  volume,
  price,
  sl = null,
  tp = null,
  comment = "",
}) {
  const o = String(orderType).toLowerCase();
  if (o !== "stop" && o !== "limit") {
    return { success: false, error: `Invalid pending order type: ${orderType}` };
  }

  const body = {
    symbol,
    type: String(type).toLowerCase(),
    volume,
    orderType: o,
    price,
    comment: comment || "Spectrun AI",
  };
  if (sl) body.stopLoss = sl;
  if (tp) body.takeProfit = tp;

  log("trading", `Placing PENDING ${type.toUpperCase()} ${o.toUpperCase()} ${volume} lots ${symbol} @ ${price}${sl ? ` SL:${sl}` : ""}${tp ? ` TP:${tp}` : ""}`);

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_place: body, message: `DRY RUN — would place ${type} ${o} ${volume} ${symbol} @ ${price}` };
  }

  const accountId = await getDefaultAccountId();
  try {
    const result = await post(`/v1/trade/accounts/${accountId}/orders`, body);
    log("trading", `Pending order placed: ${result.ticket || result.orderId || "ok"}`);
    return {
      success: true,
      ticket: result.ticket || result.orderId || result.id,
      symbol, type, orderType: o, volume, price, sl, tp, pending: true,
    };
  } catch (error) {
    log("trading_error", `placePendingOrder failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Cancel a pending order by its order ID.
 */
export async function cancelOrder({ orderId }) {
  log("trading", `Cancelling pending order ${orderId}`);

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_cancel: orderId };
  }

  const accountId = await getDefaultAccountId();
  try {
    await del(`/v1/trade/accounts/${accountId}/orders/${orderId}`);
    return { success: true, orderId };
  } catch (error) {
    log("trading_error", `cancelOrder failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Modify an open position's SL and/or TP.
 */
export async function modifyPosition({ positionId, sl = null, tp = null }) {
  const body = {};
  if (sl != null) body.stopLoss = sl;
  if (tp != null) body.takeProfit = tp;

  if (Object.keys(body).length === 0) {
    return { success: false, error: "No SL or TP provided to modify" };
  }

  log("trading", `Modifying position ${positionId}: ${JSON.stringify(body)}`);

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_modify: { positionId, ...body } };
  }

  const accountId = await getDefaultAccountId();

  try {
    await put(`/v1/trade/accounts/${accountId}/orders/${positionId}`, body);
    return { success: true, positionId, ...body };
  } catch (error) {
    log("trading_error", `modifyPosition failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Close a specific position. Optionally close only a percentage.
 */
export async function closePosition({ positionId, volume = null }) {
  log("trading", `Closing position ${positionId}${volume ? ` (partial: ${volume} lots)` : ""}`);

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: positionId, volume };
  }

  const accountId = await getDefaultAccountId();

  try {
    const result = await del(`/v1/trade/accounts/${accountId}/orders/${positionId}`);
    return {
      success: true,
      positionId,
      closePrice: result?.closePrice || result?.price || null,
      profit: result?.profit || result?.pnl || 0,
    };
  } catch (error) {
    log("trading_error", `closePosition failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Close all open positions. Emergency use only.
 */
export async function closeAllPositions() {
  const { getOpenPositions } = await import("./account.js");
  const positions = await getOpenPositions();

  if (positions.length === 0) {
    return { closed: 0, message: "No open positions" };
  }

  log("trading", `Closing ALL ${positions.length} positions`);

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: positions.length };
  }

  const results = await Promise.allSettled(
    positions.map((p) => closePosition({ positionId: p.id }))
  );

  const succeeded = results.filter((r) => r.status === "fulfilled" && r.value?.success).length;
  return { closed: succeeded, total: positions.length };
}

/**
 * Calculate lot size from account equity, risk %, and stop loss in pips.
 */
export async function calculateLotSize({ equity, riskPct, slPips, symbol }) {
  const { getPipValue } = await import("./market-data.js");
  const pipValuePerLot = await getPipValue(symbol, 1.0);

  if (slPips <= 0 || pipValuePerLot <= 0) return 0.01;

  const riskAmount = equity * (riskPct / 100);
  const lotsRaw = riskAmount / (slPips * pipValuePerLot);

  // Round down to nearest step (0.01)
  const lots = Math.floor(lotsRaw * 100) / 100;

  return Math.max(0.01, lots);
}
