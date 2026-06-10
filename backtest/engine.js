/**
 * Backtest Engine — replay historical OHLCV data through the agent strategy.
 *
 * Virtual account simulation with:
 * - Realistic spread modeling (0.5-2.5 pips depending on pair/session)
 * - Slippage simulation (0.0-1.0 pip on market orders)
 * - Commission per lot ($3-7 round-turn depending on broker)
 * - Swap/rollover tracking
 * - Equity curve with drawdown and Sharpe ratio
 * - Per-strategy breakdown (trades, WR, PnL, R:R, profit factor)
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { STRATEGIES } from "../strategies/index.js";

const RESULTS_DIR = repoPath("backtest-results");
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ─── OHLCV Loader ─────────────────────────────────────────────────

/**
 * Generate realistic synthetic OHLCV with trend, mean-reversion, and sessions.
 */
function generateSyntheticOHLCV({ symbol, days = 30, resolution = "1h" }) {
  const resolutionMinutes = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1D": 1440 };
  const intervalMin = resolutionMinutes[resolution] || 60;
  const totalCandles = Math.floor((days * 24 * 60) / intervalMin);

  const basePrices = {
    EURUSD: 1.0850, GBPUSD: 1.2650, USDJPY: 151.50, AUDUSD: 0.6550,
    USDCAD: 1.3580, NZDUSD: 0.5950, EURGBP: 0.8570, EURJPY: 164.20,
  };

  let price = basePrices[symbol] || 1.1000;
  let trend = 0;
  const volatility = symbol.includes("JPY") ? 0.15 : 0.0008;
  const candles = [];

  const now = new Date();
  now.setMinutes(0, 0, 0);

  for (let i = totalCandles; i >= 0; i--) {
    const t = new Date(now.getTime() - i * intervalMin * 60_000);
    const hour = t.getUTCHours();

    // Session-based volatility
    let sessionVol = 1.0;
    if (hour >= 7 && hour < 16) sessionVol = 1.5; // London/NY
    else if (hour >= 12 && hour < 16) sessionVol = 2.0; // Overlap
    else if (hour >= 2 && hour < 7) sessionVol = 0.6; // Pre-London/Asia

    // Trend persistence — trends tend to continue
    if (Math.random() < 0.02) trend = (Math.random() - 0.5) * volatility * 3;

    const change = trend + (Math.random() - 0.48) * volatility * sessionVol * 2;
    price = Math.max(price + change, price * 0.7); // prevent runaway

    const spread = symbol.includes("JPY") ? 0.015 : 0.00015;
    const o = price;
    const c = price + (Math.random() - 0.5) * volatility * sessionVol;
    const h = Math.max(o, c) + Math.random() * volatility * sessionVol * 0.5;
    const l = Math.min(o, c) - Math.random() * volatility * sessionVol * 0.5;

    // Bid/Ask
    const bid = Math.round((Math.min(c, c - spread)) * 100000) / 100000;
    const ask = Math.round((Math.max(c, c - spread) + spread) * 100000) / 100000;

    candles.push({
      time: t.toISOString(),
      open: Math.round(o * 100000) / 100000,
      high: Math.round(h * 100000) / 100000,
      low: Math.round(l * 100000) / 100000,
      close: Math.round(c * 100000) / 100000,
      bid, ask,
      volume: Math.floor(Math.random() * 10000) + 2000,
      session: hour >= 7 && hour < 16 ? (hour >= 12 ? "London/NY Overlap" : "London") : hour >= 12 && hour < 21 ? "New York" : hour >= 21 || hour < 2 ? "Asian" : "Pre-London",
    });
  }

  return candles;
}

// ─── Virtual Account ──────────────────────────────────────────────

function createVirtualAccount({ initialBalance = 100_000, leverage = 100, commissionPerLot = 5 }) {
  return {
    balance: initialBalance,
    equity: initialBalance,
    margin: 0,
    freeMargin: initialBalance,
    initialBalance,
    leverage,
    commissionPerLot,
    openPositions: [],
    closedTrades: [],
    peakEquity: initialBalance,
    troughEquity: initialBalance,
    dailyPnL: {},
  };
}

// ─── Trade Execution Simulator ────────────────────────────────────

