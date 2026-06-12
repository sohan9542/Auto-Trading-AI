#!/usr/bin/env node
// scripts/backtest.js — Walk-forward backtester for RSI+EMA and Grid strategies
//
// Usage:
//   node scripts/backtest.js [options]
//
// RSI+EMA options:
//   --strategy=rsiEma   (default)
//   --pair=BTCUSDT      (default)
//   --interval=4h       (default)  any Binance interval: 1h 4h 1d ...
//   --days=90           (default)
//   --capital=10000     starting portfolio in USDT
//   --riskPct=1.5       % of portfolio to risk per trade
//   --emaFast=9
//   --emaSlow=21
//   --emaTrend=200
//   --slAtrMult=2.0
//   --tp1Rr=1.5         reward multiple at TP1 (half position closed here)
//   --tp2Rr=3.0         reward multiple at TP2 (rest closed here)
//
// Grid options:
//   --strategy=grid
//   --pair=BTCUSDT
//   --interval=1h       candle interval for simulation granularity
//   --days=90
//   --lower=95000       grid lower bound
//   --upper=110000      grid upper bound
//   --spacing=1.0       % between grid levels (geometric)
//   --gridCapital=5000  USDT allocated to the grid
//
// Examples:
//   node scripts/backtest.js
//   node scripts/backtest.js --strategy=rsiEma --pair=ETHUSDT --interval=4h --days=180
//   node scripts/backtest.js --strategy=grid --lower=95000 --upper=115000 --spacing=1.0 --days=90

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const { detectSignal, DEFAULT_CONFIG } = require('../src/strategies/rsiEma');

const BINANCE_BASE = 'https://data-api.binance.vision/api/v3';

// ─── CLI ARGS ───────────────────────────────────────────────────────────────

function parseArgs() {
  const raw = {};
  process.argv.slice(2).forEach(arg => {
    const [k, v] = arg.replace(/^--/, '').split('=');
    raw[k] = v;
  });

  return {
    strategy:    raw.strategy    || 'rsiEma',
    pair:        raw.pair        || 'BTCUSDT',
    interval:    raw.interval    || '4h',
    days:        parseInt(raw.days    || 90),
    capital:     parseFloat(raw.capital  || 10000),
    riskPct:     parseFloat(raw.riskPct  || 1.5),

    // RSI+EMA params (fall back to strategy defaults)
    emaFast:     parseInt(raw.emaFast    || DEFAULT_CONFIG.emaFast),
    emaSlow:     parseInt(raw.emaSlow    || DEFAULT_CONFIG.emaSlow),
    emaTrend:    parseInt(raw.emaTrend   || DEFAULT_CONFIG.emaTrend),
    slAtrMult:   parseFloat(raw.slAtrMult  || DEFAULT_CONFIG.slAtrMult),
    tp1Rr:       parseFloat(raw.tp1Rr      || DEFAULT_CONFIG.tp1Rr),
    tp2Rr:       parseFloat(raw.tp2Rr      || DEFAULT_CONFIG.tp2Rr),
    tp1Split:    parseFloat(raw.tp1Split   || DEFAULT_CONFIG.tp1Split),

    // Grid params
    lower:       parseFloat(raw.lower       || 0),
    upper:       parseFloat(raw.upper       || 0),
    spacing:     parseFloat(raw.spacing     || 1.0),
    gridCapital: parseFloat(raw.gridCapital || 5000),
  };
}

// ─── CANDLE FETCHER (with pagination) ───────────────────────────────────────

const INTERVAL_MS = {
  '1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,
  '1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,
  '8h':28800000,'12h':43200000,'1d':86400000,'3d':259200000,'1w':604800000,
};

