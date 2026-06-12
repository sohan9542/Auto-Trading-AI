// src/aiBrain.js - 3-Stage AI Analysis using Claude Fable 5

const Anthropic = require('@anthropic-ai/sdk');
const { query, getSetting } = require('../database/db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Cost optimization: cheap model for data processing, best model only for final decision
const CHEAP_MODEL = 'claude-haiku-4-5-20251001';   // ~$0.001 per call
const SMART_MODEL = 'claude-sonnet-4-6';             // ~$0.01 per call

// Get last N trade outcomes for learning
async function getLearningMemory(pair, limit = 20) {
  try {
    const result = await query(`
      SELECT t.direction, t.entry_price, t.exit_price, t.pnl_percent, 
             t.close_reason, t.confidence, a.technical_summary, 
             a.news_summary, a.rsi, a.trend, a.macd_signal,
             m.lesson
      FROM trades t
      LEFT JOIN analysis_log a ON t.trade_id = a.trade_id
      LEFT JOIN market_memory m ON m.pair = t.pair 
        AND DATE(m.created_at) = DATE(t.entry_time)
      WHERE t.pair = $1 AND t.status IN ('closed', 'stopped')
      ORDER BY t.exit_time DESC
      LIMIT $2
    `, [pair, limit]);

    return result.rows;
  } catch (err) {
    return [];
  }
}

// Stage 1: Pure Technical Analysis
async function stageTechnical(marketData) {
  const { pair, indicators4h, indicators1h, indicators1d } = marketData;

  const prompt = `You are an elite quantitative trader specializing in technical analysis. 
Analyze ONLY the technical data below and give a directional bias.

## ${pair} Technical Data

### 4H Chart (Primary)
- Price: $${indicators4h.currentPrice}
- RSI(14): ${indicators4h.rsi} [${indicators4h.rsiCondition}]
- MACD: ${JSON.stringify(indicators4h.macd)} [${indicators4h.macdSignal}]
- Bollinger Bands: Upper $${indicators4h.bb?.upper} | Middle $${indicators4h.bb?.middle} | Lower $${indicators4h.bb?.lower}
- EMA20: $${indicators4h.ema20} | EMA50: $${indicators4h.ema50} | EMA200: $${indicators4h.ema200}
- Stochastic K: ${indicators4h.stoch?.k} D: ${indicators4h.stoch?.d}
- ATR: $${indicators4h.atr}
- Volume Ratio: ${indicators4h.volumeRatio}x average
- Trend: ${indicators4h.trend}
- Swing Highs: ${indicators4h.swingHighs?.slice(0,2).join(', ')}
- Swing Lows: ${indicators4h.swingLows?.slice(0,2).join(', ')}

### 1H Chart (Entry Timing)
- RSI: ${indicators1h.rsi} | Trend: ${indicators1h.trend} | MACD: ${indicators1h.macdSignal}

### Daily Chart (Big Picture)
- RSI: ${indicators1d.rsi} | Trend: ${indicators1d.trend} | EMA50: $${indicators1d.ema50}

### Last 5 Candles (4H)
${indicators4h.lastCandles?.map(c => `${c.time}: O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`).join('\n')}

## Required Response (JSON only, no other text):
{
  "bias": "LONG" | "SHORT" | "NEUTRAL",
  "strength": 1-10,
  "confidence": 0-100,
  "key_signals": ["signal1", "signal2", "signal3"],
  "entry_zone": {"low": price, "high": price},
  "stop_loss": price,
  "take_profit_1": price,
  "take_profit_2": price,
  "invalidation": "what would invalidate this setup",
  "summary": "2-3 sentence technical summary"
}`;

  try {
    const response = await client.messages.create({
      model: CHEAP_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('Stage 1 (technical) failed:', err.message);
    return { bias: 'NEUTRAL', confidence: 0, summary: `Stage 1 error: ${err.message}`, key_signals: [], entry_zone: {}, stop_loss: 0, take_profit_1: 0, take_profit_2: 0, strength: 0 };
  }
}

// Stage 2: News & Fundamental Analysis
async function stageNews(marketData) {
  const { pair, news, fearGreed, stats24h, marketContext } = marketData;

  const newsText = news.length > 0
    ? news.map(n => `- [${n.sentiment}] ${n.title} (${n.source})`).join('\n')
    : '- No major news found';

  const prompt = `You are an elite crypto market analyst specializing in news sentiment and fundamental analysis.
Analyze ONLY the news and market sentiment data below.

## ${pair} Market Sentiment Data

### Fear & Greed Index
- Current: ${fearGreed.value}/100 (${fearGreed.label})
- Yesterday: ${fearGreed.yesterday}/100
- Trend: ${fearGreed.trend}
- Context: ${marketContext.fearGreedLevel}

### 24H Market Stats
- Price Change: ${stats24h.priceChangePercent?.toFixed(2)}%
- 24H High: $${stats24h.high24h} | Low: $${stats24h.low24h}
- Volume: $${(stats24h.quoteVolume24h / 1e6)?.toFixed(0)}M (24h)

### Latest News (last 6 hours)
${newsText}

### Market Context
- High Volume: ${marketContext.isHighVolume}
- Trending Market: ${marketContext.isTrending}

## Required Response (JSON only, no other text):
{
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "strength": 1-10,
  "confidence": 0-100,
  "key_catalysts": ["catalyst1", "catalyst2"],
  "risks": ["risk1", "risk2"],
  "news_impact": "HIGH" | "MEDIUM" | "LOW",
  "summary": "2-3 sentence news/sentiment summary"
}`;

  try {
    const response = await client.messages.create({
      model: CHEAP_MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('Stage 2 (news) failed:', err.message);
    return { sentiment: 'NEUTRAL', confidence: 50, summary: `Stage 2 error: ${err.message}`, key_catalysts: [], risks: [], strength: 5, news_impact: 'LOW' };
  }
}

// Stage 3: Final Verdict with Learning Memory
async function stageFinalVerdict(marketData, technical, news, memory) {
  const { pair, indicators4h } = marketData;

  const memoryText = memory.length > 0
    ? memory.slice(0, 10).map(t => {
        const pnl = parseFloat(t.pnl_percent);
        return `- ${t.direction} trade: ${pnl > 0 ? '✅ WIN' : '❌ LOSS'} ${isNaN(pnl) ? 'N/A' : pnl.toFixed(2)}% | RSI was ${t.rsi} | Trend: ${t.trend} | ${t.lesson || 'No lesson recorded'}`;
      }).join('\n')
    : '- No previous trades to learn from yet';

  const recentWinRate = memory.length > 0
    ? (memory.filter(t => parseFloat(t.pnl_percent) > 0).length / memory.length * 100).toFixed(0)
    : 'N/A';

  const fearGreedValue = marketData?.fearGreed?.value || 50;
  const extremeFear = fearGreedValue < 25;

  const prompt = `You are an aggressive but disciplined crypto trader. Make a trading decision.

## ${pair} @ $${indicators4h.currentPrice}
## Fear & Greed: ${fearGreedValue}/100 ${extremeFear ? '← EXTREME FEAR = best time to buy dips' : ''}

## Technical Analysis
- Bias: ${technical.bias} | Confidence: ${technical.confidence}% | Strength: ${technical.strength}/10
- RSI: ${indicators4h.rsi} (${indicators4h.rsiCondition})
- Trend: ${indicators4h.trend} | MACD: ${indicators4h.macdSignal}
- Entry: $${technical.entry_zone?.low}-$${technical.entry_zone?.high}
- Stop Loss: $${technical.stop_loss}
- TP1: $${technical.take_profit_1} | TP2: $${technical.take_profit_2}
- Summary: ${technical.summary}

## News & Sentiment  
- Sentiment: ${news.sentiment} | Confidence: ${news.confidence}%
- Summary: ${news.summary}

## Past Performance
Win rate: ${recentWinRate}%
${memoryText.slice(0, 500)}

## TRADING RULES
- Trade if technical confidence ≥ 55% AND strength ≥ 4
- In EXTREME FEAR: go LONG if RSI < 45 and technical says LONG — news doesn't need to agree
- In UPTREND/DOWNTREND: follow the trend, don't fight it
- SIDEWAYS + volume spike = trade the breakout direction
- Risk/reward must be at least 1.5
- Only SKIP if setup is genuinely unclear or R/R is bad

## JSON response only:
{
  "decision": "LONG" | "SHORT" | "SKIP",
  "confidence": 0-100,
  "entry_price": price,
  "stop_loss": price,
  "take_profit_1": price,
  "take_profit_2": price,
  "risk_reward": number,
  "position_size_multiplier": 0.5-1.5,
  "reasoning": "2-3 sentences why",
  "risk_factors": ["risk1"],
  "lesson_from_memory": "one line",
  "skip_reason": "only if SKIP"
}`;

  try {
    const response = await client.messages.create({
      model: SMART_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('Stage 3 (verdict) failed:', err.message);
    return { decision: 'SKIP', confidence: 0, skip_reason: `Claude API error: ${err.message}` };
  }
}

// Main analysis function - runs all 3 stages
async function runFullAnalysis(marketData) {
  const { pair, indicators4h } = marketData;
  console.log(`🧠 Running 3-stage AI analysis for ${pair}...`);

  const startTime = Date.now();

  // Get learning memory
  const memory = await getLearningMemory(pair);
  console.log(`📚 Loaded ${memory.length} past trade memories`);

  // Run Stage 1 & 2 in parallel
  console.log('Stage 1: Technical analysis...');
  console.log('Stage 2: News & sentiment analysis...');
  const [technical, newsAnalysis] = await Promise.all([
    stageTechnical(marketData),
    stageNews(marketData)
  ]);

  console.log(`✅ Stage 1: ${technical.bias} (${technical.confidence}%)`);
  console.log(`✅ Stage 2: ${newsAnalysis.sentiment} (${newsAnalysis.confidence}%)`);

  // Stage 3: Final verdict
  console.log('Stage 3: Final verdict...');
  const verdict = await stageFinalVerdict(marketData, technical, newsAnalysis, memory);
  console.log(`✅ Stage 3: ${verdict.decision} (${verdict.confidence}%)`);

  const analysisTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`⚡ Analysis completed in ${analysisTime}s`);

  // Log analysis to database
  try {
    await query(`
      INSERT INTO analysis_log 
        (pair, timeframe, direction, confidence, technical_bias, news_bias, 
         final_decision, reasoning, technical_summary, news_summary,
         rsi, macd_signal, trend, fear_greed_index)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [
      pair, '4h', verdict.decision, verdict.confidence,
      technical.bias, newsAnalysis.sentiment, verdict.decision,
      verdict.reasoning, technical.summary, newsAnalysis.summary,
      indicators4h.rsi, indicators4h.macdSignal, indicators4h.trend,
      marketData.fearGreed.value
    ]);

    // Update total analyses count
    const current = await getSetting('total_analyses');
    await query(
      'UPDATE bot_settings SET value = $1 WHERE key = $2',
      [String(parseInt(current || 0) + 1), 'total_analyses']
    );
    await query(
      'UPDATE bot_settings SET value = $1 WHERE key = $2',
      [new Date().toISOString(), 'last_analysis']
    );
  } catch (dbErr) {
    console.error('Failed to log analysis:', dbErr.message);
  }

  return {
    pair,
    technical,
    news: newsAnalysis,
    verdict,
    marketData: {
      price: indicators4h.currentPrice,
      trend: indicators4h.trend,
      rsi: indicators4h.rsi,
      fearGreed: marketData.fearGreed,
      analysisTime
    }
  };
}

// After trade closes, generate a lesson for learning memory
async function generateLesson(trade, marketConditions) {
  const prompt = `A crypto trade just closed. Generate a ONE sentence lesson for future reference.

Trade: ${trade.direction} ${trade.pair}
Entry: $${trade.entry_price} | Exit: $${trade.exit_price}
Result: ${trade.pnl_percent > 0 ? 'WIN' : 'LOSS'} ${trade.pnl_percent?.toFixed(2)}%
Close reason: ${trade.close_reason}
RSI at entry: ${marketConditions?.rsi}
Trend: ${marketConditions?.trend}

Respond with ONLY a one sentence lesson starting with "When RSI..." or "In ${marketConditions?.trend} trend..." or "After ${trade.close_reason}...". No other text.`;

  try {
    const response = await client.messages.create({
      model: CHEAP_MODEL,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }]
    });
    return response.content[0].text.trim();
  } catch (err) {
    return null;
  }
}

module.exports = { runFullAnalysis, generateLesson, getLearningMemory };
