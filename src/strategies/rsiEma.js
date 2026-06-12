// src/strategies/rsiEma.js
// EMA9/EMA21 crossover + RSI zone filter + EMA200 trend gate
// SL = 2×ATR | TP1 = 1.5R (close 50%) | TP2 = 3R (close rest)

const { RSI, EMA, ATR } = require('technicalindicators');

const DEFAULT_CONFIG = {
  emaFast:      parseInt(process.env.EMA_FAST      || 9),
  emaSlow:      parseInt(process.env.EMA_SLOW      || 21),
  emaTrend:     parseInt(process.env.EMA_TREND     || 200),
  rsiPeriod:    parseInt(process.env.RSI_PERIOD    || 14),
  rsiLongMin:   parseFloat(process.env.RSI_LONG_MIN  || 40),   // RSI must be above (room to run)
  rsiLongMax:   parseFloat(process.env.RSI_LONG_MAX  || 65),   // RSI must be below (not overbought)
  rsiShortMin:  parseFloat(process.env.RSI_SHORT_MIN || 35),
  rsiShortMax:  parseFloat(process.env.RSI_SHORT_MAX || 60),
  slAtrMult:    parseFloat(process.env.SL_ATR_MULT   || 2.0),
  tp1Rr:        parseFloat(process.env.TP1_RR        || 1.5),
  tp2Rr:        parseFloat(process.env.TP2_RR        || 3.0),
  tp1Split:     parseFloat(process.env.TP1_SPLIT     || 0.5),  // fraction to close at TP1
};

// Minimum candles required for all indicators
function minCandles(cfg) {
  return cfg.emaTrend + 20;
}

// Detect signal on latest candle close.
// Returns { signal: 'LONG'|'SHORT'|null, entry, stopLoss, tp1, tp2, ... }
function detectSignal(candles, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const needed = minCandles(cfg);

  if (candles.length < needed) {
    return { signal: null, reason: `Need ${needed} candles, have ${candles.length}` };
  }

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);

  const emaFastArr  = EMA.calculate({ values: closes, period: cfg.emaFast });
  const emaSlowArr  = EMA.calculate({ values: closes, period: cfg.emaSlow });
  const emaTrendArr = EMA.calculate({ values: closes, period: cfg.emaTrend });
  const rsiArr      = RSI.calculate({ values: closes, period: cfg.rsiPeriod });
  const atrArr      = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

  const emaFast     = emaFastArr[emaFastArr.length - 1];
  const emaFastPrev = emaFastArr[emaFastArr.length - 2];
  const emaSlow     = emaSlowArr[emaSlowArr.length - 1];
  const emaSlowPrev = emaSlowArr[emaSlowArr.length - 2];
  const emaTrend    = emaTrendArr[emaTrendArr.length - 1];
  const rsi         = rsiArr[rsiArr.length - 1];
  const atr         = atrArr[atrArr.length - 1];
  const price       = closes[closes.length - 1];

  const bullCross   = emaFast > emaSlow && emaFastPrev <= emaSlowPrev;
  const bearCross   = emaFast < emaSlow && emaFastPrev >= emaSlowPrev;
  const aboveTrend  = price > emaTrend;
  const belowTrend  = price < emaTrend;

  const indicators = {
    price: +price.toFixed(2),
    emaFast: +emaFast.toFixed(2),
    emaSlow: +emaSlow.toFixed(2),
    emaTrend: +emaTrend.toFixed(2),
    rsi: +rsi.toFixed(2),
    atr: +atr.toFixed(2),
    emaCross: emaFast > emaSlow ? 'BULLISH' : 'BEARISH',
  };

  // LONG signal
  if (bullCross && aboveTrend && rsi >= cfg.rsiLongMin && rsi <= cfg.rsiLongMax) {
    const sl   = price - atr * cfg.slAtrMult;
    const risk = price - sl;
    return {
      signal:    'LONG',
      entry:     +price.toFixed(2),
      stopLoss:  +sl.toFixed(2),
      tp1:       +(price + risk * cfg.tp1Rr).toFixed(2),
      tp2:       +(price + risk * cfg.tp2Rr).toFixed(2),
      tp1Split:  cfg.tp1Split,
      riskReward: cfg.tp1Rr,
      confidence: scoreConfidence('LONG', rsi, emaFast, emaSlow, emaTrend, price),
      reason: `EMA${cfg.emaFast}/EMA${cfg.emaSlow} bullish cross | RSI ${rsi.toFixed(1)} | Above EMA${cfg.emaTrend}`,
      ...indicators,
    };
  }

  // SHORT signal
  if (bearCross && belowTrend && rsi >= cfg.rsiShortMin && rsi <= cfg.rsiShortMax) {
    const sl   = price + atr * cfg.slAtrMult;
    const risk = sl - price;
    return {
      signal:    'SHORT',
      entry:     +price.toFixed(2),
      stopLoss:  +sl.toFixed(2),
      tp1:       +(price - risk * cfg.tp1Rr).toFixed(2),
      tp2:       +(price - risk * cfg.tp2Rr).toFixed(2),
      tp1Split:  cfg.tp1Split,
      riskReward: cfg.tp1Rr,
      confidence: scoreConfidence('SHORT', rsi, emaFast, emaSlow, emaTrend, price),
      reason: `EMA${cfg.emaFast}/EMA${cfg.emaSlow} bearish cross | RSI ${rsi.toFixed(1)} | Below EMA${cfg.emaTrend}`,
      ...indicators,
    };
  }

  // Build a human-readable reason for the skip
  let reason = 'No crossover on this candle';
  if (bullCross || bearCross) {
    const dir = bullCross ? 'Bullish' : 'Bearish';
    const filters = [];
    if (bullCross && !aboveTrend) filters.push(`price below EMA${cfg.emaTrend}`);
    if (bearCross && !belowTrend) filters.push(`price above EMA${cfg.emaTrend}`);
    if (bullCross && (rsi < cfg.rsiLongMin || rsi > cfg.rsiLongMax))
      filters.push(`RSI ${rsi.toFixed(1)} outside ${cfg.rsiLongMin}-${cfg.rsiLongMax}`);
    if (bearCross && (rsi < cfg.rsiShortMin || rsi > cfg.rsiShortMax))
      filters.push(`RSI ${rsi.toFixed(1)} outside ${cfg.rsiShortMin}-${cfg.rsiShortMax}`);
    reason = `${dir} cross filtered: ${filters.join(', ')}`;
  }

  return { signal: null, reason, ...indicators };
}