async function fetchCandles(pair, interval, days, warmupCandles = 220) {
  const msPerBar = INTERVAL_MS[interval];
  if (!msPerBar) throw new Error(`Unknown interval "${interval}". Valid: ${Object.keys(INTERVAL_MS).join(', ')}`);

  const endTime   = Date.now();
  const startTime = endTime - days * 86400000 - warmupCandles * msPerBar;

  console.log(`\n📡 Fetching ${pair} ${interval} candles from ${new Date(startTime).toLocaleDateString()} …`);

  const all = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const { data } = await axios.get(`${BINANCE_BASE}/klines`, {
      params: { symbol: pair, interval, startTime: cursor, limit: 1000 },
      timeout: 20000,
    });

    if (!data.length) break;

    const batch = data.map(c => ({
      time:   c[0],
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));

    all.push(...batch);
    cursor = batch[batch.length - 1].time + msPerBar;
    if (data.length < 1000) break;
    await new Promise(r => setTimeout(r, 150)); // respect rate limits
  }

  console.log(`✅ ${all.length} candles loaded (${new Date(all[0].time).toLocaleDateString()} → ${new Date(all[all.length-1].time).toLocaleDateString()})`);
  return all;
}

// ─── RSI+EMA BACKTEST ────────────────────────────────────────────────────────

function backtestRsiEma(candles, cfg) {
  const sigCfg = {
    emaFast: cfg.emaFast, emaSlow: cfg.emaSlow, emaTrend: cfg.emaTrend,
    slAtrMult: cfg.slAtrMult, tp1Rr: cfg.tp1Rr, tp2Rr: cfg.tp2Rr,
    tp1Split: cfg.tp1Split,
    rsiLongMin: 40, rsiLongMax: 65, rsiShortMin: 35, rsiShortMax: 60,
  };

  const warmup = cfg.emaTrend + 20;
  const trades  = [];
  const equity  = [cfg.capital];
  let portfolio = cfg.capital;
  let open      = null;   // current open trade
  let tradeId   = 0;

  for (let i = warmup; i < candles.length; i++) {
    const bar = candles[i];

    // ── Manage open trade ──────────────────────────────────────────────────
    if (open) {
      const { dir, entry, sl, tp1, tp2, fullSize, halfSize, state, partialPnl } = open;
      const isLong = dir === 'LONG';

      const slHit  = isLong ? bar.low  <= sl  : bar.high >= sl;
      const tp1Hit = isLong ? bar.high >= tp1 : bar.low  <= tp1;
      const tp2Hit = isLong ? bar.high >= tp2 : bar.low  <= tp2;

      // Conservative: if SL + TP1 hit in same candle → assume SL
      if (slHit && tp1Hit) {
        const exitPx = (isLong ? bar.open <= sl : bar.open >= sl) ? bar.open : sl;
        const pnl    = calcPnl(dir, entry, exitPx, state === 'half' ? halfSize : fullSize);
        portfolio   += partialPnl + pnl;
        trades.push(closeRecord(open, exitPx, bar.time, partialPnl + pnl, 'stop_loss'));
        open = null;

      } else if (tp2Hit) {
        const size   = state === 'half' ? halfSize : fullSize;
        const tp2Pnl = calcPnl(dir, entry, tp2, size);
        // If we haven't taken TP1 yet, also account for TP1 portion
        let total = tp2Pnl;
        if (state === 'full') {
          // tp1 portion + tp2 portion (both at TP2 fill, optimistic for full run)
          const tp1Pnl = calcPnl(dir, entry, tp2, fullSize * cfg.tp1Split);
          total = tp1Pnl + calcPnl(dir, entry, tp2, halfSize);
        }
        portfolio += partialPnl + total;
        trades.push(closeRecord(open, tp2, bar.time, partialPnl + total, 'take_profit_2'));
        open = null;

      } else if (tp1Hit && state === 'full') {
        // Partial close: lock in TP1 profit on first half, move SL to breakeven
        const tp1Pnl = calcPnl(dir, entry, tp1, fullSize * cfg.tp1Split);
        portfolio   += tp1Pnl;
        open = { ...open, state: 'half', halfSize: fullSize * (1 - cfg.tp1Split), sl: entry, partialPnl: tp1Pnl };

      } else if (slHit) {
        const exitPx = (isLong ? bar.open <= sl : bar.open >= sl) ? bar.open : sl;
        const size   = state === 'half' ? halfSize : fullSize;
        const pnl    = calcPnl(dir, entry, exitPx, size);
        portfolio   += partialPnl + pnl;
        const label  = state === 'half' ? 'breakeven' : 'stop_loss';
        trades.push(closeRecord(open, exitPx, bar.time, partialPnl + pnl, label));
        open = null;
      }
    }

    equity.push(portfolio);

    // ── Look for new signal (only when flat) ──────────────────────────────
    if (!open) {
      const sig = detectSignal(candles.slice(0, i + 1), sigCfg);

      if (sig.signal) {
        const riskAmt  = portfolio * (cfg.riskPct / 100);
        const riskDist = Math.abs(sig.entry - sig.stopLoss);
        if (riskDist <= 0) continue;

        const units    = riskAmt / riskDist;
        const sizeUsdt = units * sig.entry;

        open = {
          id:         ++tradeId,
          dir:        sig.signal,
          entry:      sig.entry,
          sl:         sig.stopLoss,
          tp1:        sig.tp1,
          tp2:        sig.tp2,
          fullSize:   sizeUsdt,
          halfSize:   sizeUsdt * (1 - cfg.tp1Split),
          state:      'full',
          partialPnl: 0,
          entryTime:  bar.time,
          rsi:        sig.rsi,
          confidence: sig.confidence,
          reason:     sig.reason,
        };
      }
    }
  }

  // Force-close any remaining trade at last bar
  if (open) {
    const last   = candles[candles.length - 1];
    const size   = open.state === 'half' ? open.halfSize : open.fullSize;
    const pnl    = calcPnl(open.dir, open.entry, last.close, size);
    portfolio   += open.partialPnl + pnl;
    trades.push(closeRecord(open, last.close, last.time, open.partialPnl + pnl, 'end_of_backtest'));
    equity.push(portfolio);
  }

  return { trades, equity, finalPortfolio: portfolio };
}

