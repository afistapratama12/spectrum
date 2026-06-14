import * as tradelockerClient from "../tradelocker/client.js";
import * as metaapiClient from "../metaapi/client.js";

const impl = process.env.BROKER === "metaapi" ? metaapiClient : tradelockerClient;

export const connectWebSocket = (...args) => impl.connectWebSocket(...args);
export const disconnectWebSocket = (...args) => impl.disconnectWebSocket(...args);
export const subscribePrice = (...args) => impl.subscribePrice(...args);
export const unsubscribePrice = (...args) => impl.unsubscribePrice(...args);
export const getDefaultAccountId = (...args) => impl.getDefaultAccountId(...args);
