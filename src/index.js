// src/index.js - Main orchestrator: the bot's heartbeat

require('dotenv').config();
const cron = require('node-cron');
const { initializeDatabase, getSetting, setSetting, query, logError } = require('../database/db');
const { collectMarketData } = require('./marketData');
const { runFullAnalysis } = require('./aiBrain');
const { validateTrade, calculatePositionSize, resetDailyCounters, resetWeeklyCounters } = require('./riskGuardian');
const { openTrade, monitorOpenTrades } = require('./executor');
const { initTelegram, send } = require('./telegram');

const PAIRS = (process.env.TRADE_PAIRS || 'BTCUSDT,ETHUSDT').split(',');

let isAnalyzing = false;

// ============ MAIN ANALYSIS CYCLE ============
async function runAnalysisCycle() {
  if (isAnalyzing) {
    console.log('⏭️ Analysis already in progress, skipping');
    return;
  }

  const isPaused = await getSetting('is_paused');
  if (isPaused === 'true') {
    console.log('⏸️ Bot paused, skipping analysis');
    return;
  }

  isAnalyzing = true;

  try {
    for (const pair of PAIRS) {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`🔄 Analysis cycle: ${pair} @ ${new Date().toISOString()}`);

      // 1. Collect all market data
      const marketData = await collectMarketData(pair);

      // 2. Run 3-stage AI analysis
      const analysis = await runFullAnalysis(marketData);
      const { verdict } = analysis;

      // 3. If AI says trade, validate against risk rules
      if (['LONG', 'SHORT'].includes(verdict.decision)) {
        const validation = await validateTrade(verdict, pair);

        if (validation.approved) {
          // 4. Calculate position size
          const position = await calculatePositionSize(verdict, validation.sizeMultiplier);

          // 5. Execute
          const result = await openTrade(verdict, pair, position, verdict.confidence);

          if (result.success) {
            send(
              `🚀 *NEW TRADE OPENED* ${result.mode === 'live' ? '🔴 LIVE' : '📝 Paper'}\n\n` +
              `${verdict.decision === 'LONG' ? '📈' : '📉'} *${pair}* ${verdict.decision}\n\n` +
              `Entry: $${verdict.entry_price}\n` +
              `Stop Loss: $${verdict.stop_loss}\n` +
              `Take Profit: $${verdict.take_profit_1}\n` +
              `Risk/Reward: 1:${validation.riskReward?.toFixed(1)}\n` +
              `Size: $${position.sizeUsdt} (risking $${position.riskUsdt})\n` +
              `Confidence: ${verdict.confidence}%\n\n` +
              `🧠 *Reasoning:*\n${verdict.reasoning}\n\n` +
              (verdict.lesson_from_memory ? `📚 Memory: ${verdict.lesson_from_memory}\n\n` : '') +
              (validation.notes?.length ? validation.notes.join('\n') : '')
            );
          } else {
            send(`⚠️ Trade signal approved but execution failed: ${result.error}`);
          }
        } else {
          console.log(`🛡️ Risk Guardian blocked: ${validation.reason}`);
          if (validation.critical) {
            send(`🛡️ *RISK GUARDIAN ALERT*\n\n${validation.reason}`);
          } else {
            send(
              `🛡️ Signal blocked by Risk Guardian\n\n` +
              `${pair}: AI wanted ${verdict.decision} (${verdict.confidence}%)\n` +
              `Blocked because: ${validation.reason}`
            );
          }
        }
      } else {
        console.log(`⏭️ ${pair}: SKIP — ${verdict.skip_reason || 'No clear setup'}`);
        // Silent skip - only notify on /lastanalysis to avoid spam
      }
    }
  } catch (err) {
    console.error('❌ Analysis cycle failed:', err.message);
    await logError('ANALYSIS_CYCLE_FAILED', err.message);
    send(`⚠️ Analysis cycle error: ${err.message}\n\nWill retry next cycle. If this repeats, check /status.`);
  } finally {
    isAnalyzing = false;
  }
}