function calcPnl(dir, entry, exit, size) {
  return dir === 'LONG'
    ? (exit - entry) / entry * size
    : (entry - exit) / entry * size;
}

function closeRecord(open, exitPx, exitTime, totalPnl, reason) {
  return {
    id: open.id, direction: open.dir,
    entryTime: open.entryTime, exitTime,
    entry: open.entry, exit: exitPx,
    sl: open.sl, tp1: open.tp1, tp2: open.tp2,
    pnl: +totalPnl.toFixed(2), reason,
    rsi: open.rsi, confidence: open.confidence,
  };
}

// ─── GRID BACKTEST ───────────────────────────────────────────────────────────

function backtestGrid(candles, cfg) {
  const { lower, upper, spacing, gridCapital } = cfg;

  if (!lower || !upper || lower >= upper) {
    throw new Error('Grid backtest needs --lower and --upper (lower < upper)');
  }

  // Build geometric grid levels
  const levels = [];
  let lvl = lower;
  while (lvl <= upper * 1.0001) {
    levels.push(+lvl.toFixed(8));
    lvl *= (1 + spacing / 100);
  }

  if (levels.length < 2) throw new Error('Grid needs at least 2 levels. Lower spacing % or widen range.');

  const capPerLevel = gridCapital / (levels.length - 1);
  const positions   = {};   // buyLevel → { units, buyPrice }
  const fills       = [];
  let gridProfit    = 0;
  let totalCycles   = 0;
  let emergencyStopped = false;

  console.log(`\n🕸️  Grid: ${levels.length} levels | $${lower} → $${upper} | ${spacing}% spacing`);
  console.log(`   Capital/level: $${capPerLevel.toFixed(2)} | Total: $${gridCapital}`);

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];

    // Emergency stop: price 3% below grid floor
    if (bar.low < lower * 0.97) {
      for (const [lvl, pos] of Object.entries(positions)) {
        const loss = pos.units * (bar.low - pos.buyPrice);
        gridProfit += loss;
        fills.push({ type: 'emergency_sell', price: +bar.low.toFixed(2), level: +lvl, profit: +loss.toFixed(2), time: bar.time });
        delete positions[lvl];
      }
      emergencyStopped = true;
      console.log(`⚠️  Emergency stop triggered at candle ${i} (price $${bar.low.toFixed(0)} < floor $${(lower*0.97).toFixed(0)})`);
      break;
    }

    // Walk through each grid interval
    for (let j = 0; j < levels.length - 1; j++) {
      const buyLvl  = levels[j];
      const sellLvl = levels[j + 1];

      // BUY: candle low touched buy level and we're not already holding it
      if (!(buyLvl in positions) && bar.low <= buyLvl && bar.high >= buyLvl) {
        const units = capPerLevel / buyLvl;
        positions[buyLvl] = { units, buyPrice: buyLvl };
        fills.push({ type: 'buy', price: +buyLvl.toFixed(2), level: buyLvl, units: +units.toFixed(6), time: bar.time });
      }

      // SELL: candle high touched sell level for a position we hold at buyLvl
      if (positions[buyLvl] && bar.high >= sellLvl) {
        const pos    = positions[buyLvl];
        const profit = pos.units * (sellLvl - pos.buyPrice);
        gridProfit  += profit;
        totalCycles++;
        fills.push({ type: 'sell', price: +sellLvl.toFixed(2), level: sellLvl, profit: +profit.toFixed(2), time: bar.time });
        delete positions[buyLvl];
      }
    }
  }

  // Unrealized P&L of remaining holdings
  const lastPrice    = candles[candles.length - 1].close;
  let unrealizedPnl  = 0;
  for (const [, pos] of Object.entries(positions)) {
    unrealizedPnl += pos.units * (lastPrice - pos.buyPrice);
  }

  return {
    fills, gridProfit, unrealizedPnl, totalCycles,
    levels: levels.length,
    openPositions: Object.keys(positions).length,
    totalPnl: gridProfit + unrealizedPnl,
    roi: ((gridProfit + unrealizedPnl) / gridCapital) * 100,
    capPerLevel,
    emergencyStopped,
  };
}

