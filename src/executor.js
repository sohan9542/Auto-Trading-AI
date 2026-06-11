// src/executor.js - Trade execution engine (paper + live modes)

const crypto = require('crypto');
const axios = require('axios');
const { query, getSetting, logError } = require('../database/db');
const { getCurrentPrice } = require('./marketData');
const { recordTradeOutcome } = require('./riskGuardian');
const { generateLesson } = require('./aiBrain');

const BINANCE_BASE = 'https://api.binance.com';

// Sign Binance request
function signRequest(params) {
  const queryString = new URLSearchParams(params).toString();
  const signature = crypto
    .createHmac('sha256', process.env.BINANCE_API_SECRET)
    .update(queryString)
    .digest('hex');
  return `${queryString}&signature=${signature}`;
}

// Open a trade (paper or live)
async function openTrade(verdict, pair, position, confidence) {
  const mode = await getSetting('trading_mode');
  const tradeId = `T${Date.now()}`;

  try {
    if (mode === 'live') {
      // LIVE MODE: place real order on Binance
      const side = verdict.decision === 'LONG' ? 'BUY' : 'SELL';
      const params = {
        symbol: pair,
        side,
        type: 'MARKET',
        quoteOrderQty: position.sizeUsdt.toFixed(2),
        timestamp: Date.now()
      };

      const signed = signRequest(params);
      const response = await axios.post(
        `${BINANCE_BASE}/api/v3/order?${signed}`,
        null,
        { headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY }, timeout: 10000 }
      );

      if (!response.data.orderId) {
        throw new Error('Order placement failed - no order ID returned');
      }
      console.log(`💰 LIVE order placed: ${response.data.orderId}`);
    }

    // Record trade in DB (both modes)
    await query(`
      INSERT INTO trades 
        (trade_id, pair, direction, entry_price, stop_loss, take_profit,
         size_usdt, risk_usdt, status, confidence, ai_model)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10)
    `, [
      tradeId, pair, verdict.decision, verdict.entry_price,
      verdict.stop_loss, verdict.take_profit_1,
      position.sizeUsdt, position.riskUsdt, confidence, 'claude-fable-5'
    ]);

    // Link trade to analysis
    await query(
      `UPDATE analysis_log SET trade_id = $1 
       WHERE pair = $2 AND trade_id IS NULL 
       AND analyzed_at > NOW() - INTERVAL '10 minutes'`,
      [tradeId, pair]
    );

    return { success: true, tradeId, mode };
  } catch (err) {
    await logError('TRADE_OPEN_FAILED', err.message, `${pair} ${verdict.decision}`);
    return { success: false, error: err.message };
  }
}

// Check open trades against current price (runs every cycle)
async function monitorOpenTrades(notifyCallback) {
  const openTrades = await query("SELECT * FROM trades WHERE status = 'open'");

  for (const trade of openTrades.rows) {
    try {
      const currentPrice = await getCurrentPrice(trade.pair);
      const entry = parseFloat(trade.entry_price);
      const sl = parseFloat(trade.stop_loss);
      const tp = parseFloat(trade.take_profit);
      const isLong = trade.direction === 'LONG';

      let shouldClose = false;
      let closeReason = '';

      // Check stop loss
      if ((isLong && currentPrice <= sl) || (!isLong && currentPrice >= sl)) {
        shouldClose = true;
        closeReason = 'stop_loss';
      }
      // Check take profit
      else if ((isLong && currentPrice >= tp) || (!isLong && currentPrice <= tp)) {
        shouldClose = true;
        closeReason = 'take_profit';
      }
      // Trailing stop: if profit > 1.5R, move SL to breakeven+
      else {
        const risk = Math.abs(entry - sl);
        const currentProfit = isLong ? currentPrice - entry : entry - currentPrice;
        if (currentProfit > risk * 1.5) {
          const newSL = isLong ? entry + risk * 0.3 : entry - risk * 0.3;
          const slImproved = isLong ? newSL > sl : newSL < sl;
          if (slImproved) {
            await query(
              'UPDATE trades SET stop_loss = $1 WHERE trade_id = $2',
              [newSL, trade.trade_id]
            );
            if (notifyCallback) {
              notifyCallback(`🔒 Trailing stop activated on ${trade.pair} ${trade.direction}\nStop moved to $${newSL.toFixed(2)} (profit locked in)`);
            }
          }
        }
      }

      if (shouldClose) {
        await closeTrade(trade, currentPrice, closeReason, notifyCallback);
      }
    } catch (err) {
      await logError('MONITOR_FAILED', err.message, trade.trade_id);
    }
  }
}

