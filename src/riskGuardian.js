// src/riskGuardian.js - Hard risk rules the AI can never bypass

const { query, getSetting, setSetting } = require('../database/db');

const CONFIG = {
  maxRiskPerTrade: parseFloat(process.env.MAX_RISK_PER_TRADE || 1.5),   // % of portfolio
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES || 3),
  minConfidence: parseInt(process.env.MIN_CONFIDENCE || 72),
  dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT || 4),        // %
  weeklyLossLimit: parseFloat(process.env.WEEKLY_LOSS_LIMIT || 8),      // %
  minRiskReward: 1.5,
  reduceAfterLosses: 3,    // consecutive losses → cut size 50%
  pauseAfterLosses: 5      // consecutive losses → pause everything
};

// Validate a trade signal against ALL risk rules.
// Returns { approved: bool, reason, sizeMultiplier }
async function validateTrade(verdict, pair) {
  const checks = [];

  // 0. Bot paused?
  const isPaused = await getSetting('is_paused');
  if (isPaused === 'true') {
    return { approved: false, reason: 'Bot is paused' };
  }

  // 1. Decision must be LONG or SHORT
  if (!['LONG', 'SHORT'].includes(verdict.decision)) {
    return { approved: false, reason: `AI decided to SKIP: ${verdict.skip_reason || 'No clear setup'}` };
  }

  // 2. Confidence threshold
  if (verdict.confidence < CONFIG.minConfidence) {
    return { approved: false, reason: `Confidence ${verdict.confidence}% below minimum ${CONFIG.minConfidence}%` };
  }

  // 3. Must have valid SL/TP
  if (!verdict.entry_price || !verdict.stop_loss || !verdict.take_profit_1) {
    return { approved: false, reason: 'Missing entry, stop loss, or take profit' };
  }

  // 4. Risk/Reward check
  const risk = Math.abs(verdict.entry_price - verdict.stop_loss);
  const reward = Math.abs(verdict.take_profit_1 - verdict.entry_price);
  const rr = reward / risk;
  if (rr < CONFIG.minRiskReward) {
    return { approved: false, reason: `Risk/Reward ${rr.toFixed(2)} below minimum ${CONFIG.minRiskReward}` };
  }

  // 5. Stop loss sanity check (SL must be on the correct side)
  if (verdict.decision === 'LONG' && verdict.stop_loss >= verdict.entry_price) {
    return { approved: false, reason: 'Invalid stop loss for LONG (must be below entry)' };
  }
  if (verdict.decision === 'SHORT' && verdict.stop_loss <= verdict.entry_price) {
    return { approved: false, reason: 'Invalid stop loss for SHORT (must be above entry)' };
  }

  // 6. Max open trades
  const openTrades = await query("SELECT COUNT(*) FROM trades WHERE status = 'open'");
  const openCount = parseInt(openTrades.rows[0].count);
  if (openCount >= CONFIG.maxOpenTrades) {
    return { approved: false, reason: `Already at max ${CONFIG.maxOpenTrades} open trades` };
  }

  // 7. No duplicate trade on same pair
  const samePair = await query(
    "SELECT COUNT(*) FROM trades WHERE status = 'open' AND pair = $1", [pair]
  );
  if (parseInt(samePair.rows[0].count) > 0) {
    return { approved: false, reason: `Already have an open trade on ${pair}` };
  }

  // 8. Daily loss limit
  const portfolio = parseFloat(await getSetting('current_portfolio'));
  const dailyLoss = parseFloat(await getSetting('daily_loss_today') || 0);
  const dailyLossPercent = (dailyLoss / portfolio) * 100;
  if (dailyLossPercent >= CONFIG.dailyLossLimit) {
    await setSetting('is_paused', 'true');
    return {
      approved: false,
      reason: `🛑 DAILY LOSS LIMIT HIT (${dailyLossPercent.toFixed(1)}%). Bot auto-paused. Use /resume tomorrow.`,
      critical: true
    };
  }

  // 9. Weekly loss limit
  const weeklyLoss = parseFloat(await getSetting('weekly_loss_this_week') || 0);
  const weeklyLossPercent = (weeklyLoss / portfolio) * 100;
  if (weeklyLossPercent >= CONFIG.weeklyLossLimit) {
    await setSetting('is_paused', 'true');
    return {
      approved: false,
      reason: `🛑 WEEKLY LOSS LIMIT HIT (${weeklyLossPercent.toFixed(1)}%). Bot auto-paused.`,
      critical: true
    };
  }

  // 10. Consecutive loss adjustments
  const consecutiveLosses = parseInt(await getSetting('consecutive_losses') || 0);
  let sizeMultiplier = verdict.position_size_multiplier || 1.0;
  sizeMultiplier = Math.min(Math.max(sizeMultiplier, 0.5), 1.5); // clamp 0.5-1.5

  if (consecutiveLosses >= CONFIG.pauseAfterLosses) {
    await setSetting('is_paused', 'true');
    return {
      approved: false,
      reason: `🛑 ${consecutiveLosses} CONSECUTIVE LOSSES. Bot auto-paused for safety. Review with /report then /resume.`,
      critical: true
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
    notes: checks
  };
}

// Calculate position size based on risk rules
async function calculatePositionSize(verdict, sizeMultiplier = 1.0) {
  const portfolio = parseFloat(await getSetting('current_portfolio'));
  const riskAmount = portfolio * (CONFIG.maxRiskPerTrade / 100) * sizeMultiplier;
  const riskPerUnit = Math.abs(verdict.entry_price - verdict.stop_loss);
  const units = riskAmount / riskPerUnit;
  const positionSizeUsdt = units * verdict.entry_price;

  // Never exceed 30% of portfolio in one position
  const maxPosition = portfolio * 0.30;
  const finalSize = Math.min(positionSizeUsdt, maxPosition);

  return {
    sizeUsdt: parseFloat(finalSize.toFixed(2)),
    riskUsdt: parseFloat(riskAmount.toFixed(2)),
    units: parseFloat((finalSize / verdict.entry_price).toFixed(6))
  };
}

// Update loss tracking after a trade closes
async function recordTradeOutcome(pnlUsdt) {
  if (pnlUsdt < 0) {
    const dailyLoss = parseFloat(await getSetting('daily_loss_today') || 0);
    const weeklyLoss = parseFloat(await getSetting('weekly_loss_this_week') || 0);
    await setSetting('daily_loss_today', String(dailyLoss + Math.abs(pnlUsdt)));
    await setSetting('weekly_loss_this_week', String(weeklyLoss + Math.abs(pnlUsdt)));

    const losses = parseInt(await getSetting('consecutive_losses') || 0);
    await setSetting('consecutive_losses', String(losses + 1));
  } else {
    await setSetting('consecutive_losses', '0');
  }

  // Update portfolio value
  const portfolio = parseFloat(await getSetting('current_portfolio'));
  await setSetting('current_portfolio', String(portfolio + pnlUsdt));
}

// Reset daily counter (call at midnight)
async function resetDailyCounters() {
  await setSetting('daily_loss_today', '0');
}

// Reset weekly counter (call Monday midnight)
async function resetWeeklyCounters() {
  await setSetting('weekly_loss_this_week', '0');
}

module.exports = {
  validateTrade, calculatePositionSize, recordTradeOutcome,
  resetDailyCounters, resetWeeklyCounters, CONFIG
};