// ─── METRICS ─────────────────────────────────────────────────────────────────

function calcMetrics(trades, initialCapital, equity) {
  if (!trades.length) return null;

  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl     = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin       = wins.length   ? wins.reduce((s, t)   => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss      = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const grossWin     = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss    = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  // Max drawdown
  let peak = initialCapital, maxDd = 0, maxDdPct = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = peak - e, ddPct = (dd / peak) * 100;
    if (dd > maxDd) { maxDd = dd; maxDdPct = ddPct; }
  }

  // Annualised Sharpe (on candle-bar returns)
  const returns    = equity.slice(1).map((e, i) => equity[i] > 0 ? (e - equity[i]) / equity[i] : 0);
  const avgRet     = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
  const variance   = returns.reduce((s, r) => s + (r - avgRet) ** 2, 0) / (returns.length || 1);
  const stdRet     = Math.sqrt(variance);
  const barsPerYear = 365 * 24 * 3600000 / (
    equity.length > 1 ? (Date.now() - Date.now()) || 1 : 1
  ); // rough; Sharpe is directionally useful even if not exact
  const sharpe     = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(365) : 0;

  // Max consecutive losses
  let maxConsec = 0, curConsec = 0;
  for (const t of trades) {
    if (t.pnl <= 0) { curConsec++; if (curConsec > maxConsec) maxConsec = curConsec; }
    else curConsec = 0;
  }

  // Close reason breakdown
  const reasons = {};
  for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;

  return {
    totalTrades:    trades.length,
    wins:           wins.length,
    losses:         losses.length,
    winRate:        +(wins.length / trades.length * 100).toFixed(1),
    totalPnl:       +totalPnl.toFixed(2),
    totalPnlPct:    +(totalPnl / initialCapital * 100).toFixed(2),
    avgWin:         +avgWin.toFixed(2),
    avgLoss:        +avgLoss.toFixed(2),
    profitFactor:   isFinite(profitFactor) ? +profitFactor.toFixed(2) : 'Inf',
    maxDrawdown:    +maxDd.toFixed(2),
    maxDrawdownPct: +maxDdPct.toFixed(2),
    sharpeRatio:    +sharpe.toFixed(2),
    maxConsecLosses: maxConsec,
    finalPortfolio: +(initialCapital + totalPnl).toFixed(2),
    closeReasons:   reasons,
  };
}