// Score confidence 55-92 based on setup quality
function scoreConfidence(direction, rsi, emaFast, emaSlow, emaTrend, price) {
  let score = 60;

  if (direction === 'LONG') {
    if (rsi >= 45 && rsi <= 58) score += 15;
    else if (rsi >= 40 && rsi < 45) score += 8;
    const sep = (emaFast - emaSlow) / emaSlow * 100;
    if (sep > 0.3) score += 10;
    const ext = (price - emaTrend) / emaTrend * 100;
    if (ext > 1 && ext < 8) score += 10;
    else if (ext >= 8) score -= 5;
  } else {
    if (rsi >= 42 && rsi <= 55) score += 15;
    else if (rsi > 55 && rsi <= 60) score += 8;
    const sep = (emaSlow - emaFast) / emaSlow * 100;
    if (sep > 0.3) score += 10;
    const ext = (emaTrend - price) / emaTrend * 100;
    if (ext > 1 && ext < 8) score += 10;
    else if (ext >= 8) score -= 5;
  }

  return Math.min(92, Math.max(55, Math.round(score)));
}

// Get current indicator snapshot (no signal check, for status display)
function getState(candles, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (candles.length < Math.max(cfg.emaSlow + 5, 30)) return null;

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);

  const emaFastArr  = EMA.calculate({ values: closes, period: cfg.emaFast });
  const emaSlowArr  = EMA.calculate({ values: closes, period: cfg.emaSlow });
  const rsiArr      = RSI.calculate({ values: closes, period: cfg.rsiPeriod });
  const atrArr      = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const emaTrendArr = closes.length >= cfg.emaTrend
    ? EMA.calculate({ values: closes, period: cfg.emaTrend })
    : null;

  const emaFast  = emaFastArr[emaFastArr.length - 1];
  const emaSlow  = emaSlowArr[emaSlowArr.length - 1];
  const emaTrend = emaTrendArr ? emaTrendArr[emaTrendArr.length - 1] : null;
  const rsi      = rsiArr[rsiArr.length - 1];
  const atr      = atrArr[atrArr.length - 1];
  const price    = closes[closes.length - 1];

  return {
    price:     +price.toFixed(2),
    emaFast:   +emaFast.toFixed(2),
    emaSlow:   +emaSlow.toFixed(2),
    emaTrend:  emaTrend ? +emaTrend.toFixed(2) : null,
    rsi:       +rsi.toFixed(2),
    atr:       +atr.toFixed(2),
    emaCross:  emaFast > emaSlow ? 'BULLISH' : 'BEARISH',
    trendSide: emaTrend ? (price > emaTrend ? 'ABOVE' : 'BELOW') : 'UNKNOWN',
  };
}

module.exports = { detectSignal, getState, DEFAULT_CONFIG, minCandles };
