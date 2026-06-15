import dotenv from "dotenv";
import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

dotenv.config({ path: repoPath(".env") });

const USER_CONFIG_PATH = repoPath("user-config.json");

function readUserConfig() {
  if (!fs.existsSync(USER_CONFIG_PATH)) {
    log("config", `No ${USER_CONFIG_PATH} found — using defaults. Run "npm run setup" to create one.`);
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch (error) {
    log("config_warn", `Invalid ${USER_CONFIG_PATH}: ${error.message}`);
    return {};
  }
}

const userConfig = readUserConfig();

function mergeDefault(target, defaults) {
  for (const key of Object.keys(defaults)) {
    if (target[key] === undefined) target[key] = defaults[key];
    else if (typeof defaults[key] === "object" && !Array.isArray(defaults[key]) && defaults[key] !== null) {
      if (typeof target[key] !== "object" || target[key] === null) target[key] = {};
      mergeDefault(target[key], defaults[key]);
    }
  }
}

const DEFAULTS = {
  broker: {
    provider: process.env.BROKER || "tradelocker",
  },
  challenge: {
    phase: "evaluation",
    profitTargetPct: 4,
    maxDailyLossPct: 4,
    maxTotalLossPct: 8,
    minTradingDays: 4,
    consistencyMinPct: 25,
    timeLimitDays: 30,
    maxOpenPositions: 3,
    weekendHolding: false,
    allowedSessions: ["London", "New York"],
    newsBufferMinutes: 15,
    minRiskRewardRatio: 1.5,
  },
  risk: {
    riskPerTradePct: 0.5,
    maxDailyTrades: 5,
    maxConsecutiveLosses: 3,
    consecutiveLossCooldownMinutes: 60,
    trailingStopEnabled: true,
    trailingTriggerPips: 10,
    trailingDistancePips: 5,
    partialCloseEnabled: false,
    partialClosePct: 50,
    guardianDailyLossTriggerPct: 0.9,
    guardianTotalDDTriggerPct: 0.9,
    maxCandleAgeMin: 10,
  },
  strategy: {
    trendTimeframes: ["1h", "4h", "1D"],
    entryTimeframes: ["5m", "15m"],
    allowedPairs: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "NZDUSD", "EURGBP", "EURJPY"],
    minATRMultiplier: 1.5,
    requireTrendAlignment: true,
    requireSessionVolume: true,
    avoidHighImpactNewsPairs: true,
  },
  schedule: {
    scannerIntervalMin: 30,
    managerIntervalMin: 10,
    healthCheckIntervalMin: 60,
    dailyBriefingHourUTC: 1,
    reportIntervalHours: 12,
    guardianIntervalSec: 45,
    reconcileIntervalMin: 5,
  },
  llm: {
    scannerModel: process.env.LLM_MODEL || "openrouter/healer-alpha",
    managerModel: process.env.LLM_MODEL || "openrouter/healer-alpha",
    generalModel: process.env.LLM_MODEL || "openrouter/healer-alpha",
    fallbackModels: [],
    temperature: 0.3,
    maxTokens: 4096,
    maxSteps: 10,
  },
};

// ─── Trading style presets ────────────────────────────────────────
// The user only picks a style; these fill the detailed knobs. Anything the
// user set explicitly in user-config.json still wins (mergeDefault only fills
// undefined fields), so a preset is a starting point, not a lock-in.
const STYLE_PRESETS = {
  scalping: {
    strategy: { trendTimeframes: ["15m", "1h"], entryTimeframes: ["1m", "5m"] },
    risk: { riskPerTradePct: 0.5, trailingTriggerPips: 6, trailingDistancePips: 3 },
    challenge: { minRiskRewardRatio: 1.2 },
    schedule: { scannerIntervalMin: 5, managerIntervalMin: 2 },
  },
  intraday: {
    strategy: { trendTimeframes: ["1h", "4h"], entryTimeframes: ["5m", "15m"] },
    risk: { riskPerTradePct: 0.5, trailingTriggerPips: 10, trailingDistancePips: 5 },
    challenge: { minRiskRewardRatio: 1.5 },
    schedule: { scannerIntervalMin: 30, managerIntervalMin: 10 },
  },
  swing: {
    strategy: { trendTimeframes: ["4h", "1D"], entryTimeframes: ["1h", "4h"] },
    risk: { riskPerTradePct: 0.75, trailingTriggerPips: 25, trailingDistancePips: 12 },
    challenge: { minRiskRewardRatio: 2, weekendHolding: true },
    schedule: { scannerIntervalMin: 120, managerIntervalMin: 30 },
  },
};

const tradingStyle = String(userConfig.tradingStyle || userConfig.strategy?.tradingStyle || "").toLowerCase();
if (tradingStyle) {
  if (STYLE_PRESETS[tradingStyle]) {
    mergeDefault(userConfig, STYLE_PRESETS[tradingStyle]);
    log("config", `Trading style preset applied: ${tradingStyle}`);
  } else {
    log("config_warn", `Unknown tradingStyle "${tradingStyle}" — valid: ${Object.keys(STYLE_PRESETS).join(", ")}`);
  }
}

mergeDefault(userConfig, DEFAULTS);

// Override with env vars if explicitly set
if (process.env.MAX_DAILY_LOSS_PCT) userConfig.challenge.maxDailyLossPct = Number(process.env.MAX_DAILY_LOSS_PCT);
if (process.env.MAX_TOTAL_LOSS_PCT) userConfig.challenge.maxTotalLossPct = Number(process.env.MAX_TOTAL_LOSS_PCT);
if (process.env.PROFIT_TARGET_PCT) userConfig.challenge.profitTargetPct = Number(process.env.PROFIT_TARGET_PCT);

export const config = userConfig;

export function reloadUserConfig() {
  const fresh = readUserConfig();
  mergeDefault(fresh, DEFAULTS);
  Object.assign(userConfig, fresh);
  log("config", "User config reloaded.");
}

/** Compute max position size in lots based on account equity, risk %, and SL pips. */
export function computePositionSize({ equity, riskPct, slPips, pipValue = 10 }) {
  const riskAmount = equity * (riskPct / 100);
  if (slPips <= 0) return 0;
  const lots = riskAmount / (slPips * pipValue);
  return Math.round(lots * 100) / 100;
}

export function formatCurrency(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0.00";
  return "$" + n.toFixed(decimals);
}

export function formatPct(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00%";
  return (n >= 0 ? "+" : "") + n.toFixed(decimals) + "%";
}