// ─── OUTPUT ──────────────────────────────────────────────────────────────────

function printMetrics(m, cfg) {
  const bar = '─'.repeat(50);
  console.log(`\n${bar}`);
  console.log('  RSI+EMA BACKTEST RESULTS');
  console.log(bar);
  console.log(`  Pair/Interval : ${cfg.pair} ${cfg.interval}`);
  console.log(`  Period        : ${cfg.days} days`);
  console.log(`  Parameters    : EMA${cfg.emaFast}/${cfg.emaSlow}/${cfg.emaTrend} | SL=${cfg.slAtrMult}×ATR | TP1=${cfg.tp1Rr}R | TP2=${cfg.tp2Rr}R`);
  console.log(`  Risk/trade    : ${cfg.riskPct}% | Starting capital: $${cfg.capital.toFixed(0)}`);
  console.log(bar);
  console.log(`  Total trades  : ${m.totalTrades}  (${m.wins}W / ${m.losses}L)`);
  console.log(`  Win rate      : ${m.winRate}%`);
  console.log(`  Total P&L     : $${m.totalPnl} (${m.totalPnlPct}%)`);
  console.log(`  Avg win/loss  : +$${m.avgWin} / -$${Math.abs(m.avgLoss)}`);
  console.log(`  Profit factor : ${m.profitFactor}`);
  console.log(`  Max drawdown  : $${m.maxDrawdown} (${m.maxDrawdownPct}%)`);
  console.log(`  Sharpe ratio  : ${m.sharpeRatio}`);
  console.log(`  Max consec. L : ${m.maxConsecLosses}`);
  console.log(`  Final equity  : $${m.finalPortfolio}`);
  console.log(`  Exit reasons  : ${Object.entries(m.closeReasons).map(([k,v]) => `${k}:${v}`).join(' | ')}`);
  console.log(bar);
}

