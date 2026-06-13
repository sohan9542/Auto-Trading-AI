// src/strategies/rsiEma.js
// Multi-trigger confluence strategy — fires when 2+ of 4 signals align
// Replaces exact-crossover-only with: EMA cross | EMA bounce | RSI recovery | MACD flip
// SL = 2×ATR | TP1 = 1.5R (close 50%) | TP2 = 3R (close rest)

const { RSI, EMA, ATR, MACD } = require('technicalindicators');

const DEFAULT_CONFIG = {
  emaFast:      parseInt(process.env.EMA_FAST      || 9),
  emaSlow:      parseInt(process.env.EMA_SLOW      || 21),
  emaTrend:     parseInt(process.env.EMA_TREND     || 200),
  rsiPeriod:    parseInt(process.env.RSI_PERIOD    || 14),
  rsiLongMax:   parseFloat(process.env.RSI_LONG_MAX  || 70),   // not overbought
  rsiShortMin:  parseFloat(process.env.RSI_SHORT_MIN || 30),   // not oversold
  slAtrMult:    parseFloat(process.env.SL_ATR_MULT   || 2.0),
  tp1Rr:        parseFloat(process.env.TP1_RR        || 1.5),
  tp2Rr:        parseFloat(process.env.TP2_RR        || 3.0),
  tp1Split:     parseFloat(process.env.TP1_SPLIT     || 0.5),
  minTriggers:  parseInt(process.env.MIN_TRIGGERS    || 2),    // triggers needed to fire
};

function minCandles(cfg) {
  return cfg.emaTrend + 30;
}

// Detect signal — returns { signal, entry, stopLoss, tp1, tp2, ... } or { signal: null, reason }
function detectSignal(candles, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const needed = minCandles(cfg);

  if (candles.length < needed) {
    return { signal: null, reason: `Need ${needed} candles, have ${candles.length}` };
  }

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);

  const emaFastArr  = EMA.calculate({ values: closes, period: cfg.emaFast });
  const emaSlowArr  = EMA.calculate({ values: closes, period: cfg.emaSlow });
  const emaTrendArr = EMA.calculate({ values: closes, period: cfg.emaTrend });
  const rsiArr      = RSI.calculate({ values: closes, period: cfg.rsiPeriod });
  const atrArr      = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const macdArr     = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });

  const emaFast      = emaFastArr.at(-1);
  const emaFastPrev  = emaFastArr.at(-2);
  const emaFast3ago  = emaFastArr.at(-4);  // candle 3 back
  const emaSlow      = emaSlowArr.at(-1);
  const emaSlowPrev  = emaSlowArr.at(-2);
  const emaSlow3ago  = emaSlowArr.at(-4);
  const emaTrend     = emaTrendArr.at(-1);
  const rsi          = rsiArr.at(-1);
  const rsiPrev      = rsiArr.at(-2);
  const atr          = atrArr.at(-1);
  const price        = closes.at(-1);
  const pricePrev    = closes.at(-2);
  const macd         = macdArr.at(-1);
  const macdPrev     = macdArr.at(-2);

  const aboveTrend = price > emaTrend;
  const belowTrend = price < emaTrend;

  // ── LONG triggers (any 2 required) ──────────────────────────────────────────
  const longTriggers = {
    // 1. EMA9/21 bullish cross within last 3 candles
    recentBullCross:
      (emaFast > emaSlow && emaFastPrev  <= emaSlowPrev)  ||
      (emaFast > emaSlow && emaFast3ago  <= emaSlow3ago),

    // 2. Price bounced off EMA21 (was touching/below, now above)
    emaBounce:
      pricePrev <= emaSlowPrev * 1.008 && price > emaSlow,

    // 3. RSI recovering: was below 42, now climbed back above 42
    rsiRecovery:
      rsiPrev < 42 && rsi >= 42,

    // 4. MACD histogram flipped positive
    macdFlip:
      !!(macd && macdPrev && macd.histogram >= 0 && macdPrev.histogram < 0),
  };

  // ── SHORT triggers ───────────────────────────────────────────────────────────
  const shortTriggers = {
    // 1. EMA9/21 bearish cross within last 3 candles
    recentBearCross:
      (emaFast < emaSlow && emaFastPrev  >= emaSlowPrev)  ||
      (emaFast < emaSlow && emaFast3ago  >= emaSlow3ago),

    // 2. Price rejected from EMA21 (was touching/above, now below)
    emaRejection:
      pricePrev >= emaSlowPrev * 0.992 && price < emaSlow,

    // 3. RSI weakening: was above 58, now dropped below 58
    rsiWeaken:
      rsiPrev > 58 && rsi <= 58,

    // 4. MACD histogram flipped negative
    macdFlip:
      !!(macd && macdPrev && macd.histogram <= 0 && macdPrev.histogram > 0),
  };

  const longCount  = Object.values(longTriggers).filter(Boolean).length;
  const shortCount = Object.values(shortTriggers).filter(Boolean).length;

  const indicators = {
    price:    +price.toFixed(2),
    emaFast:  +emaFast.toFixed(2),
    emaSlow:  +emaSlow.toFixed(2),
    emaTrend: +emaTrend.toFixed(2),
    rsi:      +rsi.toFixed(2),
    atr:      +atr.toFixed(2),
    emaCross: emaFast > emaSlow ? 'BULLISH' : 'BEARISH',
    triggersLong:  longCount,
    triggersShort: shortCount,
  };

  // ── LONG signal ──────────────────────────────────────────────────────────────
  if (longCount >= cfg.minTriggers && aboveTrend && rsi < cfg.rsiLongMax) {
    const sl   = price - atr * cfg.slAtrMult;
    const risk = price - sl;
    const firedTriggers = Object.entries(longTriggers)
      .filter(([, v]) => v).map(([k]) => k).join(' + ');

    return {
      signal:     'LONG',
      entry:      +price.toFixed(2),
      stopLoss:   +sl.toFixed(2),
      tp1:        +(price + risk * cfg.tp1Rr).toFixed(2),
      tp2:        +(price + risk * cfg.tp2Rr).toFixed(2),
      tp1Split:   cfg.tp1Split,
      riskReward: cfg.tp1Rr,
      confidence: scoreConfidence('LONG', rsi, longCount, emaFast, emaSlow, emaTrend, price),
      reason:     `Confluence LONG (${longCount}/4): ${firedTriggers} | RSI ${rsi.toFixed(1)} | Above EMA${cfg.emaTrend}`,
      ...indicators,
    };
  }

  // ── SHORT signal ─────────────────────────────────────────────────────────────
  if (shortCount >= cfg.minTriggers && belowTrend && rsi > cfg.rsiShortMin) {
    const sl   = price + atr * cfg.slAtrMult;
    const risk = sl - price;
    const firedTriggers = Object.entries(shortTriggers)
      .filter(([, v]) => v).map(([k]) => k).join(' + ');

    return {
      signal:     'SHORT',
      entry:      +price.toFixed(2),
      stopLoss:   +sl.toFixed(2),
      tp1:        +(price - risk * cfg.tp1Rr).toFixed(2),
      tp2:        +(price - risk * cfg.tp2Rr).toFixed(2),
      tp1Split:   cfg.tp1Split,
      riskReward: cfg.tp1Rr,
      confidence: scoreConfidence('SHORT', rsi, shortCount, emaFast, emaSlow, emaTrend, price),
      reason:     `Confluence SHORT (${shortCount}/4): ${firedTriggers} | RSI ${rsi.toFixed(1)} | Below EMA${cfg.emaTrend}`,
      ...indicators,
    };
  }

  // ── No signal — explain why ──────────────────────────────────────────────────
  const firedLong  = Object.entries(longTriggers).filter(([,v]) => v).map(([k]) => k);
  const firedShort = Object.entries(shortTriggers).filter(([,v]) => v).map(([k]) => k);

  let reason = `No confluence — LONG triggers: ${longCount}/4 [${firedLong.join(',')||'none'}] SHORT triggers: ${shortCount}/4 [${firedShort.join(',')||'none'}]`;

  if (longCount >= cfg.minTriggers && !aboveTrend)
    reason = `LONG blocked: ${longCount} triggers but price below EMA${cfg.emaTrend} ($${emaTrend.toFixed(0)})`;
  else if (longCount >= cfg.minTriggers && rsi >= cfg.rsiLongMax)
    reason = `LONG blocked: ${longCount} triggers but RSI ${rsi.toFixed(1)} overbought (>${cfg.rsiLongMax})`;
  else if (shortCount >= cfg.minTriggers && !belowTrend)
    reason = `SHORT blocked: ${shortCount} triggers but price above EMA${cfg.emaTrend}`;
  else if (shortCount >= cfg.minTriggers && rsi <= cfg.rsiShortMin)
    reason = `SHORT blocked: ${shortCount} triggers but RSI ${rsi.toFixed(1)} oversold (<${cfg.rsiShortMin})`;

  return { signal: null, reason, ...indicators };
}

