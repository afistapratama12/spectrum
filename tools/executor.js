import { getAccountStatus, getOpenPositions, getPendingOrders, getTodayClosedTrades } from "../broker/account.js";
import { getOHLCV, getInstrumentSpecs, calculateATR, calculateRSI, calculateEMA, determineTrend } from "../broker/market-data.js";
import { placeOrder, placePendingOrder, cancelOrder, modifyPosition, closePosition, closeAllPositions, calculateLotSize } from "../broker/trading.js";
import { getForexNews, checkNewsBuffer as checkNews, formatNewsForPrompt } from "../news.js";
import { checkChallengeRules, computeRiskPositionSize, evaluateTrailingStop, evaluateTimeDecay, getRiskReport, updateDailySnapshot, checkPhaseTransition } from "../risk-manager.js";
import { trackTrade, recordTradeClose, getOpenTrackedTrades, getTrackedTrades, setTradeInstruction, recordTrailingActivation, recordChallengePhase, getStateSummary, syncOpenTrades } from "../state.js";
import { config, reloadUserConfig } from "../config.js";
import { log, logAction } from "../logger.js";
import { getRecentDecisions, appendDecision } from "../decision-log.js";
import { recordPerformance, getPerformanceHistory, getPerformanceSummary, addLesson, getPatternReport, getPausedStrategies, resumeStrategy } from "../lessons.js";
import { STRATEGIES, getStrategiesByType, getStrategiesForSession, getStrategy, getActiveSession, isStrategyValid, scorePairForStrategy, calculateStrategySLTP } from "../strategies/index.js";
import { recordTradeForConsistency, getConsistencyReport, checkDailyConsistency, getStrategyUsageReport } from "../consistency-tracker.js";
import { queryJournal, getJournalAnalytics } from "../trading-journal.js";
import { getNewsCorrelations, getHighImpactEvents } from "../news.js";
import { runBacktest, listBacktestResults } from "../backtest/engine.js";
import { isTradingHalted, getHaltReason } from "../trading-halt.js";
import fs from "fs";
import { repoPath } from "../repo-root.js";
import { writeJSONAtomic } from "../storage.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

// ─── Instrument precision ─────────────────────────────────────────
// NEVER hardcode pip size. JPY pairs use 0.01, most FX 0.0001, and crypto/
// indices/metals vary wildly — so we always resolve from the broker's
// instrument specs and only fall back to symbol inference when unavailable.
const _precisionCache = new Map();

function inferPrecision(symbol) {
  const clean = String(symbol || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  const isJPY = clean.endsWith("JPY");
  const pipSize = isJPY ? 0.01 : 0.0001;
  return { pipSize, digits: isJPY ? 3 : 5, inferred: true };
}

async function getSymbolPrecision(symbol) {
  if (_precisionCache.has(symbol)) return _precisionCache.get(symbol);

  let precision = inferPrecision(symbol);
  try {
    const spec = await getInstrumentSpecs(symbol);
    if (spec && spec.pipSize > 0) {
      precision = {
        pipSize: spec.pipSize,
        digits: Number.isFinite(spec.digits) ? spec.digits : inferPrecision(symbol).digits,
        inferred: false,
      };
    }
  } catch {
    // keep inferred fallback
  }

  _precisionCache.set(symbol, precision);
  return precision;
}

function roundToDigits(price, digits) {
  return Number(Number(price).toFixed(digits));
}

// ─── Data freshness guard (B4) ────────────────────────────────────
// Never trade on stale or invalid prices — a dead feed, weekend, or gap can
// otherwise produce entries off a price that no longer exists.
function checkDataFreshness(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { stale: true, reason: "no candle data available" };
  }
  const last = candles[candles.length - 1];
  if (!(Number(last.close) > 0)) {
    return { stale: true, reason: `invalid last price (${last.close})` };
  }
  const maxAgeMin = config.risk.maxCandleAgeMin ?? 10;
  if (last.time) {
    const ageMin = (Date.now() - new Date(last.time).getTime()) / 60000;
    if (ageMin > maxAgeMin) {
      return { stale: true, reason: `stale market data — last candle ${ageMin.toFixed(1)}m old (max ${maxAgeMin}m)`, ageMin };
    }
  }
  return { stale: false };
}

