// src/gridBot.js - Grid trading: arithmetic (fixed levels) + geometric (% spacing)

const { query, getSetting, logError } = require('../database/db');
const { getCurrentPrice, getCandles } = require('./marketData');
const { ATR, BollingerBands } = require('technicalindicators');

// Initialize grid tables
async function initGridTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS grid_configs (
      id SERIAL PRIMARY KEY,
      pair VARCHAR(20) NOT NULL,
      lower_price DECIMAL(20,8) NOT NULL,
      upper_price DECIMAL(20,8) NOT NULL,
      levels INTEGER NOT NULL,
      spacing_percent DECIMAL(10,4),           -- set for geometric grids
      grid_type VARCHAR(20) DEFAULT 'arithmetic',
      total_capital DECIMAL(20,2) NOT NULL,
      capital_per_level DECIMAL(20,2) NOT NULL,
      status VARCHAR(20) DEFAULT 'active',     -- active, paused, stopped
      pause_reason VARCHAR(100),
      total_profit DECIMAL(20,2) DEFAULT 0,
      completed_cycles INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      stopped_at TIMESTAMP
    );

    -- Add spacing_percent column to existing tables (safe no-op if already exists)
    ALTER TABLE grid_configs ADD COLUMN IF NOT EXISTS spacing_percent DECIMAL(10,4);
    ALTER TABLE grid_configs ADD COLUMN IF NOT EXISTS grid_type VARCHAR(20) DEFAULT 'arithmetic';

    CREATE TABLE IF NOT EXISTS grid_fills (
      id SERIAL PRIMARY KEY,
      grid_id INTEGER REFERENCES grid_configs(id),
      level_price DECIMAL(20,8),
      side VARCHAR(4),                          -- buy or sell
      amount_units DECIMAL(20,8),
      amount_usdt DECIMAL(20,2),
      fill_price DECIMAL(20,8),
      profit_usdt DECIMAL(20,2),               -- set on sell fills
      filled_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS grid_positions (
      id SERIAL PRIMARY KEY,
      grid_id INTEGER REFERENCES grid_configs(id),
      buy_level DECIMAL(20,8),
      sell_level DECIMAL(20,8),
      units DECIMAL(20,8),
      buy_price DECIMAL(20,8),
      status VARCHAR(20) DEFAULT 'holding',    -- holding (bought, waiting to sell), sold
      bought_at TIMESTAMP DEFAULT NOW(),
      sold_at TIMESTAMP
    );
  `);
  console.log('✅ Grid tables initialized');
}

// Start a new grid
async function startGrid(pair, lowerPrice, upperPrice, levels, capitalUsdt) {
  // Validations
  const portfolio = parseFloat(await getSetting('current_portfolio'));
  const maxAllocation = portfolio * 0.30;

  if (capitalUsdt > maxAllocation) {
    return { success: false, error: `Grid capital $${capitalUsdt} exceeds 30% of portfolio (max $${maxAllocation.toFixed(2)})` };
  }
  if (lowerPrice >= upperPrice) {
    return { success: false, error: 'Lower price must be below upper price' };
  }
  if (levels < 4 || levels > 30) {
    return { success: false, error: 'Levels must be between 4 and 30' };
  }

  const currentPrice = await getCurrentPrice(pair);
  if (currentPrice < lowerPrice || currentPrice > upperPrice) {
    return { success: false, error: `Current price $${currentPrice} is outside your range $${lowerPrice}-$${upperPrice}. Set a range around the current price.` };
  }

  // Check no existing active grid on this pair
  const existing = await query(
    "SELECT id FROM grid_configs WHERE pair = $1 AND status IN ('active','paused')", [pair]
  );
  if (existing.rows.length > 0) {
    return { success: false, error: `Grid already running on ${pair}. Stop it first with /gridstop ${pair}` };
  }

  const capitalPerLevel = capitalUsdt / levels;

  const result = await query(`
    INSERT INTO grid_configs (pair, lower_price, upper_price, levels, total_capital, capital_per_level)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
  `, [pair, lowerPrice, upperPrice, levels, capitalUsdt, capitalPerLevel]);

  const gridId = result.rows[0].id;
  const step = (upperPrice - lowerPrice) / levels;

  return {
    success: true,
    gridId,
    pair,
    range: `$${lowerPrice} - $${upperPrice}`,
    levels,
    step: step.toFixed(2),
    capitalPerLevel: capitalPerLevel.toFixed(2),
    currentPrice,
    profitPerCycle: ((step / lowerPrice) * 100).toFixed(2) + '%'
  };
}

// Start a geometric (percentage-spaced) grid — more natural for crypto
// spacingPct: distance between levels as % (e.g. 1.0 = 1% between levels)
async function startGridPercent(pair, lowerPrice, upperPrice, spacingPct, capitalUsdt) {
  if (spacingPct <= 0.1 || spacingPct > 20) {
    return { success: false, error: 'Spacing must be between 0.1% and 20%' };
  }

  // Build geometric levels to count them
  const levels = [];
  let lvl = lowerPrice;
  while (lvl <= upperPrice * 1.0001) {
    levels.push(lvl);
    lvl *= (1 + spacingPct / 100);
  }

  if (levels.length < 3) {
    return { success: false, error: `Only ${levels.length} levels with ${spacingPct}% spacing. Widen range or reduce spacing.` };
  }

  const portfolio      = parseFloat(await getSetting('current_portfolio'));
  const maxAllocation  = portfolio * 0.30;
  if (capitalUsdt > maxAllocation) {
    return { success: false, error: `$${capitalUsdt} exceeds 30% portfolio cap ($${maxAllocation.toFixed(2)})` };
  }

  const currentPrice = await getCurrentPrice(pair);
  if (currentPrice < lowerPrice || currentPrice > upperPrice) {
    return { success: false, error: `Current price $${currentPrice} is outside range $${lowerPrice}–$${upperPrice}` };
  }

  const existing = await query(
    "SELECT id FROM grid_configs WHERE pair = $1 AND status IN ('active','paused')", [pair]
  );
  if (existing.rows.length > 0) {
    return { success: false, error: `Grid already running on ${pair}. Stop it first.` };
  }

  const capitalPerLevel = capitalUsdt / (levels.length - 1);
  const result = await query(`
    INSERT INTO grid_configs
      (pair, lower_price, upper_price, levels, spacing_percent, grid_type, total_capital, capital_per_level)
    VALUES ($1, $2, $3, $4, $5, 'geometric', $6, $7) RETURNING id
  `, [pair, lowerPrice, upperPrice, levels.length, spacingPct, capitalUsdt, capitalPerLevel]);

  const gridId     = result.rows[0].id;
  const profitPct  = ((levels[1] / levels[0] - 1) * 100).toFixed(3);

  return {
    success: true, gridId, pair,
    range:          `$${lowerPrice.toLocaleString()} – $${upperPrice.toLocaleString()}`,
    levels:         levels.length,
    spacingPct,
    capitalPerLevel: capitalPerLevel.toFixed(2),
    currentPrice,
    profitPerCycle: `${profitPct}%`,
    note: 'Geometric spacing — each level is exactly ${spacingPct}% above the previous'
  };
}

// Auto-suggest a grid range based on ATR and Bollinger Bands
async function suggestGrid(pair, spacingPct = 1.0) {
  try {
    const candles = await getCandles(pair, '1d', 30);
    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);

    const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const bbArr  = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    const atr    = atrArr[atrArr.length - 1];
    const bb     = bbArr[bbArr.length - 1];
    const price  = closes[closes.length - 1];

    // Use BB bands as natural range, padded by 0.5×ATR
    const lower = Math.max(bb.lower - atr * 0.5, price * 0.88);
    const upper = Math.min(bb.upper + atr * 0.5, price * 1.12);

    // Count levels
    let lvl = lower, count = 0;
    while (lvl <= upper * 1.0001) { count++; lvl *= (1 + spacingPct / 100); }

    return {
      pair, currentPrice: price,
      suggestedLower:  +lower.toFixed(2),
      suggestedUpper:  +upper.toFixed(2),
      levels:          count,
      spacingPct,
      atr:             +atr.toFixed(2),
      bbLower:         +bb.lower.toFixed(2),
      bbUpper:         +bb.upper.toFixed(2),
      note: `Based on 30-day Bollinger Bands + ATR. Always verify the range suits current market conditions.`
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Core grid engine - called every monitoring cycle
async function monitorGrids(notifyCallback) {
  const grids = await query("SELECT * FROM grid_configs WHERE status = 'active'");

  for (const grid of grids.rows) {
    try {
      const currentPrice = await getCurrentPrice(grid.pair);
      const lower       = parseFloat(grid.lower_price);
      const upper       = parseFloat(grid.upper_price);
      const capPerLevel = parseFloat(grid.capital_per_level);
      const isGeometric = grid.grid_type === 'geometric' && grid.spacing_percent;

      // SAFETY: hard floor - price broke below grid
      if (currentPrice < lower * 0.97) {
        await emergencyStopGrid(grid, currentPrice, notifyCallback);
        continue;
      }

      // Build level prices (arithmetic or geometric)
      const levelPrices = [];
      if (isGeometric) {
        const spacingPct = parseFloat(grid.spacing_percent);
        let lvl = lower;
        while (lvl <= upper * 1.0001) {
          levelPrices.push(lvl);
          lvl *= (1 + spacingPct / 100);
        }
      } else {
        const step = (upper - lower) / grid.levels;
        for (let i = 0; i <= grid.levels; i++) levelPrices.push(lower + step * i);
      }

      // Get current holdings for this grid
      const holdings = await query(
        "SELECT * FROM grid_positions WHERE grid_id = $1 AND status = 'holding'", [grid.id]
      );
      const heldBuyLevels = holdings.rows.map(h => parseFloat(h.buy_level));

      // BUY logic: if price is at/below a level and we don't hold that level yet
      for (let i = 0; i < levelPrices.length - 1; i++) {
        const buyLevel = levelPrices[i];
        const sellLevel = levelPrices[i + 1];

        const alreadyHolding = heldBuyLevels.some(h => Math.abs(h - buyLevel) < step * 0.1);

        if (!alreadyHolding && currentPrice <= buyLevel && currentPrice > buyLevel - step) {
          // BUY this level
          const units = capPerLevel / currentPrice;
          await query(`
            INSERT INTO grid_positions (grid_id, buy_level, sell_level, units, buy_price)
            VALUES ($1, $2, $3, $4, $5)
          `, [grid.id, buyLevel, sellLevel, units, currentPrice]);

          await query(`
            INSERT INTO grid_fills (grid_id, level_price, side, amount_units, amount_usdt, fill_price)
            VALUES ($1, $2, 'buy', $3, $4, $5)
          `, [grid.id, buyLevel, units, capPerLevel, currentPrice]);

          if (notifyCallback) {
            notifyCallback(
              `🕸️ Grid BUY — ${grid.pair}\n` +
              `Bought $${capPerLevel.toFixed(2)} @ $${currentPrice.toFixed(2)}\n` +
              `Will sell at $${sellLevel.toFixed(2)} (+${((sellLevel - currentPrice) / currentPrice * 100).toFixed(2)}%)`
            );
          }
        }
      }

      // SELL logic: if price reached the sell level of any holding
      for (const pos of holdings.rows) {
        const sellLevel = parseFloat(pos.sell_level);
        if (currentPrice >= sellLevel) {
          const units = parseFloat(pos.units);
          const buyPrice = parseFloat(pos.buy_price);
          const profit = units * (currentPrice - buyPrice);

          await query(
            "UPDATE grid_positions SET status = 'sold', sold_at = NOW() WHERE id = $1", [pos.id]
          );
          await query(`
            INSERT INTO grid_fills (grid_id, level_price, side, amount_units, amount_usdt, fill_price, profit_usdt)
            VALUES ($1, $2, 'sell', $3, $4, $5, $6)
          `, [grid.id, sellLevel, units, units * currentPrice, currentPrice, profit]);

          await query(`
            UPDATE grid_configs SET 
              total_profit = total_profit + $1,
              completed_cycles = completed_cycles + 1
            WHERE id = $2
          `, [profit, grid.id]);

          // Add profit to portfolio
          const portfolio = parseFloat(await getSetting('current_portfolio'));
          await query(
            "UPDATE bot_settings SET value = $1 WHERE key = 'current_portfolio'",
            [String(portfolio + profit)]
          );

          if (notifyCallback) {
            notifyCallback(
              `💰 Grid SELL — ${grid.pair}\n` +
              `Sold @ $${currentPrice.toFixed(2)}\n` +
              `Cycle profit: +$${profit.toFixed(2)}\n` +
              `Grid total: +$${(parseFloat(grid.total_profit) + profit).toFixed(2)} (${grid.completed_cycles + 1} cycles)`
            );
          }
        }
      }
    } catch (err) {
      await logError('GRID_MONITOR_FAILED', err.message, `grid ${grid.id}`);
    }
  }
}

// Emergency stop: price broke below grid floor
async function emergencyStopGrid(grid, currentPrice, notifyCallback) {
  // Close all holdings at current price (realize the loss)
  const holdings = await query(
    "SELECT * FROM grid_positions WHERE grid_id = $1 AND status = 'holding'", [grid.id]
  );

  let totalLoss = 0;
  for (const pos of holdings.rows) {
    const units = parseFloat(pos.units);
    const buyPrice = parseFloat(pos.buy_price);
    const loss = units * (currentPrice - buyPrice);
    totalLoss += loss;

    await query(
      "UPDATE grid_positions SET status = 'sold', sold_at = NOW() WHERE id = $1", [pos.id]
    );
  }

  const portfolio = parseFloat(await getSetting('current_portfolio'));
  await query(
    "UPDATE bot_settings SET value = $1 WHERE key = 'current_portfolio'",
    [String(portfolio + totalLoss)]
  );

  await query(
    "UPDATE grid_configs SET status = 'stopped', pause_reason = 'price broke grid floor', stopped_at = NOW() WHERE id = $1",
    [grid.id]
  );

  if (notifyCallback) {
    notifyCallback(
      `🛑 GRID EMERGENCY STOP — ${grid.pair}\n\n` +
      `Price $${currentPrice.toFixed(2)} broke 3% below grid floor $${parseFloat(grid.lower_price).toFixed(2)}.\n` +
      `All positions closed. Realized: ${totalLoss >= 0 ? '+' : ''}$${totalLoss.toFixed(2)}\n` +
      `Grid lifetime profit was: +$${parseFloat(grid.total_profit).toFixed(2)}\n\n` +
      `This is the safety floor protecting you from a crash. Restart a grid lower when the market stabilizes.`
    );
  }
}

// AI integration: pause grids during strong trends
async function adjustGridsForTrend(pair, trend, notifyCallback) {
  if (['STRONG_UPTREND', 'STRONG_DOWNTREND'].includes(trend)) {
    const result = await query(
      "UPDATE grid_configs SET status = 'paused', pause_reason = $1 WHERE pair = $2 AND status = 'active' RETURNING id",
      [`AI detected ${trend}`, pair]
    );
    if (result.rows.length > 0 && notifyCallback) {
      notifyCallback(
        `⏸️ Grid auto-paused — ${pair}\n` +
        `AI detected ${trend}. Grids lose money in strong trends.\n` +
        `Will auto-resume when market goes back to ranging.`
      );
    }
  } else if (['SIDEWAYS', 'UPTREND', 'DOWNTREND'].includes(trend)) {
    const result = await query(
      "UPDATE grid_configs SET status = 'active', pause_reason = NULL WHERE pair = $1 AND status = 'paused' AND pause_reason LIKE 'AI detected%' RETURNING id",
      [pair]
    );
    if (result.rows.length > 0 && notifyCallback) {
      notifyCallback(`▶️ Grid auto-resumed — ${pair}\nMarket back to ranging conditions. Grid hunting again. 🕸️`);
    }
  }
}

// Stop a grid manually
async function stopGrid(pair, notifyCallback) {
  const grids = await query(
    "SELECT * FROM grid_configs WHERE pair = $1 AND status IN ('active','paused')", [pair]
  );
  if (grids.rows.length === 0) {
    return { success: false, error: `No active grid on ${pair}` };
  }

  const grid = grids.rows[0];
  const currentPrice = await getCurrentPrice(pair);

  // Close holdings at market
  const holdings = await query(
    "SELECT * FROM grid_positions WHERE grid_id = $1 AND status = 'holding'", [grid.id]
  );
  let realizedPnl = 0;
  for (const pos of holdings.rows) {
    const units = parseFloat(pos.units);
    realizedPnl += units * (currentPrice - parseFloat(pos.buy_price));
    await query("UPDATE grid_positions SET status = 'sold', sold_at = NOW() WHERE id = $1", [pos.id]);
  }

  const portfolio = parseFloat(await getSetting('current_portfolio'));
  await query(
    "UPDATE bot_settings SET value = $1 WHERE key = 'current_portfolio'",
    [String(portfolio + realizedPnl)]
  );

  await query(
    "UPDATE grid_configs SET status = 'stopped', stopped_at = NOW() WHERE id = $1", [grid.id]
  );

  return {
    success: true,
    totalProfit: parseFloat(grid.total_profit) + realizedPnl,
    cycles: grid.completed_cycles,
    finalPositionsPnl: realizedPnl
  };
}

// Grid status report
async function getGridStatus() {
  const grids = await query(
    "SELECT * FROM grid_configs WHERE status IN ('active','paused') ORDER BY created_at DESC"
  );
  const statuses = [];

  for (const grid of grids.rows) {
    const currentPrice = await getCurrentPrice(grid.pair);
    const holdings = await query(
      "SELECT COUNT(*), COALESCE(SUM(units * buy_price), 0) as invested FROM grid_positions WHERE grid_id = $1 AND status = 'holding'",
      [grid.id]
    );

    statuses.push({
      pair: grid.pair,
      status: grid.status,
      pauseReason: grid.pause_reason,
      range: `$${parseFloat(grid.lower_price).toFixed(0)} - $${parseFloat(grid.upper_price).toFixed(0)}`,
      currentPrice: currentPrice.toFixed(2),
      levels: grid.levels,
      totalProfit: parseFloat(grid.total_profit).toFixed(2),
      cycles: grid.completed_cycles,
      activeHoldings: parseInt(holdings.rows[0].count),
      investedNow: parseFloat(holdings.rows[0].invested).toFixed(2),
      runningSince: new Date(grid.created_at).toLocaleDateString()
    });
  }
  return statuses;
}

module.exports = {
  initGridTables, startGrid, startGridPercent, suggestGrid,
  monitorGrids, adjustGridsForTrend, stopGrid, getGridStatus
};
