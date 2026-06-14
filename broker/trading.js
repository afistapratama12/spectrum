import * as tradelockerTrading from "../tradelocker/trading.js";
import * as metaapiTrading from "../metaapi/trading.js";

const impl = process.env.BROKER === "metaapi" ? metaapiTrading : tradelockerTrading;

export const placeOrder = (...args) => impl.placeOrder(...args);
export const placePendingOrder = (...args) => impl.placePendingOrder(...args);
export const cancelOrder = (...args) => impl.cancelOrder(...args);
export const modifyPosition = (...args) => impl.modifyPosition(...args);
export const closePosition = (...args) => impl.closePosition(...args);
export const closeAllPositions = (...args) => impl.closeAllPositions(...args);
export const calculateLotSize = (...args) => impl.calculateLotSize(...args);