// ─── Fill confirmation (B3) ───────────────────────────────────────
// The broker's order response is optimistic; poll positions to confirm the
// fill actually landed. We never blind-retry the order (that risks a double
// fill) — an unconfirmed fill is flagged and left for reconcile to verify.
async function confirmFill(ticket, { attempts = 3, delayMs = 1000 } = {}) {
  const id = String(ticket);
  for (let i = 0; i < attempts; i++) {
    try {
      const positions = await getOpenPositions();
      if (positions.some((p) => String(p.id ?? p.ticket) === id)) return true;
    } catch {
      // transient — retry
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// ─── Tool Implementations ─────────────────────────────────────────

export async function executeTool(name, args) {
  const startTime = Date.now();

  name = name.replace(/<.*$/, "").trim();

  const fn = toolMap[name];
  if (!fn) {
    return { error: `Unknown tool: ${name}` };
  }

  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: JSON.stringify(result).slice(0, 500),
      duration_ms: duration,
      success,
    });

    return result;
  } catch (error) {
    logAction({ tool: name, args, error: error.message, duration_ms: Date.now() - startTime, success: false });
    return { error: error.message, tool: name };
  }
}

// ─── Tool Map ─────────────────────────────────────────────────────

const toolMap = {
  get_account_status: async () => {
    const account = await getAccountStatus();
    const positions = await getOpenPositions();
    const closedToday = await getTodayClosedTrades();
    updateDailySnapshot(account);

    const rules = checkChallengeRules({ accountStatus: account, openPositions: positions, closedToday });

    return {
      account: {
        balance: account.balance,
        equity: account.equity,
        freeMargin: account.freeMargin,
        marginLevel: account.marginLevel,
        profit: account.profit,
        currency: account.currency,
        leverage: account.leverage,
      },
      risk: {
        ...rules,
      },
      positions: positions.length,
    };
  },

  check_challenge_rules: async () => {
    const account = await getAccountStatus();
    const positions = await getOpenPositions();
    const closedToday = await getTodayClosedTrades();
    return checkChallengeRules({ accountStatus: account, openPositions: positions, closedToday });
  },

  calculate_position_size: async ({ symbol, sl_pips }) => {
    const account = await getAccountStatus();
    const risk = computeRiskPositionSize({
      equity: account.equity,
      symbol,
      slPips: sl_pips,
    });
    return risk;
  },

  get_pair_analysis: async ({ symbol }) => {
    const strategy = config.strategy;

    // Fetch data for all timeframes in parallel
    const timeframes = [...new Set([...strategy.trendTimeframes, ...strategy.entryTimeframes])];

    const results = await Promise.allSettled(
      timeframes.map((tf) =>
        getOHLCV({ symbol, resolution: tf, count: 100 }).then((candles) => ({ tf, candles }))
      )
    );

    const dataByTf = {};
    for (const r of results) {
      if (r.status === "fulfilled") dataByTf[r.value.tf] = r.value.candles;
    }

    const entryTf = strategy.entryTimeframes[0] || "15m";
    const entryCandles = dataByTf[entryTf] || [];

    const rsi = calculateRSI(entryCandles.map((c) => c.close), 14);
    const atr = calculateATR(entryCandles, 14);
    const trend = determineTrend(dataByTf[strategy.trendTimeframes[0]] || []);
    const lastPrice = entryCandles.length > 0 ? entryCandles[entryCandles.length - 1].close : null;

    // Support and resistance (simple: recent swing highs/lows from entry TF)
    let support = null, resistance = null;
    if (entryCandles.length > 20) {
      const recent = entryCandles.slice(-20);
      support = Math.min(...recent.map((c) => c.low));
      resistance = Math.max(...recent.map((c) => c.high));
    }

    // Session info
    const hour = new Date().getUTCHours();
    let session = "Asian";
    if (hour >= 7 && hour < 16) session = "London";
    else if (hour >= 12 && hour < 21) session = "New York";
    if (hour >= 12 && hour < 16) session = "London/NY Overlap";

    const allowed = config.strategy.allowedPairs || [];
    const pairAllowed = allowed.includes(symbol);

    return {
      symbol,
      price: lastPrice,
      spread: null, // would need real-time data
      atr,
      rsi: Math.round(rsi * 100) / 100,
      trend,
      support,
      resistance,
      session,
      pairAllowed,
      timeframesAnalyzed: Object.keys(dataByTf),
    };
  },

  scan_markets: async ({ limit = 5, strategyType = null } = {}) => {
    const allowed = config.strategy.allowedPairs || [];
    if (allowed.length === 0) return { setups: [], error: "No pairs configured in strategy.allowedPairs" };

    const activeSession = getActiveSession();
    const validStrategies = Object.values(STRATEGIES).filter((s) => {
      if (strategyType && s.type !== strategyType) return false;
      return isStrategyValid(s);
    });

    if (validStrategies.length === 0) {
      return { setups: [], strategySetups: [], message: `No valid strategies for current session (${activeSession})` };
    }

    const results = await Promise.allSettled(
      allowed.map(async (symbol) => {
        try {
          const analysis = await toolMap.get_pair_analysis({ symbol });
          return { symbol, analysis };
        } catch { return null; }
      })
    );

    const setups = results
      .filter((r) => r.status === "fulfilled" && r.value)
      .map((r) => r.value)
      .filter(({ analysis }) => analysis?.price && analysis?.pairAllowed);

    // Strategy-aware scoring: score each pair against each valid strategy
    const strategySetups = [];
    for (const { symbol, analysis } of setups) {
      for (const strategy of validStrategies) {
        const scored = scorePairForStrategy(strategy, analysis);
        if (scored.passed) {
          strategySetups.push({
            strategyId: strategy.id,
            strategyName: strategy.name,
            strategyType: strategy.type,
            symbol,
            price: analysis.price,
            direction: analysis.trend === "bullish" ? "buy" : analysis.trend === "bearish" ? "sell" : null,
            trend: analysis.trend,
            rsi: analysis.rsi,
            atr: Math.round(analysis.atr * 100000) / 100000,
            session: analysis.session,
            estimatedSL: scored.sltp?.slPips,
            estimatedTP: scored.sltp?.tpPips,
            riskReward: scored.sltp?.riskReward,
            maxRiskPct: scored.maxRiskPct,
            score: scored.score,
            checks: scored.reason,
          });
        }
      }
    }

    strategySetups.sort((a, b) => b.score - a.score);

    // Also include summary by strategy type
    const byType = { intraday: 0, swing: 0 };
    for (const s of strategySetups) {
      byType[s.strategyType] = (byType[s.strategyType] || 0) + 1;
    }

    return {
      activeSession,
      validStrategies: validStrategies.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      strategySetups: strategySetups.slice(0, limit),
      byType,
      totalScanned: allowed.length,
      validPairs: setups.length,
    };
  },

  get_forex_news: async ({ hours_ahead = 24 } = {}) => {
    const events = await getForexNews({ hoursAhead: hours_ahead });
    return { events, count: events.length, formattedPrompt: formatNewsForPrompt(events) };
  },

  check_news_buffer: async ({ symbol }) => {
    const events = await getForexNews({ hoursAhead: 2 });
    return checkNews({ symbol, newsEvents: events });
  },

  place_trade: async ({ symbol, type, volume, sl_pips, tp_pips, reason = "" }) => {
    // 0. Equity Guardian halt — no new entries once the day is locked down
    if (isTradingHalted()) {
      return {
        success: false,
        blocked: true,
        reason: `Trading halted by Equity Guardian: ${getHaltReason()}`,
      };
    }

    const account = await getAccountStatus();
    const positions = await getOpenPositions();
    const closedToday = await getTodayClosedTrades();

    // 1. Risk check
    const rules = checkChallengeRules({ accountStatus: account, openPositions: positions, closedToday });
    if (!rules.canTrade) {
      return {
        success: false,
        blocked: true,
        reason: `Risk rules blocked trade: ${rules.blockReasons.join(" | ")}`,
        rules,
      };
    }

    // 2. News buffer check
    const events = await getForexNews({ hoursAhead: 2 });
    const newsCheck = checkNews({ symbol, newsEvents: events });
    if (newsCheck.blocked) {
      return {
        success: false,
        blocked: true,
        reason: newsCheck.reason,
      };
    }

    // 3. Verify lot size
    const sizeCheck = computeRiskPositionSize({
      equity: account.equity,
      symbol,
      slPips: sl_pips,
    });
    const maxLot = sizeCheck.lots * 1.1; // allow 10% flexibility
    if (volume > maxLot || volume < 0.01) {
      return {
        success: false,
        error: `Lot size ${volume} is outside allowed range [0.01, ${maxLot.toFixed(2)}]. Calculated: ${sizeCheck.breakdown}`,
      };
    }

    // 4. Get current price to calculate SL/TP prices
    const candles = await getOHLCV({ symbol, resolution: "5m", count: 5 });
    if (candles.length === 0) {
      return { success: false, error: `No price data available for ${symbol}` };
    }
    // B4: refuse to trade on stale/invalid data (live only; dry-run uses synthetic candles)
    if (process.env.DRY_RUN !== "true") {
      const freshness = checkDataFreshness(candles);
      if (freshness.stale) {
        return { success: false, blocked: true, reason: `Trade blocked — ${freshness.reason}` };
      }
    }
    const currentPrice = candles[candles.length - 1].close;

    const { pipSize, digits } = await getSymbolPrecision(symbol);
    const slPrice = type === "buy"
      ? currentPrice - sl_pips * pipSize
      : currentPrice + sl_pips * pipSize;
    const tpPrice = type === "buy"
      ? currentPrice + tp_pips * pipSize
      : currentPrice - tp_pips * pipSize;

    // 5. Place the trade
    const result = await placeOrder({
      symbol,
      type,
      volume,
      sl: roundToDigits(slPrice, digits),
      tp: roundToDigits(tpPrice, digits),
      orderType: "market",
      comment: reason || "Spectrun AI",
    });

    if (!result.success && !result.dry_run) {
      return result;
    }

    // 6. Confirm the fill landed (B3), then track in state
    let confirmed = null;
    if (!result.dry_run && result.ticket) {
      confirmed = await confirmFill(result.ticket);
      if (!confirmed) {
        log("executor_warn", `Fill not confirmed for ${result.ticket} — reconcile will verify`);
      }
      trackTrade({
        ticket: result.ticket,
        symbol,
        type,
        volume,
        openPrice: currentPrice,
        sl: result.sl,
        tp: result.tp,
        reason,
      });
    }

    appendDecision({
      type: "entry",
      actor: "SCANNER",
      symbol,
      summary: `${type.toUpperCase()} ${volume} ${symbol} @ ${currentPrice}`,
      reason: reason || "AI scan setup",
      metrics: {
        sl_pips,
        tp_pips,
        risk_pct: config.risk.riskPerTradePct,
        position_size: result.dry_run ? "DRY_RUN" : result.ticket,
      },
    });

    return {
      ...result,
      risk: sizeCheck,
      currentPrice,
      confirmed,
      slPrice: roundToDigits(slPrice, digits),
      tpPrice: roundToDigits(tpPrice, digits),
    };
  },

  place_pending_order: async ({ symbol, order_type, entry_price, sl_pips, tp_pips, reason = "" }) => {
    // 0. Equity Guardian halt
    if (isTradingHalted()) {
      return { success: false, blocked: true, reason: `Trading halted by Equity Guardian: ${getHaltReason()}` };
    }

    const type = order_type.startsWith("buy") ? "buy" : "sell";
    const orderType = order_type.endsWith("stop") ? "stop" : "limit";

    const account = await getAccountStatus();
    const positions = await getOpenPositions();
    const closedToday = await getTodayClosedTrades();

    // 1. Risk check
    const rules = checkChallengeRules({ accountStatus: account, openPositions: positions, closedToday });
    if (!rules.canTrade) {
      return { success: false, blocked: true, reason: `Risk rules blocked order: ${rules.blockReasons.join(" | ")}`, rules };
    }

    // 2. News buffer check
    const events = await getForexNews({ hoursAhead: 2 });
    const newsCheck = checkNews({ symbol, newsEvents: events });
    if (newsCheck.blocked) {
      return { success: false, blocked: true, reason: newsCheck.reason };
    }

    // 3. Validate entry_price direction matches the order semantics
    const candles = await getOHLCV({ symbol, resolution: "5m", count: 5 });
    if (candles.length === 0) {
      return { success: false, error: `No price data available for ${symbol}` };
    }
    if (process.env.DRY_RUN !== "true") {
      const freshness = checkDataFreshness(candles);
      if (freshness.stale) {
        return { success: false, blocked: true, reason: `Pending order blocked — ${freshness.reason}` };
      }
    }
    const currentPrice = candles[candles.length - 1].close;
    const dirOk =
      (order_type === "buy_stop" && entry_price > currentPrice) ||
      (order_type === "sell_stop" && entry_price < currentPrice) ||
      (order_type === "buy_limit" && entry_price < currentPrice) ||
      (order_type === "sell_limit" && entry_price > currentPrice);
    if (!dirOk) {
      return {
        success: false,
        error: `entry_price ${entry_price} is on the wrong side of current price ${currentPrice} for ${order_type}. ` +
          `stop orders trigger in the trade direction; limit orders trigger on a pullback.`,
      };
    }

    // 4. Position size (calculated in code)
    const sizeCheck = computeRiskPositionSize({ equity: account.equity, symbol, slPips: sl_pips });
    const volume = sizeCheck.lots;
    if (!volume || volume < 0.01) {
      return { success: false, error: `Invalid lot size from risk calc: ${sizeCheck.breakdown || sizeCheck.error}` };
    }

    // 5. SL/TP prices from entry_price using real instrument precision
    const { pipSize, digits } = await getSymbolPrecision(symbol);
    const slPrice = type === "buy" ? entry_price - sl_pips * pipSize : entry_price + sl_pips * pipSize;
    const tpPrice = type === "buy" ? entry_price + tp_pips * pipSize : entry_price - tp_pips * pipSize;

    // 6. Place pending order
    const result = await placePendingOrder({
      symbol,
      type,
      orderType,
      volume,
      price: roundToDigits(entry_price, digits),
      sl: roundToDigits(slPrice, digits),
      tp: roundToDigits(tpPrice, digits),
      comment: reason || "Spectrun AI",
    });

    if (!result.success && !result.dry_run) {
      return result;
    }

    appendDecision({
      type: "pending",
      actor: "SCANNER",
      symbol,
      summary: `${order_type.toUpperCase()} ${volume} ${symbol} @ ${entry_price}`,
      reason: reason || "AI pending setup",
      metrics: { order_type, entry_price, sl_pips, tp_pips, risk_pct: config.risk.riskPerTradePct },
    });

    return {
      ...result,
      risk: sizeCheck,
      currentPrice,
      slPrice: roundToDigits(slPrice, digits),
      tpPrice: roundToDigits(tpPrice, digits),
    };
  },

  get_pending_orders: async () => {
    const orders = await getPendingOrders();
    return {
      count: orders.length,
      orders: orders.map((o) => ({
        ticket: o.ticket || o.id || o.orderId,
        symbol: o.symbol,
        type: o.type || o.side,
        orderType: o.orderType || o.type,
        price: o.openPrice ?? o.price ?? o.limitPrice ?? o.stopPrice,
        volume: o.volume ?? o.qty ?? o.quantity,
        sl: o.stopLoss ?? o.sl ?? null,
        tp: o.takeProfit ?? o.tp ?? null,
        createdAt: o.createdAt || o.time || null,
      })),
    };
  },

  cancel_pending_order: async ({ ticket, reason = "manual" }) => {
    const result = await cancelOrder({ orderId: ticket });
    if (result.success || result.dry_run) {
      appendDecision({
        type: "cancel",
        actor: "MANAGER",
        symbol: "pending order",
        summary: `Cancelled pending order ${ticket}`,
        reason,
        metrics: {},
      });
    }
    return result;
  },

  get_open_trades: async () => {
    const positions = await getOpenPositions();

    // Sync with state
    syncOpenTrades(positions.map((p) => String(p.id || p.ticket)));

    return {
      count: positions.length,
      positions: await Promise.all(positions.map(async (p) => {
        const { pipSize } = await getSymbolPrecision(p.symbol);
        const pipsFromEntry = p.openPrice && p.currentPrice
          ? Math.round((Math.abs(p.currentPrice - p.openPrice) / pipSize) * 10) / 10
          : 0;

        return {
          ticket: p.ticket || p.id,
          symbol: p.symbol,
          type: p.type,
          volume: p.volume,
          openPrice: p.openPrice,
          currentPrice: p.currentPrice,
          profit: p.profit,
          profitPct: p.profitPct,
          pipsFromEntry,
          sl: p.sl,
          tp: p.tp,
          openTime: p.openTime,
        };
      })),
    };
  },

  close_trade: async ({ ticket, reason = "manual" }) => {
    const result = await closePosition({ positionId: ticket });

    if (result.success) {
      recordTradeClose({
        ticket,
        closePrice: result.closePrice,
        pnl: result.profit,
        reason,
      });

      appendDecision({
        type: "exit",
        actor: "MANAGER",
        symbol: "see trade registry",
        summary: `Closed ${ticket}: ${reason}`,
        reason,
        metrics: { pnl: result.profit },
      });
    }

    return result;
  },

  close_all_trades: async ({ reason }) => {
    const positions = await getOpenPositions();

    for (const p of positions) {
      try {
        await toolMap.close_trade({ ticket: p.ticket || p.id, reason });
      } catch (e) {
        log("executor_warn", `Failed to close ${p.ticket}: ${e.message}`);
      }
    }

    return await closeAllPositions();
  },

  modify_trade: async ({ ticket, sl, tp }) => {
    const result = await modifyPosition({
      positionId: ticket,
      sl: sl ?? undefined,
      tp: tp ?? undefined,
    });

    if (result.success && sl) {
      recordTrailingActivation({
        ticket,
        newSL: sl,
        profitPips: 0,
      });
    }

    return result;
  },

  update_config: ({ changes, reason = "" }) => {
    const applied = {};
    const unknown = [];

    for (const [key, val] of Object.entries(changes)) {
      const section = findConfigSection(key);
      if (!section) { unknown.push(key); continue; }

      const [sectionName, field] = section;
      config[sectionName][field] = val;
      applied[key] = val;
    }

    if (Object.keys(applied).length === 0) {
      return { success: false, unknown, reason };
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
    }

    for (const [key, val] of Object.entries(applied)) {
      userConfig[key] = val;
    }
    writeJSONAtomic(USER_CONFIG_PATH, userConfig);

    log("config", `Config updated: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },

  get_performance_history: async ({ hours = 168, limit = 50 } = {}) => {
    return getPerformanceHistory({ hours, limit });
  },

  get_recent_decisions: async ({ limit = 6 } = {}) => {
    return { decisions: getRecentDecisions(limit) };
  },

  add_lesson: async ({ rule, tags = [], role = null }) => {
    addLesson(rule, tags, { role });
    return { saved: true, rule, tags, role };
  },

  scan_strategies: async ({ type = null } = {}) => {
    const activeSession = getActiveSession();
    const all = Object.values(STRATEGIES).map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      description: s.description,
      validNow: isStrategyValid(s),
      minScore: s.minScore,
      maxRiskPct: s.position.maxRiskPct,
      consistency: s.consistency,
    }));

    return {
      activeSession,
      totalStrategies: all.length,
      validNow: all.filter((s) => s.validNow).length,
      strategies: type ? all.filter((s) => s.type === type) : all,
    };
  },

  get_consistency_report: async () => {
    return getConsistencyReport();
  },

  get_strategy_usage: async () => {
    return getStrategyUsageReport();
  },

  check_daily_consistency: async ({ strategy_id, projected_pnl = 0 } = {}) => {
    return checkDailyConsistency({ strategyId: strategy_id, projectedPnl: projected_pnl });
  },

  get_pattern_report: async ({ min_trades = 3 } = {}) => {
    return getPatternReport();
  },

  get_journal_analytics: async () => {
    return getJournalAnalytics();
  },

  query_journal: async ({ symbol, strategy_id, session, has_news, min_trades = 0 } = {}) => {
    return queryJournal({ symbol, strategyId: strategy_id, session, hasNews: has_news, minTrades: min_trades });
  },

  resume_strategy: async ({ strategy_id }) => {
    return resumeStrategy(strategy_id);
  },

  run_backtest: async ({ symbol = "EURUSD", strategy = null, days = 30, risk_per_trade = 0.5 } = {}) => {
    const { result, filename } = runBacktest({ symbol, strategy, days, riskPerTrade: risk_per_trade });
    return { result, savedAs: filename };
  },

  list_backtests: async () => {
    return { results: listBacktestResults() };
  },
};

function findConfigSection(key) {
  const map = {
    riskPerTradePct: ["risk", "riskPerTradePct"],
    maxDailyTrades: ["risk", "maxDailyTrades"],
    maxConsecutiveLosses: ["risk", "maxConsecutiveLosses"],
    consecutiveLossCooldownMinutes: ["risk", "consecutiveLossCooldownMinutes"],
    trailingStopEnabled: ["risk", "trailingStopEnabled"],
    trailingTriggerPips: ["risk", "trailingTriggerPips"],
    trailingDistancePips: ["risk", "trailingDistancePips"],
    allowedPairs: ["strategy", "allowedPairs"],
    requireTrendAlignment: ["strategy", "requireTrendAlignment"],
    avoidHighImpactNewsPairs: ["strategy", "avoidHighImpactNewsPairs"],
    minRiskRewardRatio: ["challenge", "minRiskRewardRatio"],
    maxOpenPositions: ["challenge", "maxOpenPositions"],
    maxDailyLossPct: ["challenge", "maxDailyLossPct"],
    maxTotalLossPct: ["challenge", "maxTotalLossPct"],
    profitTargetPct: ["challenge", "profitTargetPct"],
    consistencyMinPct: ["challenge", "consistencyMinPct"],
    scannerIntervalMin: ["schedule", "scannerIntervalMin"],
    managerIntervalMin: ["schedule", "managerIntervalMin"],
    scannerModel: ["llm", "scannerModel"],
    managerModel: ["llm", "managerModel"],
    generalModel: ["llm", "generalModel"],
  };
  return map[key] || null;
}
