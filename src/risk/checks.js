'use strict';

/**
 * Pure risk checks (no DB / I/O). Used by Risk Guardian and unit tests.
 */

/**
 * @typedef {object} TradeVerdict
 * @property {string} decision
 * @property {number} confidence
 * @property {number} [entry_price]
 * @property {number} [stop_loss]
 * @property {number} [take_profit_1]
 * @property {string} [skip_reason]
 * @property {number} [position_size_multiplier]
 */

/**
 * @param {TradeVerdict} verdict
 * @param {{ minConfidence: number, minRiskReward: number }} config
 * @returns {{ approved: false, reason: string } | { approved: true, riskReward: number, sizeMultiplier: number }}
 */
function validateVerdictBasics(verdict, config) {
  if (!verdict || typeof verdict !== 'object') {
    return { approved: false, reason: 'Invalid verdict payload' };
  }

  if (!['LONG', 'SHORT'].includes(verdict.decision)) {
    return {
      approved: false,
      reason: `AI decided to SKIP: ${verdict.skip_reason || 'No clear setup'}`,
    };
  }

  const confidence = Number(verdict.confidence);
  if (!Number.isFinite(confidence) || confidence < config.minConfidence) {
    return {
      approved: false,
      reason: `Confidence ${verdict.confidence}% below minimum ${config.minConfidence}%`,
    };
  }

  const entry = Number(verdict.entry_price);
  const stopLoss = Number(verdict.stop_loss);
  const takeProfit = Number(verdict.take_profit_1);

  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) {
    return { approved: false, reason: 'Missing entry, stop loss, or take profit' };
  }

  if (entry <= 0 || stopLoss <= 0 || takeProfit <= 0) {
    return { approved: false, reason: 'Entry, stop loss, and take profit must be positive' };
  }

  const risk = Math.abs(entry - stopLoss);
  if (risk === 0) {
    return { approved: false, reason: 'Stop loss cannot equal entry price' };
  }

  const reward = Math.abs(takeProfit - entry);
  const rr = reward / risk;
  if (rr < config.minRiskReward) {
    return {
      approved: false,
      reason: `Risk/Reward ${rr.toFixed(2)} below minimum ${config.minRiskReward}`,
    };
  }

  if (verdict.decision === 'LONG' && stopLoss >= entry) {
    return { approved: false, reason: 'Invalid stop loss for LONG (must be below entry)' };
  }
  if (verdict.decision === 'SHORT' && stopLoss <= entry) {
    return { approved: false, reason: 'Invalid stop loss for SHORT (must be above entry)' };
  }

  let sizeMultiplier = Number(verdict.position_size_multiplier);
  if (!Number.isFinite(sizeMultiplier)) sizeMultiplier = 1.0;
  sizeMultiplier = Math.min(Math.max(sizeMultiplier, 0.5), 1.5);

  return { approved: true, riskReward: rr, sizeMultiplier };
}

/**
 * Position size from portfolio risk rules (pure).
 * @param {{ entry_price: number, stop_loss: number }} verdict
 * @param {number} portfolio
 * @param {number} maxRiskPercent
 * @param {number} [sizeMultiplier=1]
 * @param {number} [maxPositionFraction=0.3]
 */
function calculatePositionSizePure(
  verdict,
  portfolio,
  maxRiskPercent,
  sizeMultiplier = 1.0,
  maxPositionFraction = 0.3
) {
  const entry = Number(verdict.entry_price);
  const stopLoss = Number(verdict.stop_loss);
  const riskAmount = portfolio * (maxRiskPercent / 100) * sizeMultiplier;
  const riskPerUnit = Math.abs(entry - stopLoss);
  const units = riskAmount / riskPerUnit;
  const positionSizeUsdt = units * entry;
  const maxPosition = portfolio * maxPositionFraction;
  const finalSize = Math.min(positionSizeUsdt, maxPosition);

  return {
    sizeUsdt: parseFloat(finalSize.toFixed(2)),
    riskUsdt: parseFloat(riskAmount.toFixed(2)),
    units: parseFloat((finalSize / entry).toFixed(6)),
  };
}

module.exports = { validateVerdictBasics, calculatePositionSizePure };