// Close a trade
async function closeTrade(trade, exitPrice, reason, notifyCallback) {
  const mode = await getSetting('trading_mode');
  const entry = parseFloat(trade.entry_price);
  const size = parseFloat(trade.size_usdt);
  const isLong = trade.direction === 'LONG';

  // Calculate P&L
  const priceChange = isLong
    ? (exitPrice - entry) / entry
    : (entry - exitPrice) / entry;
  const pnlUsdt = size * priceChange;
  const pnlPercent = priceChange * 100;

  try {
    if (mode === 'live') {
      // Close position on Binance (sell what we bought, or buy back what we sold)
      const side = isLong ? 'SELL' : 'BUY';
      const units = size / entry;
      const params = {
        symbol: trade.pair,
        side,
        type: 'MARKET',
        quantity: units.toFixed(6),
        timestamp: Date.now()
      };
      const signed = signRequest(params);
      await axios.post(
        `${BINANCE_BASE}/api/v3/order?${signed}`,
        null,
        { headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY }, timeout: 10000 }
      );
    }

    // Update DB
    await query(`
      UPDATE trades SET 
        status = 'closed', exit_price = $1, pnl_usdt = $2, 
        pnl_percent = $3, close_reason = $4, exit_time = NOW()
      WHERE trade_id = $5
    `, [exitPrice, pnlUsdt.toFixed(2), pnlPercent.toFixed(4), reason, trade.trade_id]);

    // Update risk tracking & portfolio
    await recordTradeOutcome(pnlUsdt);

    // Generate learning lesson
    const analysisData = await query(
      'SELECT rsi, trend FROM analysis_log WHERE trade_id = $1', [trade.trade_id]
    );
    const conditions = analysisData.rows[0] || {};
    const lesson = await generateLesson(
      { ...trade, exit_price: exitPrice, pnl_percent: pnlPercent, close_reason: reason },
      conditions
    );

    if (lesson) {
      await query(`
        INSERT INTO market_memory (pattern_type, pair, conditions, outcome, pnl_percent, lesson)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        reason, trade.pair, JSON.stringify(conditions),
        pnlUsdt > 0 ? 'win' : 'loss', pnlPercent.toFixed(4), lesson
      ]);
    }

    // Notify user
    const emoji = pnlUsdt > 0 ? '✅💰' : '❌';
    const reasonText = reason === 'take_profit' ? 'Take Profit hit 🎯'
      : reason === 'stop_loss' ? 'Stop Loss hit 🛑'
      : reason;

    if (notifyCallback) {
      notifyCallback(
        `${emoji} TRADE CLOSED — ${trade.pair}\n\n` +
        `Direction: ${trade.direction}\n` +
        `Entry: $${entry.toFixed(2)}\n` +
        `Exit: $${exitPrice.toFixed(2)}\n` +
        `P&L: ${pnlUsdt > 0 ? '+' : ''}$${pnlUsdt.toFixed(2)} (${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n` +
        `Reason: ${reasonText}\n` +
        (lesson ? `\n📚 Lesson learned: ${lesson}` : '')
      );
    }

    return { success: true, pnlUsdt, pnlPercent };
  } catch (err) {
    await logError('TRADE_CLOSE_FAILED', err.message, trade.trade_id);
    return { success: false, error: err.message };
  }
}

// Emergency: close all open trades
async function closeAllTrades(notifyCallback) {
  const openTrades = await query("SELECT * FROM trades WHERE status = 'open'");
  const results = [];

  for (const trade of openTrades.rows) {
    const currentPrice = await getCurrentPrice(trade.pair);
    const result = await closeTrade(trade, currentPrice, 'manual', notifyCallback);
    results.push({ pair: trade.pair, ...result });
  }

  return results;
}

module.exports = { openTrade, monitorOpenTrades, closeTrade, closeAllTrades };