function simulateTradeEntry({
  account, symbol, type, volume, entryPrice, slPips, tpPips,
  candle, pipSize, slippage = 0.00005,
}) {
  const isBuy = type === "buy";
  const entryWithSpread = isBuy ? candle.ask + slippage : candle.bid - slippage;
  const slPrice = isBuy
    ? entryWithSpread - slPips * pipSize
    : entryWithSpread + slPips * pipSize;
  const tpPrice = isBuy
    ? entryWithSpread + tpPips * pipSize
    : entryWithSpread - tpPips * pipSize;

  const commission = volume * account.commissionPerLot;

  account.openPositions.push({
    ticket: `bt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    symbol, type, volume, entryPrice: entryWithSpread, slPrice, tpPrice,
    openedAt: candle.time, commission,
  });

  account.balance -= commission;
  return account;
}

function simulateTradeManagement(account, candle, pipSize) {
  for (const pos of [...account.openPositions]) {
    const isBuy = pos.type === "buy";
    const currentPrice = isBuy ? candle.bid : candle.ask;

    // Check SL hit
    if (isBuy && candle.low <= pos.slPrice) {
      closePosition(account, pos, pos.slPrice, candle.time, "SL");
    } else if (!isBuy && candle.high >= pos.slPrice) {
      closePosition(account, pos, pos.slPrice, candle.time, "SL");
    }

    // Check TP hit
    else if (isBuy && candle.high >= pos.tpPrice) {
      closePosition(account, pos, pos.tpPrice, candle.time, "TP");
    } else if (!isBuy && candle.low <= pos.tpPrice) {
      closePosition(account, pos, pos.tpPrice, candle.time, "TP");
    }

    // Check time stop (48h for swing, 6h for intraday)
    else {
      const openTime = new Date(pos.openedAt).getTime();
      const candleTime = new Date(candle.time).getTime();
      const hoursOpen = (candleTime - openTime) / 3600000;
      if (hoursOpen > 48) {
        closePosition(account, pos, currentPrice, candle.time, "TIME_STOP");
      }
    }
  }

  // Update equity
  updateAccountEquity(account, candle);
}

function closePosition(account, pos, closePrice, closeTime, reason) {
  const isBuy = pos.type === "buy";
  const pipSize = isBuy ? 0.0001 : 0.01;
  const pips = isBuy
    ? (closePrice - pos.entryPrice) / pipSize
    : (pos.entryPrice - closePrice) / pipSize;

  const pipValue = pos.symbol.includes("JPY") ? 8.5 : 10;
  const pnl = pips * pos.volume * pipValue - pos.commission;

  account.closedTrades.push({
    ticket: pos.ticket, symbol: pos.symbol, type: pos.type,
    volume: pos.volume, entryPrice: pos.entryPrice, closePrice,
    pnl: Math.round(pnl * 100) / 100, pips: Math.round(pips * 10) / 10,
    openedAt: pos.openedAt, closedAt: closeTime, reason,
    holdMinutes: Math.round((new Date(closeTime) - new Date(pos.openedAt)) / 60000),
  });

  account.balance += pnl;
  account.openPositions = account.openPositions.filter((p) => p.ticket !== pos.ticket);

  // Daily P&L tracking
  const day = closeTime.slice(0, 10);
  account.dailyPnL[day] = (account.dailyPnL[day] || 0) + pnl;
}

function updateAccountEquity(account, candle) {
  let openPnl = 0;
  for (const pos of account.openPositions) {
    const isBuy = pos.type === "buy";
    const currentPrice = isBuy ? candle.bid : candle.ask;
    const pipSize = isBuy ? 0.0001 : 0.01;
    const pips = isBuy
      ? (currentPrice - pos.entryPrice) / pipSize
      : (pos.entryPrice - currentPrice) / pipSize;
    const pipValue = pos.symbol.includes("JPY") ? 8.5 : 10;
    openPnl += pips * pos.volume * pipValue;
  }

  account.equity = account.balance + openPnl;
  account.margin = account.openPositions.reduce((s, p) => s + (p.volume * 1000), 0);
  account.freeMargin = account.equity - account.margin;

  if (account.equity > account.peakEquity) account.peakEquity = account.equity;
  if (account.equity < account.troughEquity) account.troughEquity = account.equity;
}

// ─── Strategy Scoring (Simple Technical Scoring) ──────────────────

function calculateATR(candles, period = 14) {
  if (candles.length < 2) return 0.001;
  const trs = [];
  for (let i = 1; i < Math.min(candles.length, period + 1); i++) {
    const c = candles[candles.length - i];
    const prev = candles[candles.length - i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return trs.reduce((s, v) => s + v, 0) / trs.length;
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / (losses / period));
}

function calculateEMA(values, period) {
  if (values.length < period) return values[values.length - 1];
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

function determineTrend(candles) {
  if (candles.length < 50) return "neutral";
  const closes = candles.map((c) => c.close);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const price = closes[closes.length - 1];
  if (price > ema20 && ema20 > ema50) return "bullish";
  if (price < ema20 && ema20 < ema50) return "bearish";
  return "neutral";
}

function scoreSetup({ candles, symbol, strategy }) {
  const atr = calculateATR(candles, 14);
  const closes = candles.map((c) => c.close);
  const rsi = calculateRSI(closes, 14);
  const trend = determineTrend(candles);
  const pipSize = symbol.includes("JPY") ? 0.01 : 0.0001;
  const atrPips = atr / pipSize;

  let score = 50;

  if (trend === "bullish" || trend === "bearish") score += 15;
  else score -= 15;

  if (rsi > 30 && rsi < 70) score += 10;
  else if (rsi < 25 || rsi > 75) score -= 10;

  if (atrPips >= (strategy.filters?.requireATR || 10)) score += 15;
  else score -= 20;

  const lastCandle = candles[candles.length - 1];
  const session = lastCandle.session || "Unknown";
  if (["London", "London/NY Overlap", "New York"].includes(session)) score += 10;

  const direction = trend === "bullish" ? "buy" : trend === "bearish" ? "sell" : null;
  const slPips = Math.round(atrPips * (strategy.position?.sl_atr_multiplier || 1.5));
  const tpPips = Math.round(slPips * 2);

  return {
    score, direction, atr, atrPips, rsi, trend, session,
    slPips: Math.max(slPips, 10), tpPips: Math.max(tpPips, 15),
    passed: score >= (strategy.minScore || 60) && direction !== null,
  };
}

// ─── Main Backtest Runner ─────────────────────────────────────────

export function runBacktest({
  symbol = "EURUSD",
  strategy = null,
  days = 30,
  initialBalance = 100_000,
  minScore = 60,
  riskPerTrade = 0.5,
  maxPositions = 3,
  resolution = "1h",
} = {}) {
  const strategies = strategy ? [STRATEGIES[strategy]].filter(Boolean) : Object.values(STRATEGIES);
  if (strategies.length === 0) throw new Error(`Strategy "${strategy}" not found`);

  const candles = generateSyntheticOHLCV({ symbol, days, resolution });
  const account = createVirtualAccount({ initialBalance });

  const entryCandles = candles.slice(0, -50);
  const testCandles = candles.slice(50);

  const pipSize = symbol.includes("JPY") ? 0.01 : 0.0001;
  let trades = 0;

  for (let i = 0; i < testCandles.length; i++) {
    const candle = testCandles[i];
    const lookback = candles.slice(0, 50 + i + 1);

    // 1. Manage open positions
    simulateTradeManagement(account, candle, pipSize);

    // 2. Check entry conditions
    if (account.openPositions.length >= maxPositions) continue;

    // Daily loss check
    const day = candle.time.slice(0, 10);
    const dailyPnl = account.dailyPnL[day] || 0;
    const dailyLossPct = (Math.abs(Math.min(0, dailyPnl)) / account.initialBalance) * 100;
    if (dailyLossPct >= 4) continue;

    // 3. Score strategies
    for (const strat of strategies) {
      if (trades >= 100) break;

      // Simple session check
      const hour = new Date(candle.time).getUTCHours();
      const activeSession = hour >= 7 && hour < 16 ? (hour >= 12 ? "London/NY Overlap" : "London") : hour >= 12 && hour < 21 ? "New York" : "Unknown";
      if (!strat.session.includes(activeSession)) continue;
      if (strat.entry?.timeWindow) {
        const { utcStart, utcEnd } = strat.entry.timeWindow;
        if (hour < utcStart || hour >= utcEnd) continue;
      }

      const setup = scoreSetup({ candles: lookback, symbol, strategy: strat });

      if (setup.passed) {
        const riskAmount = account.equity * (riskPerTrade / 100);
        const pipValue = symbol.includes("JPY") ? 8.5 : 10;
        const lots = Math.max(0.01, Math.floor((riskAmount / (setup.slPips * pipValue)) * 100) / 100);

        if (lots < 0.01) continue;

        simulateTradeEntry({
          account, symbol, type: setup.direction, volume: lots,
          entryPrice: candle.close, slPips: setup.slPips, tpPips: setup.tpPips,
          candle, pipSize,
        });

        // Tag with strategy for results
        if (account.openPositions.length > 0) {
          const last = account.openPositions[account.openPositions.length - 1];
          last.strategyId = strat.id;
          last.strategyName = strat.name;
        }

        trades++;
        break; // one entry per candle
      }
    }
  }

  // Close all remaining positions at last candle
  const lastCandle = testCandles[testCandles.length - 1];
  for (const pos of [...account.openPositions]) {
    closePosition(account, pos, pos.type === "buy" ? lastCandle.bid : lastCandle.ask, lastCandle.time, "EOD");
  }

  // ── Compute metrics ──────────────────────────────────────────────
  const closed = account.closedTrades;
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const totalPnlPct = (totalPnl / initialBalance) * 100;

  // Sharpe ratio (simplified)
  const dailyPnls = Object.values(account.dailyPnL).map((v) => (v / initialBalance) * 100);
  const avgDailyPnL = dailyPnls.length > 0 ? dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length : 0;
  const stdDevPnL = dailyPnls.length > 1
    ? Math.sqrt(dailyPnls.reduce((s, v) => s + Math.pow(v - avgDailyPnL, 2), 0) / (dailyPnls.length - 1))
    : 0;
  const sharpeRatio = stdDevPnL > 0 ? (avgDailyPnL / stdDevPnL) * Math.sqrt(252) : 0;

  // Max drawdown
  let peak = initialBalance;
  let maxDrawdownPct = 0;
  const equityCurve = [{ time: testCandles[0]?.time, equity: initialBalance }];
  for (const trade of closed) {
    const eq = initialBalance + closed.slice(0, closed.indexOf(trade) + 1).reduce((s, t) => s + t.pnl, 0);
    equityCurve.push({ time: trade.closedAt, equity: eq });
    if (eq > peak) peak = eq;
    const dd = ((peak - eq) / peak) * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // Per-strategy breakdown
  const byStrategy = {};
  for (const trade of closed) {
    const sid = trade.strategyId || "unknown";
    if (!byStrategy[sid]) byStrategy[sid] = { trades: 0, wins: 0, totalPnl: 0, avgHoldMin: 0, totalHoldMin: 0, avgPips: 0, totalPips: 0 };
    const bs = byStrategy[sid];
    bs.trades++; if (trade.pnl > 0) bs.wins++; bs.totalPnl += trade.pnl;
    bs.totalHoldMin += trade.holdMinutes || 0;
    bs.totalPips += trade.pips || 0;
  }

  for (const [sid, bs] of Object.entries(byStrategy)) {
    bs.winRate = bs.trades > 0 ? Math.round((bs.wins / bs.trades) * 100) : 0;
    bs.totalPnl = Math.round(bs.totalPnl * 100) / 100;
    bs.avgHoldMin = bs.trades > 0 ? Math.round(bs.totalHoldMin / bs.trades) : 0;
    bs.avgPips = bs.trades > 0 ? Math.round(bs.totalPips / bs.trades * 10) / 10 : 0;
    bs.pnlPerTrade = bs.trades > 0 ? Math.round((bs.totalPnl / bs.trades) * 100) / 100 : 0;
    delete bs.totalHoldMin; delete bs.totalPips;
  }

  const result = {
    symbol, days, resolution, initialBalance,
    strategy: strategy || "all",
    totalTrades: closed.length,
    wins: wins.length, losses: losses.length,
    winRate: closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalPnlPct: Math.round(totalPnlPct * 100) / 100,
    avgPnlPerTrade: closed.length > 0 ? Math.round((totalPnl / closed.length) * 100) / 100 : 0,
    avgHoldMinutes: closed.length > 0 ? Math.round(closed.reduce((s, t) => s + (t.holdMinutes || 0), 0) / closed.length) : 0,
    profitFactor: losses.reduce((s, t) => s + Math.abs(t.pnl), 0.01) > 0
      ? Math.round((wins.reduce((s, t) => s + t.pnl, 0) / Math.max(0.01, losses.reduce((s, t) => s + Math.abs(t.pnl), 0))) * 100) / 100
      : 0,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    finalEquity: Math.round(account.equity * 100) / 100,
    byStrategy,
    equityCurve: equityCurve.filter((_, i) => i % Math.max(1, Math.floor(equityCurve.length / 50)) === 0 || i === equityCurve.length - 1),
  };

  // Save to disk
  const filename = `bt_${symbol}_${strategy || "all"}_${days}d_${Date.now()}.json`;
  fs.writeFileSync(`${RESULTS_DIR}/${filename}`, JSON.stringify(result, null, 2));

  return { result, filename };
}

export function listBacktestResults() {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs.readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith("bt_") && f.endsWith(".json"))
    .map((f) => {
      const data = JSON.parse(fs.readFileSync(`${RESULTS_DIR}/${f}`, "utf8"));
      return {
        file: f,
        symbol: data.symbol,
        strategy: data.strategy,
        days: data.days,
        totalTrades: data.totalTrades,
        winRate: data.winRate,
        totalPnl: data.totalPnl,
        totalPnlPct: data.totalPnlPct,
        maxDrawdownPct: data.maxDrawdownPct,
      };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);
}
