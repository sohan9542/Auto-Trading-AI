// src/riskGuardian.js - Hard risk rules the AI can never bypass

const { query, getSetting, setSetting } = require('../database/db');
const { validateVerdictBasics, calculatePositionSizePure } = require('./risk/checks');

const CONFIG = {
  maxRiskPerTrade: parseFloat(process.env.MAX_RISK_PER_TRADE || 1.5), // % of portfolio
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES || 3, 10),
  minConfidence: parseInt(process.env.MIN_CONFIDENCE || 55, 10),
  dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT || 4), // %
  weeklyLossLimit: parseFloat(process.env.WEEKLY_LOSS_LIMIT || 8), // %
  minRiskReward: 1.5,
  reduceAfterLosses: 3, // consecutive losses → cut size 50%
  pauseAfterLosses: 5, // consecutive losses → pause everything
};

/**
 * Validate a trade signal against ALL risk rules.
 * @returns {Promise<{ approved: boolean, reason: string, sizeMultiplier?: number, riskReward?: number, notes?: string[], critical?: boolean }>}
 */
async function validateTrade(verdict, pair) {
  const checks = [];

  const isPaused = await getSetting('is_paused');
  if (isPaused === 'true') {
    return { approved: false, reason: 'Bot is paused' };
  }

  const basic = validateVerdictBasics(verdict, {
    minConfidence: CONFIG.minConfidence,
    minRiskReward: CONFIG.minRiskReward,
  });
  if (!basic.approved) {
    return { approved: false, reason: basic.reason };
  }

  let sizeMultiplier = basic.sizeMultiplier;
  const rr = basic.riskReward;

  const openTrades = await query("SELECT COUNT(*) FROM trades WHERE status = 'open'");
  const openCount = parseInt(openTrades.rows[0].count, 10);
  if (openCount >= CONFIG.maxOpenTrades) {
    return { approved: false, reason: `Already at max ${CONFIG.maxOpenTrades} open trades` };
  }

  const samePair = await query("SELECT COUNT(*) FROM trades WHERE status = 'open' AND pair = $1", [
    pair,
  ]);
  if (parseInt(samePair.rows[0].count, 10) > 0) {
    return { approved: false, reason: `Already have an open trade on ${pair}` };
  }

  const portfolio = parseFloat(await getSetting('current_portfolio'));
  const dailyLoss = parseFloat((await getSetting('daily_loss_today')) || 0);
  const dailyLossPercent = (dailyLoss / portfolio) * 100;
  if (dailyLossPercent >= CONFIG.dailyLossLimit) {
    await setSetting('is_paused', 'true');
    return {
      approved: false,
      reason: `🛑 DAILY LOSS LIMIT HIT (${dailyLossPercent.toFixed(1)}%). Bot auto-paused. Use /resume tomorrow.`,
      critical: true,
    };
  }

  const weeklyLoss = parseFloat((await getSetting('weekly_loss_this_week')) || 0);
  const weeklyLossPercent = (weeklyLoss / portfolio) * 100;
  if (weeklyLossPercent >= CONFIG.weeklyLossLimit) {
    await setSetting('is_paused', 'true');
    return {
      approved: false,
      reason: `🛑 WEEKLY LOSS LIMIT HIT (${weeklyLossPercent.toFixed(1)}%). Bot auto-paused.`,
      critical: true,
    };
  }

  const consecutiveLosses = parseInt((await getSetting('consecutive_losses')) || 0, 10);

  if (consecutiveLosses >= CONFIG.pauseAfterLosses) {
    await setSetting('is_paused', 'true');
    return {
      approved: false,
      reason: `🛑 ${consecutiveLosses} CONSECUTIVE LOSSES. Bot auto-paused for safety. Review with /report then /resume.`,
      critical: true,
    };
  }
  if (consecutiveLosses >= CONFIG.reduceAfterLosses) {
    sizeMultiplier *= 0.5;
    checks.push(`⚠️ Size reduced 50% (${consecutiveLosses} consecutive losses)`);
  }

  return {
    approved: true,
    reason: 'All risk checks passed',
    sizeMultiplier,
    riskReward: rr,
    notes: checks,
  };
}

async function calculatePositionSize(verdict, sizeMultiplier = 1.0) {
  const portfolio = parseFloat(await getSetting('current_portfolio'));
  return calculatePositionSizePure(verdict, portfolio, CONFIG.maxRiskPerTrade, sizeMultiplier);
}

async function recordTradeOutcome(pnlUsdt) {
  if (pnlUsdt < 0) {
    const dailyLoss = parseFloat((await getSetting('daily_loss_today')) || 0);
    const weeklyLoss = parseFloat((await getSetting('weekly_loss_this_week')) || 0);
    await setSetting('daily_loss_today', String(dailyLoss + Math.abs(pnlUsdt)));
    await setSetting('weekly_loss_this_week', String(weeklyLoss + Math.abs(pnlUsdt)));

    const losses = parseInt((await getSetting('consecutive_losses')) || 0, 10);
    await setSetting('consecutive_losses', String(losses + 1));
  } else {
    await setSetting('consecutive_losses', '0');
  }

  const portfolio = parseFloat(await getSetting('current_portfolio'));
  await setSetting('current_portfolio', String(portfolio + pnlUsdt));
}

async function resetDailyCounters() {
  await setSetting('daily_loss_today', '0');
}

async function resetWeeklyCounters() {
  await setSetting('weekly_loss_this_week', '0');
}

module.exports = {
  validateTrade,
  calculatePositionSize,
  recordTradeOutcome,
  resetDailyCounters,
  resetWeeklyCounters,
  CONFIG,
};
