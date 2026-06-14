/**
 * Calculate ATR (Average True Range) from OHLCV data.
 */
export function calculateATR(candles, period = 14) {
  if (candles.length < 2) return 0;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  if (trueRanges.length === 0) return 0;
  const sum = trueRanges.slice(-Math.min(period, trueRanges.length)).reduce((a, b) => a + b, 0);
  return sum / Math.min(period, trueRanges.length);
}

/**
 * Calculate EMA from an array of values.
 */
export function calculateEMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Calculate RSI from an array of values.
 */
export function calculateRSI(values, period = 14) {
  if (values.length < period + 1) return 50;

  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Determine current trend direction from multiple EMA values.
 * Returns "bullish", "bearish", or "neutral".
 */
export function determineTrend(candles) {
  if (candles.length < 50) return "neutral";
  const closes = candles.map((c) => c.close);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const price = closes[closes.length - 1];

  if (price > ema20 && ema20 > ema50) return "bullish";
  if (price < ema20 && ema20 < ema50) return "bearish";
  return "neutral";
}
