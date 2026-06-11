// src/marketData.js - Fetch live market data & calculate indicators

const axios = require('axios');
const {
  RSI, MACD, BollingerBands, EMA, SMA, ATR, Stochastic
} = require('technicalindicators');

const BINANCE_BASE = 'https://api.binance.com/api/v3';

// Fetch OHLCV candles from Binance
async function getCandles(pair, interval, limit = 100) {
  try {
    const response = await axios.get(`${BINANCE_BASE}/klines`, {
      params: { symbol: pair, interval, limit },
      timeout: 10000
    });

    return response.data.map(c => ({
      time: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
      closeTime: c[6]
    }));
  } catch (err) {
    console.error(`Failed to fetch candles for ${pair}:`, err.message);
    throw err;
  }
}

// Get current price
async function getCurrentPrice(pair) {
  const response = await axios.get(`${BINANCE_BASE}/ticker/price`, {
    params: { symbol: pair },
    timeout: 5000
  });
  return parseFloat(response.data.price);
}

// Get 24h stats
async function get24hStats(pair) {
  const response = await axios.get(`${BINANCE_BASE}/ticker/24hr`, {
    params: { symbol: pair },
    timeout: 5000
  });
  return {
    priceChange: parseFloat(response.data.priceChange),
    priceChangePercent: parseFloat(response.data.priceChangePercent),
    high24h: parseFloat(response.data.highPrice),
    low24h: parseFloat(response.data.lowPrice),
    volume24h: parseFloat(response.data.volume),
    quoteVolume24h: parseFloat(response.data.quoteVolume)
  };
}

// Calculate all technical indicators
function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  // RSI (14)
  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiValues[rsiValues.length - 1];
  const rsiPrev = rsiValues[rsiValues.length - 2];

  // MACD (12, 26, 9)
  const macdValues = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26,
    signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false
  });
  const macd = macdValues[macdValues.length - 1];
  const macdPrev = macdValues[macdValues.length - 2];

  // Bollinger Bands (20, 2)
  const bbValues = BollingerBands.calculate({
    values: closes, period: 20, stdDev: 2
  });
  const bb = bbValues[bbValues.length - 1];

  // EMAs
  const ema20Values = EMA.calculate({ values: closes, period: 20 });
  const ema50Values = EMA.calculate({ values: closes, period: 50 });
  const ema200Values = EMA.calculate({ values: closes, period: 200 });
  const ema20 = ema20Values[ema20Values.length - 1];
  const ema50 = ema50Values[ema50Values.length - 1];
  const ema200 = ema200Values[ema200Values.length - 1];

  // ATR (14) - for stop loss calculation
  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrValues[atrValues.length - 1];

  // Stochastic (14, 3, 3)
  const stochValues = Stochastic.calculate({
    high: highs, low: lows, close: closes,
    period: 14, signalPeriod: 3
  });
  const stoch = stochValues[stochValues.length - 1];

  // Volume analysis
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const currentVolume = volumes[volumes.length - 1];
  const volumeRatio = currentVolume / avgVolume;

  // Trend determination
  const currentPrice = closes[closes.length - 1];
  let trend = 'SIDEWAYS';
  if (currentPrice > ema50 && ema50 > ema200) trend = 'STRONG_UPTREND';
  else if (currentPrice > ema20 && currentPrice > ema50) trend = 'UPTREND';
  else if (currentPrice < ema50 && ema50 < ema200) trend = 'STRONG_DOWNTREND';
  else if (currentPrice < ema20 && currentPrice < ema50) trend = 'DOWNTREND';

  // Support/Resistance levels (simple swing high/low)
  const recentCandles = candles.slice(-20);
  const swingHighs = recentCandles.map(c => c.high).sort((a, b) => b - a).slice(0, 3);
  const swingLows = recentCandles.map(c => c.low).sort((a, b) => a - b).slice(0, 3);

  // MACD signal
  let macdSignal = 'NEUTRAL';
  if (macd && macdPrev) {
    if (macd.histogram > 0 && macdPrev.histogram < 0) macdSignal = 'BULLISH_CROSS';
    else if (macd.histogram < 0 && macdPrev.histogram > 0) macdSignal = 'BEARISH_CROSS';
    else if (macd.histogram > 0) macdSignal = 'BULLISH';
    else if (macd.histogram < 0) macdSignal = 'BEARISH';
  }

  // RSI divergence check (simple)
  let rsiCondition = 'NEUTRAL';
  if (rsi < 30) rsiCondition = 'OVERSOLD';
  else if (rsi > 70) rsiCondition = 'OVERBOUGHT';
  else if (rsi < 45 && rsi > rsiPrev) rsiCondition = 'RECOVERING';
  else if (rsi > 55 && rsi < rsiPrev) rsiCondition = 'WEAKENING';

  return {
    currentPrice,
    rsi: parseFloat(rsi?.toFixed(2)),
    rsiPrev: parseFloat(rsiPrev?.toFixed(2)),
    rsiCondition,
    macd: macd ? {
      macd: parseFloat(macd.MACD?.toFixed(4)),
      signal: parseFloat(macd.signal?.toFixed(4)),
      histogram: parseFloat(macd.histogram?.toFixed(4))
    } : null,
    macdSignal,
    bb: bb ? {
      upper: parseFloat(bb.upper?.toFixed(2)),
      middle: parseFloat(bb.middle?.toFixed(2)),
      lower: parseFloat(bb.lower?.toFixed(2)),
      bandwidth: parseFloat(((bb.upper - bb.lower) / bb.middle * 100)?.toFixed(2))
    } : null,
    ema20: parseFloat(ema20?.toFixed(2)),
    ema50: parseFloat(ema50?.toFixed(2)),
    ema200: parseFloat(ema200?.toFixed(2)),
    atr: parseFloat(atr?.toFixed(2)),
    stoch: stoch ? {
      k: parseFloat(stoch.k?.toFixed(2)),
      d: parseFloat(stoch.d?.toFixed(2))
    } : null,
    volumeRatio: parseFloat(volumeRatio?.toFixed(2)),
    trend,
    swingHighs,
    swingLows,
    lastCandles: candles.slice(-5).map(c => ({
      time: new Date(c.time).toISOString(),
      open: c.open, high: c.high, low: c.low,
      close: c.close, volume: parseFloat(c.volume.toFixed(2))
    }))
  };
}

