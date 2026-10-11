'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectSignal, getState, minCandles, DEFAULT_CONFIG } = require('../src/strategies/rsiEma');

function buildCandles(count, startPrice = 100, drift = 0.05) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price += drift;
    candles.push({
      time: Date.now() + i * 14400000,
      open: price - 0.2,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 1000 + i,
    });
  }
  return candles;
}

describe('rsiEma strategy', () => {
  it('reports when there are not enough candles', () => {
    const result = detectSignal(buildCandles(10));
    assert.equal(result.signal, null);
    assert.match(result.reason, /Need/);
  });

  it('returns indicator state for sufficient candles', () => {
    const needed = minCandles(DEFAULT_CONFIG);
    const state = getState(buildCandles(needed));
    assert.ok(state);
    assert.equal(typeof state.rsi, 'number');
    assert.ok(['BULLISH', 'BEARISH'].includes(state.emaCross));
  });

  it('returns a structured response with enough warmup data', () => {
    const needed = minCandles(DEFAULT_CONFIG);
    const result = detectSignal(buildCandles(needed, 100, 0.2));
    assert.ok('signal' in result);
    assert.ok('reason' in result);
    if (result.signal) {
      assert.ok(['LONG', 'SHORT'].includes(result.signal));
      assert.ok(result.entry > 0);
      assert.ok(result.stopLoss > 0);
      assert.ok(result.tp1 > 0);
      assert.ok(result.confidence >= 55);
    }
  });
});