// Confidence score 55-92 based on trigger count and setup quality
function scoreConfidence(direction, rsi, triggerCount, emaFast, emaSlow, emaTrend, price) {
  let score = 55;

  // More triggers = higher base score
  score += (triggerCount - 2) * 8;  // 2 triggers → +0, 3 → +8, 4 → +16

  if (direction === 'LONG') {
    if (rsi >= 40 && rsi <= 58) score += 12;
    else if (rsi >= 35 && rsi < 40) score += 6;
    const sep = (emaFast - emaSlow) / emaSlow * 100;
    if (sep > 0.3) score += 8;
    const ext = (price - emaTrend) / emaTrend * 100;
    if (ext > 0.5 && ext < 10) score += 8;
    else if (ext >= 10) score -= 5;
  } else {
    if (rsi >= 42 && rsi <= 60) score += 12;
    else if (rsi > 60 && rsi <= 65) score += 6;
    const sep = (emaSlow - emaFast) / emaSlow * 100;
    if (sep > 0.3) score += 8;
    const ext = (emaTrend - price) / emaTrend * 100;
    if (ext > 0.5 && ext < 10) score += 8;
    else if (ext >= 10) score -= 5;
  }

  return Math.min(92, Math.max(55, Math.round(score)));
}

// Current indicator snapshot for status display
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

  const emaFast  = emaFastArr.at(-1);
  const emaSlow  = emaSlowArr.at(-1);
  const emaTrend = emaTrendArr ? emaTrendArr.at(-1) : null;
  const rsi      = rsiArr.at(-1);
  const atr      = atrArr.at(-1);
  const price    = closes.at(-1);

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