// Fear & Greed Index
async function getFearAndGreed() {
  try {
    const response = await axios.get('https://api.alternative.me/fng/?limit=2', {
      timeout: 8000
    });
    const data = response.data.data;
    return {
      value: parseInt(data[0].value),
      label: data[0].value_classification,
      yesterday: parseInt(data[1].value),
      trend: parseInt(data[0].value) > parseInt(data[1].value) ? 'IMPROVING' : 'DECLINING'
    };
  } catch (err) {
    console.error('Fear & Greed fetch failed:', err.message);
    return { value: 50, label: 'Neutral', yesterday: 50, trend: 'STABLE' };
  }
}

// Crypto news from CryptoPanic
async function getCryptoNews(pair) {
  try {
    const coin = pair.replace('USDT', '').toLowerCase();
    const response = await axios.get('https://cryptopanic.com/api/v1/posts/', {
      params: {
        auth_token: process.env.CRYPTOPANIC_API_KEY,
        currencies: coin.toUpperCase(),
        filter: 'hot',
        limit: 20
      },
      timeout: 10000
    });

    if (!response.data?.results) return [];

    return response.data.results.slice(0, 15).map(post => ({
      title: post.title,
      source: post.source?.title || 'Unknown',
      publishedAt: post.published_at,
      sentiment: post.votes ? analyzeSentiment(post.votes) : 'NEUTRAL',
      url: post.url
    }));
  } catch (err) {
    console.error('News fetch failed:', err.message);
    return [];
  }
}

function analyzeSentiment(votes) {
  const bullish = (votes.positive || 0) + (votes.liked || 0);
  const bearish = (votes.negative || 0) + (votes.disliked || 0);
  if (bullish > bearish * 1.5) return 'BULLISH';
  if (bearish > bullish * 1.5) return 'BEARISH';
  return 'NEUTRAL';
}

// Collect ALL market data in one call
async function collectMarketData(pair) {
  console.log(`📊 Collecting market data for ${pair}...`);

  const [
    candles4h, candles1h, candles1d,
    stats24h, fearGreed, news
  ] = await Promise.all([
    getCandles(pair, '4h', 100),
    getCandles(pair, '1h', 50),
    getCandles(pair, '1d', 30),
    get24hStats(pair),
    getFearAndGreed(),
    getCryptoNews(pair)
  ]);

  const indicators4h = calculateIndicators(candles4h);
  const indicators1h = calculateIndicators(candles1h);
  const indicators1d = calculateIndicators(candles1d);

  return {
    pair,
    timestamp: new Date().toISOString(),
    currentPrice: indicators4h.currentPrice,
    stats24h,
    indicators4h,
    indicators1h,
    indicators1d,
    fearGreed,
    news: news.slice(0, 10),
    marketContext: {
      isHighVolume: indicators4h.volumeRatio > 1.5,
      isTrending: !['SIDEWAYS'].includes(indicators4h.trend),
      fearGreedLevel: fearGreed.value < 25 ? 'EXTREME_FEAR' :
                      fearGreed.value < 45 ? 'FEAR' :
                      fearGreed.value < 55 ? 'NEUTRAL' :
                      fearGreed.value < 75 ? 'GREED' : 'EXTREME_GREED'
    }
  };
}

module.exports = {
  collectMarketData, getCandles, getCurrentPrice,
  get24hStats, getFearAndGreed, getCryptoNews
};
