// src/telegram.js - Telegram bot interface with all commands

const TelegramBot = require('node-telegram-bot-api');
const { query, getSetting, setSetting } = require('../database/db');
const { closeAllTrades } = require('./executor');
const { getLearningMemory } = require('./aiBrain');

let bot = null;
let chatId = null;

function initTelegram(onForceCheck) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  chatId = process.env.TELEGRAM_CHAT_ID;

  // ============ INFO COMMANDS ============

  bot.onText(/\/start/, (msg) => {
    send(
      `🤖 *AI Trading Bot Online*\n\n` +
      `I analyze BTC & ETH every 4 hours using a 3-stage AI system and manage trades automatically.\n\n` +
      `Currently in *${process.env.TRADING_MODE || 'paper'}* mode.\n\n` +
      `Type /help to see all commands.`
    );
  });

  bot.onText(/\/help/, () => {
    send(
      `📋 *All Commands*\n\n` +
      `*Info*\n` +
      `/open — open trades with live P&L\n` +
      `/closed — last 20 closed trades\n` +
      `/report — today's full report\n` +
      `/weekly — weekly performance\n` +
      `/balance — portfolio status\n` +
      `/winrate — accuracy statistics\n` +
      `/lastanalysis — latest AI analysis\n` +
      `/memory — recent lessons learned\n\n` +
      `*Control*\n` +
      `/pause — stop all automation\n` +
      `/resume — resume automation\n` +
      `/livemode — switch to REAL trading\n` +
      `/papermode — switch to paper trading\n` +
      `/forcecheck — analyze market right now\n` +
      `/closeall — emergency close all trades\n` +
      `/setsize X — risk % per trade (e.g. /setsize 1.5)\n\n` +
      `*Status*\n` +
      `/status — bot health check\n` +
      `/settings — current configuration`
    );
  });

  bot.onText(/\/open/, async () => {
    const result = await query("SELECT * FROM trades WHERE status = 'open' ORDER BY entry_time DESC");
    if (result.rows.length === 0) {
      return send('📭 No open trades right now.\n\nThe AI is waiting for a high-confidence setup.');
    }

    const { getCurrentPrice } = require('./marketData');
    let text = `📊 *Open Trades (${result.rows.length})*\n\n`;

    for (const t of result.rows) {
      const current = await getCurrentPrice(t.pair);
      const entry = parseFloat(t.entry_price);
      const isLong = t.direction === 'LONG';
      const pnlPct = (isLong ? (current - entry) / entry : (entry - current) / entry) * 100;
      const pnlUsd = parseFloat(t.size_usdt) * pnlPct / 100;
      const emoji = pnlPct >= 0 ? '🟢' : '🔴';

      text += `${emoji} *${t.pair}* ${t.direction}\n` +
        `Entry: $${entry.toFixed(2)} → Now: $${current.toFixed(2)}\n` +
        `P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)})\n` +
        `SL: $${parseFloat(t.stop_loss).toFixed(2)} | TP: $${parseFloat(t.take_profit).toFixed(2)}\n` +
        `Size: $${parseFloat(t.size_usdt).toFixed(2)} | Confidence: ${t.confidence}%\n` +
        `Opened: ${new Date(t.entry_time).toLocaleString()}\n\n`;
    }
    send(text);
  });

  bot.onText(/\/closed/, async () => {
    const result = await query(
      "SELECT * FROM trades WHERE status IN ('closed','stopped') ORDER BY exit_time DESC LIMIT 20"
    );
    if (result.rows.length === 0) return send('📭 No closed trades yet.');

    let text = `📜 *Last ${result.rows.length} Closed Trades*\n\n`;
    let totalPnl = 0;

    for (const t of result.rows) {
      const pnl = parseFloat(t.pnl_usdt || 0);
      totalPnl += pnl;
      const emoji = pnl > 0 ? '✅' : '❌';
      text += `${emoji} ${t.pair} ${t.direction} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${parseFloat(t.pnl_percent).toFixed(2)}%) | ${t.close_reason}\n`;
    }
    text += `\n💰 Total: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`;
    send(text);
  });

  bot.onText(/\/report/, async () => {
    const today = new Date().toISOString().split('T')[0];
    const trades = await query(
      "SELECT * FROM trades WHERE DATE(exit_time) = $1 AND status IN ('closed','stopped')", [today]
    );
    const analyses = await query(
      "SELECT COUNT(*) FROM analysis_log WHERE DATE(analyzed_at) = $1", [today]
    );
    const skipped = await query(
      "SELECT COUNT(*) FROM analysis_log WHERE DATE(analyzed_at) = $1 AND final_decision = 'SKIP'", [today]
    );
    const portfolio = parseFloat(await getSetting('current_portfolio'));
    const initial = parseFloat(process.env.PORTFOLIO_SIZE || 1000);

    const wins = trades.rows.filter(t => parseFloat(t.pnl_usdt) > 0);
    const losses = trades.rows.filter(t => parseFloat(t.pnl_usdt) <= 0);
    const totalPnl = trades.rows.reduce((s, t) => s + parseFloat(t.pnl_usdt || 0), 0);
    const winRate = trades.rows.length > 0 ? (wins.length / trades.rows.length * 100).toFixed(0) : 'N/A';

    send(
      `📊 *Daily Report — ${today}*\n\n` +
      `💼 Portfolio: $${portfolio.toFixed(2)}\n` +
      `📈 Total Return: ${((portfolio - initial) / initial * 100).toFixed(2)}% all-time\n\n` +
      `*Today*\n` +
      `Trades closed: ${trades.rows.length}\n` +
      `Wins: ${wins.length} | Losses: ${losses.length}\n` +
      `Win rate: ${winRate}%\n` +
      `P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\n\n` +
      `*AI Activity*\n` +
      `Analyses run: ${analyses.rows[0].count}\n` +
      `Setups skipped: ${skipped.rows[0].count} (discipline 💪)\n` +
      `Mode: ${await getSetting('trading_mode')}`
    );
  });

  bot.onText(/\/weekly/, async () => {
    const result = await query(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE pnl_usdt > 0) as wins,
        COALESCE(SUM(pnl_usdt), 0) as pnl,
        COALESCE(MAX(pnl_usdt), 0) as best,
        COALESCE(MIN(pnl_usdt), 0) as worst
      FROM trades 
      WHERE exit_time > NOW() - INTERVAL '7 days' AND status IN ('closed','stopped')
    `);
    const r = result.rows[0];
    const winRate = r.total > 0 ? (r.wins / r.total * 100).toFixed(0) : 'N/A';

    send(
      `📅 *Weekly Performance*\n\n` +
      `Trades: ${r.total}\n` +
      `Win rate: ${winRate}%\n` +
      `Total P&L: ${r.pnl >= 0 ? '+' : ''}$${parseFloat(r.pnl).toFixed(2)}\n` +
      `Best trade: +$${parseFloat(r.best).toFixed(2)}\n` +
      `Worst trade: $${parseFloat(r.worst).toFixed(2)}`
    );
  });

  bot.onText(/\/balance/, async () => {
    const portfolio = parseFloat(await getSetting('current_portfolio'));
    const initial = parseFloat(process.env.PORTFOLIO_SIZE || 1000);
    const openResult = await query("SELECT COALESCE(SUM(size_usdt),0) as locked FROM trades WHERE status = 'open'");
    const locked = parseFloat(openResult.rows[0].locked);
    const change = portfolio - initial;

    send(
      `💼 *Portfolio Status*\n\n` +
      `Total value: $${portfolio.toFixed(2)}\n` +
      `In open trades: $${locked.toFixed(2)}\n` +
      `Available: $${(portfolio - locked).toFixed(2)}\n\n` +
      `All-time P&L: ${change >= 0 ? '+' : ''}$${change.toFixed(2)} (${(change / initial * 100).toFixed(2)}%)\n` +
      `Mode: ${await getSetting('trading_mode')}`
    );
  });

  bot.onText(/\/winrate/, async () => {
    const result = await query(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE pnl_usdt > 0) as wins,
        AVG(confidence) as avg_conf,
        AVG(pnl_percent) FILTER (WHERE pnl_usdt > 0) as avg_win,
        AVG(pnl_percent) FILTER (WHERE pnl_usdt <= 0) as avg_loss
      FROM trades WHERE status IN ('closed','stopped')
    `);
    const r = result.rows[0];
    if (parseInt(r.total) === 0) return send('📭 No completed trades yet to calculate win rate.');

    const winRate = (r.wins / r.total * 100).toFixed(1);
    send(
      `🎯 *Accuracy Statistics*\n\n` +
      `Total trades: ${r.total}\n` +
      `Win rate: ${winRate}%\n` +
      `Avg AI confidence: ${parseFloat(r.avg_conf).toFixed(0)}%\n` +
      `Avg win: +${parseFloat(r.avg_win || 0).toFixed(2)}%\n` +
      `Avg loss: ${parseFloat(r.avg_loss || 0).toFixed(2)}%\n\n` +
      (parseFloat(winRate) >= 65
        ? `✅ Above 65% target — system is working`
        : `⚠️ Below 65% target — keep paper trading`)
    );
  });

  bot.onText(/\/lastanalysis/, async () => {
    const result = await query('SELECT * FROM analysis_log ORDER BY analyzed_at DESC LIMIT 2');
    if (result.rows.length === 0) return send('No analyses yet. First one runs at next 4H candle, or use /forcecheck.');

    let text = `🧠 *Latest AI Analysis*\n\n`;
    for (const a of result.rows) {
      text += `*${a.pair}* — ${new Date(a.analyzed_at).toLocaleString()}\n` +
        `Decision: ${a.final_decision} (${a.confidence}%)\n` +
        `Technical: ${a.technical_bias} | News: ${a.news_bias}\n` +
        `RSI: ${a.rsi} | Trend: ${a.trend}\n` +
        `Fear/Greed: ${a.fear_greed_index}\n` +
        `Reasoning: ${a.reasoning?.substring(0, 300)}\n\n`;
    }
    send(text);
  });

  bot.onText(/\/memory/, async () => {
    const result = await query('SELECT * FROM market_memory ORDER BY created_at DESC LIMIT 10');
    if (result.rows.length === 0) return send('📚 No lessons learned yet. They appear after trades close.');

    let text = `📚 *Recent Lessons Learned*\n\n`;
    for (const m of result.rows) {
      const emoji = m.outcome === 'win' ? '✅' : '❌';
      text += `${emoji} ${m.pair}: ${m.lesson}\n\n`;
    }
    send(text);
  });

  // ============ CONTROL COMMANDS ============

  bot.onText(/\/pause/, async () => {
    await setSetting('is_paused', 'true');
    send('⏸️ *Bot PAUSED*\n\nNo new trades will open. Open trades still monitored (SL/TP active).\n\nUse /resume to restart.');
  });

  bot.onText(/\/resume/, async () => {
    await setSetting('is_paused', 'false');
    await setSetting('consecutive_losses', '0');
    send('▶️ *Bot RESUMED*\n\nAutomation active. Next analysis at next 4H candle, or /forcecheck now.');
  });

  let liveModeConfirm = false;
  bot.onText(/\/livemode/, async () => {
    if (!liveModeConfirm) {
      liveModeConfirm = true;
      setTimeout(() => { liveModeConfirm = false; }, 60000);
      send(
        `⚠️ *SWITCH TO LIVE TRADING?*\n\n` +
        `This will use REAL MONEY on your Binance account.\n\n` +
        `Before confirming, make sure:\n` +
        `1. Paper trading showed 65%+ win rate (/winrate)\n` +
        `2. You've watched it for at least 2 weeks\n` +
        `3. Your Binance API key has trade permission\n` +
        `4. You're only risking money you can afford to lose\n\n` +
        `Type /livemode again within 60 seconds to confirm.`
      );
    } else {
      liveModeConfirm = false;
      await setSetting('trading_mode', 'live');
      send('🔴 *LIVE MODE ACTIVE*\n\nReal money trading enabled. Risk rules enforced strictly.\n\nUse /papermode to switch back anytime.');
    }
  });

  bot.onText(/\/papermode/, async () => {
    await setSetting('trading_mode', 'paper');
    send('📝 *Paper mode active*\n\nAll trades are simulated. Zero risk.');
  });

  bot.onText(/\/forcecheck/, async () => {
    send('🔍 Running full market analysis now... (takes ~30-60 seconds)');
    if (onForceCheck) onForceCheck();
  });

  bot.onText(/\/closeall/, async () => {
    send('🚨 Closing all open trades...');
    const results = await closeAllTrades(send);
    if (results.length === 0) send('No open trades to close.');
  });

  bot.onText(/\/setsize (.+)/, async (msg, match) => {
    const size = parseFloat(match[1]);
    if (isNaN(size) || size < 0.5 || size > 3) {
      return send('⚠️ Size must be between 0.5 and 3 (% risk per trade).\nExample: /setsize 1.5');
    }
    process.env.MAX_RISK_PER_TRADE = String(size);
    send(`✅ Risk per trade set to ${size}%`);
  });

  // ============ STATUS COMMANDS ============

  bot.onText(/\/status/, async () => {
    const isPaused = await getSetting('is_paused');
    const mode = await getSetting('trading_mode');
    const lastAnalysis = await getSetting('last_analysis');
    const totalAnalyses = await getSetting('total_analyses');
    const losses = await getSetting('consecutive_losses');
    const openResult = await query("SELECT COUNT(*) FROM trades WHERE status = 'open'");

    send(
      `🤖 *Bot Status*\n\n` +
      `State: ${isPaused === 'true' ? '⏸️ PAUSED' : '✅ RUNNING'}\n` +
      `Mode: ${mode === 'live' ? '🔴 LIVE' : '📝 Paper'}\n` +
      `Open trades: ${openResult.rows[0].count}\n` +
      `Consecutive losses: ${losses}\n` +
      `Total analyses: ${totalAnalyses}\n` +
      `Last analysis: ${lastAnalysis ? new Date(lastAnalysis).toLocaleString() : 'Never'}\n` +
      `Uptime: ${(process.uptime() / 3600).toFixed(1)} hours`
    );
  });

  bot.onText(/\/settings/, async () => {
    send(
      `⚙️ *Current Settings*\n\n` +
      `Risk per trade: ${process.env.MAX_RISK_PER_TRADE || 1.5}%\n` +
      `Max open trades: ${process.env.MAX_OPEN_TRADES || 3}\n` +
      `Min confidence: ${process.env.MIN_CONFIDENCE || 72}%\n` +
      `Daily loss limit: ${process.env.DAILY_LOSS_LIMIT || 4}%\n` +
      `Weekly loss limit: ${process.env.WEEKLY_LOSS_LIMIT || 8}%\n` +
      `Pairs: ${process.env.TRADE_PAIRS || 'BTCUSDT,ETHUSDT'}\n` +
      `Analysis interval: every 4 hours\n` +
      `AI Model: Claude Fable 5 (Sonnet 4.6 fallback)`
    );
  });

  console.log('✅ Telegram bot initialized');
  return bot;
}

function send(text) {
  if (bot && chatId) {
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(err => {
      // Retry without markdown if formatting fails
      bot.sendMessage(chatId, text.replace(/[*_`]/g, '')).catch(() => {});
    });
  }
}

module.exports = { initTelegram, send };
