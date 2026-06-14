import * as tradelockerMarket from "../tradelocker/market-data.js";
import * as metaapiMarket from "../metaapi/market-data.js";

const impl = process.env.BROKER === "metaapi" ? metaapiMarket : tradelockerMarket;

export const getOHLCV = (...args) => impl.getOHLCV(...args);
export const getInstrumentSpecs = (...args) => impl.getInstrumentSpecs(...args);
export const getPipValue = (...args) => impl.getPipValue(...args);
export const calculateATR = (...args) => impl.calculateATR(...args);
export const calculateEMA = (...args) => impl.calculateEMA(...args);
export const calculateRSI = (...args) => impl.calculateRSI(...args);
export const determineTrend = (...args) => impl.determineTrend(...args);