function saveResults(trades, metrics, cfg) {
  const dir = path.join(__dirname, '../backtest_results');
  fs.mkdirSync(dir, { recursive: true });

  const ts     = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix = `${cfg.strategy}_${cfg.pair}_${cfg.interval}_${ts}`;

  // Trades CSV
  const header = 'id,direction,entry_time,exit_time,entry,exit,sl,tp1,tp2,pnl,reason,rsi,confidence\n';
  const rows   = trades.map(t =>
    [t.id, t.direction,
     new Date(t.entryTime).toISOString(), new Date(t.exitTime).toISOString(),
     t.entry, t.exit, t.sl, t.tp1, t.tp2,
     t.pnl, t.reason, t.rsi?.toFixed(1) ?? '', t.confidence ?? ''].join(',')
  ).join('\n');
  const tradesFile = path.join(dir, `${prefix}_trades.csv`);
  fs.writeFileSync(tradesFile, header + rows);

  // Summary JSON
  const summaryFile = path.join(dir, `${prefix}_summary.json`);
  fs.writeFileSync(summaryFile, JSON.stringify({ config: cfg, metrics }, null, 2));

  console.log(`\n💾 Saved:`);
  console.log(`   ${tradesFile}`);
  console.log(`   ${summaryFile}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = parseArgs();

  console.log('\n╔══════════════════════════════╗');
  console.log('║      BACKTEST ENGINE  📈      ║');
  console.log('╚══════════════════════════════╝');

  try {
    if (cfg.strategy === 'grid') {
      // Grid uses finer granularity for better simulation
      const interval = cfg.interval === '4h' ? '1h' : cfg.interval;
      const candles  = await fetchCandles(cfg.pair, interval, cfg.days, 0);
      const result   = backtestGrid(candles, cfg);
      const bar      = '─'.repeat(50);

      console.log(`\n${bar}`);
      console.log('  GRID BACKTEST RESULTS');
      console.log(bar);
      console.log(`  Pair          : ${cfg.pair} (${interval} candles)`);
      console.log(`  Range         : $${cfg.lower.toLocaleString()} → $${cfg.upper.toLocaleString()}`);
      console.log(`  Spacing       : ${cfg.spacing}% (geometric)`);
      console.log(`  Grid levels   : ${result.levels}`);
      console.log(`  Capital/level : $${result.capPerLevel.toFixed(2)} | Total: $${cfg.gridCapital}`);
      console.log(bar);
      console.log(`  Completed cycles  : ${result.totalCycles}`);
      console.log(`  Realized profit   : $${result.gridProfit.toFixed(2)}`);
      console.log(`  Unrealized P&L    : $${result.unrealizedPnl.toFixed(2)}`);
      console.log(`  Total P&L         : $${result.totalPnl.toFixed(2)}`);
      console.log(`  ROI on grid cap   : ${result.roi.toFixed(2)}%`);
      console.log(`  Open positions    : ${result.openPositions}`);
      if (result.emergencyStopped) console.log(`  ⚠️  Emergency stop was triggered!`);
      console.log(bar);

      // Save grid fills to CSV
      const dir    = path.join(__dirname, '../backtest_results');
      fs.mkdirSync(dir, { recursive: true });
      const ts     = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file   = path.join(dir, `grid_${cfg.pair}_${ts}_fills.csv`);
      const header = 'type,time,level,price,profit\n';
      const rows   = result.fills.map(f =>
        `${f.type},${new Date(f.time).toISOString()},${f.level},${f.price},${f.profit ?? ''}`
      ).join('\n');
      fs.writeFileSync(file, header + rows);
      console.log(`\n💾 Fills saved to ${file}`);

    } else {
      // RSI+EMA strategy
      const candles = await fetchCandles(cfg.pair, cfg.interval, cfg.days);
      const result  = backtestRsiEma(candles, cfg);
      const metrics = calcMetrics(result.trades, cfg.capital, result.equity);

      if (!metrics) {
        console.log('\n⚠️  No trades generated. Try:');
        console.log('   - Longer --days (90+)');
        console.log('   - Different --interval (1h finds more signals than 4h)');
        console.log('   - Looser RSI filters (rsiLongMin / rsiShortMax in rsiEma.js)');
        return;
      }

      printMetrics(metrics, cfg);

      // Show last 10 trades
      if (result.trades.length > 0) {
        console.log('\n📋 Last 10 trades:');
        result.trades.slice(-10).forEach(t => {
          const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(0)}` : `-$${Math.abs(t.pnl).toFixed(0)}`;
          const date   = new Date(t.entryTime).toLocaleDateString();
          console.log(`   [${date}] ${t.direction} $${t.entry?.toFixed(0)} → $${t.exit?.toFixed(0)} | ${pnlStr} | ${t.reason}`);
        });
      }

      saveResults(result.trades, metrics, cfg);
    }
  } catch (err) {
    console.error('\n❌ Backtest error:', err.message);
    if (err.response?.data) console.error('Binance API:', JSON.stringify(err.response.data));
    process.exit(1);
  }
}

main();