// ============ DAILY REPORT ============
async function sendDailyReport() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const trades = await query(
      "SELECT * FROM trades WHERE DATE(exit_time) = $1 AND status IN ('closed','stopped')", [today]
    );
    const portfolio = parseFloat(await getSetting('current_portfolio'));
    const initial = parseFloat(process.env.PORTFOLIO_SIZE || 1000);

    const wins = trades.rows.filter(t => parseFloat(t.pnl_usdt) > 0).length;
    const total = trades.rows.length;
    const pnl = trades.rows.reduce((s, t) => s + parseFloat(t.pnl_usdt || 0), 0);

    // Save to daily_reports table
    await query(`
      INSERT INTO daily_reports (report_date, total_trades, winning_trades, losing_trades, win_rate, total_pnl_usdt, portfolio_value)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (report_date) DO UPDATE SET
        total_trades = $2, winning_trades = $3, losing_trades = $4,
        win_rate = $5, total_pnl_usdt = $6, portfolio_value = $7
    `, [today, total, wins, total - wins, total > 0 ? wins / total * 100 : 0, pnl, portfolio]);

    send(
      `🌙 *End of Day Report — ${today}*\n\n` +
      `Trades: ${total} (${wins}W / ${total - wins}L)\n` +
      `Day P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n` +
      `Portfolio: $${portfolio.toFixed(2)}\n` +
      `All-time: ${((portfolio - initial) / initial * 100).toFixed(2)}%\n\n` +
      `${pnl > 0 ? '✅ Profitable day!' : total === 0 ? '😴 Quiet day, no trades closed.' : '📉 Red day — risk rules kept losses controlled.'}\n\n` +
      `Bot continues monitoring overnight. Sleep well 🌙`
    );
  } catch (err) {
    console.error('Daily report failed:', err.message);
  }
}

// ============ STARTUP ============
async function start() {
  console.log('🚀 Starting AI Trading Bot...\n');

  // 1. Initialize database
  await initializeDatabase();

  // 2. Set initial portfolio if first run
  const portfolio = await getSetting('current_portfolio');
  if (!portfolio || portfolio === '1000') {
    await setSetting('current_portfolio', process.env.PORTFOLIO_SIZE || '1000');
  }

  // 3. Start Telegram bot
  initTelegram(() => runAnalysisCycle());

  // 4. Schedule jobs
  // Full analysis every 4 hours (at candle close: 0:00, 4:00, 8:00, 12:00, 16:00, 20:00 UTC)
  cron.schedule('1 0,4,8,12,16,20 * * *', () => {
    console.log('⏰ Scheduled 4H analysis triggered');
    runAnalysisCycle();
  }, { timezone: 'UTC' });

  // Monitor open trades every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    monitorOpenTrades(send);
  });

  // Daily report at 23:55 UTC
  cron.schedule('55 23 * * *', () => {
    sendDailyReport();
  }, { timezone: 'UTC' });

  // Reset daily loss counter at midnight UTC
  cron.schedule('0 0 * * *', () => {
    resetDailyCounters();
  }, { timezone: 'UTC' });

  // Reset weekly loss counter Monday midnight UTC
  cron.schedule('0 0 * * 1', () => {
    resetWeeklyCounters();
  }, { timezone: 'UTC' });

  console.log('\n✅ Bot fully operational');
  console.log(`📊 Trading pairs: ${PAIRS.join(', ')}`);
  console.log(`🤖 Mode: ${await getSetting('trading_mode')}`);
  console.log('⏰ Next analysis: next 4H candle close (UTC 0/4/8/12/16/20)');

  send(
    `🚀 *Bot Started Successfully*\n\n` +
    `Mode: ${await getSetting('trading_mode')}\n` +
    `Pairs: ${PAIRS.join(', ')}\n` +
    `Analysis: every 4 hours\n` +
    `Trade monitoring: every 5 minutes\n\n` +
    `I'll message you when:\n` +
    `• A trade opens or closes\n` +
    `• Risk limits are approached\n` +
    `• Daily report (23:55 UTC)\n\n` +
    `Type /help for commands or /forcecheck to analyze now.`
  );

  // Run first analysis 30 seconds after startup
  setTimeout(() => runAnalysisCycle(), 30000);
}

// Graceful error handling - never crash silently
process.on('unhandledRejection', async (err) => {
  console.error('Unhandled rejection:', err.message);
  await logError('UNHANDLED_REJECTION', err.message).catch(() => {});
});

process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err.message);
  await logError('UNCAUGHT_EXCEPTION', err.message).catch(() => {});
  send(`⚠️ Bot encountered a critical error and is restarting: ${err.message}`);
  setTimeout(() => process.exit(1), 3000); // Railway auto-restarts
});

start().catch(err => {
  console.error('❌ Startup failed:', err.message);
  process.exit(1);
});
