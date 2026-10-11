'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateVerdictBasics, calculatePositionSizePure } = require('../src/risk/checks');

const CONFIG = { minConfidence: 55, minRiskReward: 1.5 };

describe('validateVerdictBasics', () => {
  it('approves a valid LONG with sufficient R/R', () => {
    const result = validateVerdictBasics(
      {
        decision: 'LONG',
        confidence: 70,
        entry_price: 100,
        stop_loss: 95,
        take_profit_1: 110,
        position_size_multiplier: 1,
      },
      CONFIG
    );

    assert.equal(result.approved, true);
    assert.ok(result.riskReward >= 1.5);
    assert.equal(result.sizeMultiplier, 1);
  });

  it('rejects SKIP decisions', () => {
    const result = validateVerdictBasics(
      { decision: 'SKIP', confidence: 90, skip_reason: 'No setup' },
      CONFIG
    );
    assert.equal(result.approved, false);
    assert.match(result.reason, /SKIP|No setup/i);
  });

  it('rejects low confidence', () => {
    const result = validateVerdictBasics(
      {
        decision: 'LONG',
        confidence: 40,
        entry_price: 100,
        stop_loss: 95,
        take_profit_1: 110,
      },
      CONFIG
    );
    assert.equal(result.approved, false);
    assert.match(result.reason, /Confidence/);
  });

  it('rejects poor risk/reward', () => {
    const result = validateVerdictBasics(
      {
        decision: 'LONG',
        confidence: 80,
        entry_price: 100,
        stop_loss: 90,
        take_profit_1: 105, // R/R = 0.5
      },
      CONFIG
    );
    assert.equal(result.approved, false);
    assert.match(result.reason, /Risk\/Reward/);
  });

  it('rejects invalid LONG stop loss', () => {
    const result = validateVerdictBasics(
      {
        decision: 'LONG',
        confidence: 80,
        entry_price: 100,
        stop_loss: 105,
        take_profit_1: 120,
      },
      CONFIG
    );
    assert.equal(result.approved, false);
    assert.match(result.reason, /stop loss/i);
  });

  it('clamps position size multiplier between 0.5 and 1.5', () => {
    const high = validateVerdictBasics(
      {
        decision: 'SHORT',
        confidence: 80,
        entry_price: 100,
        stop_loss: 105,
        take_profit_1: 90,
        position_size_multiplier: 3,
      },
      CONFIG
    );
    assert.equal(high.approved, true);
    assert.equal(high.sizeMultiplier, 1.5);
  });
});

describe('calculatePositionSizePure', () => {
  it('sizes position from risk percent and stop distance', () => {
    const size = calculatePositionSizePure({ entry_price: 100, stop_loss: 95 }, 1000, 1.5, 1.0);
    // Risk $15 on $5 stop → 3 units → $300 notional
    assert.equal(size.riskUsdt, 15);
    assert.equal(size.sizeUsdt, 300);
    assert.equal(size.units, 3);
  });

  it('caps position at 30% of portfolio', () => {
    const size = calculatePositionSizePure({ entry_price: 100, stop_loss: 99.5 }, 1000, 1.5, 1.0);
    assert.equal(size.sizeUsdt, 300); // 30% cap
  });
});
