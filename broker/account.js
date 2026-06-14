import * as tradelockerAccount from "../tradelocker/account.js";
import * as metaapiAccount from "../metaapi/account.js";

const impl = process.env.BROKER === "metaapi" ? metaapiAccount : tradelockerAccount;

export const getAccountStatus = (...args) => impl.getAccountStatus(...args);
export const getOpenPositions = (...args) => impl.getOpenPositions(...args);
export const getPendingOrders = (...args) => impl.getPendingOrders(...args);
export const getTodayClosedTrades = (...args) => impl.getTodayClosedTrades(...args);
