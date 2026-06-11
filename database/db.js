// database/db.js - Neon PostgreSQL connection & schema

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Trades table: every trade ever made
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        trade_id VARCHAR(50) UNIQUE,
        pair VARCHAR(20) NOT NULL,
        direction VARCHAR(10) NOT NULL,        -- LONG or SHORT
        entry_price DECIMAL(20,8),
        exit_price DECIMAL(20,8),
        stop_loss DECIMAL(20,8),
        take_profit DECIMAL(20,8),
        size_usdt DECIMAL(20,2),
        risk_usdt DECIMAL(20,2),
        pnl_usdt DECIMAL(20,2),
        pnl_percent DECIMAL(10,4),
        status VARCHAR(20) DEFAULT 'open',     -- open, closed, stopped, cancelled
        close_reason VARCHAR(50),              -- take_profit, stop_loss, manual, risk_limit
        confidence INTEGER,
        ai_model VARCHAR(50),
        entry_time TIMESTAMP DEFAULT NOW(),
        exit_time TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Analysis log: every AI analysis (trade or skip)
      CREATE TABLE IF NOT EXISTS analysis_log (
        id SERIAL PRIMARY KEY,
        pair VARCHAR(20) NOT NULL,
        timeframe VARCHAR(10),
        direction VARCHAR(10),                 -- LONG, SHORT, SKIP
        confidence INTEGER,
        technical_bias VARCHAR(10),
        news_bias VARCHAR(10),
        final_decision VARCHAR(10),
        reasoning TEXT,
        technical_summary TEXT,
        news_summary TEXT,
        rsi DECIMAL(10,4),
        macd_signal VARCHAR(10),
        trend VARCHAR(20),
        fear_greed_index INTEGER,
        trade_id VARCHAR(50),                  -- linked trade if opened
        analyzed_at TIMESTAMP DEFAULT NOW()
      );

      -- Daily reports
      CREATE TABLE IF NOT EXISTS daily_reports (
        id SERIAL PRIMARY KEY,
        report_date DATE UNIQUE,
        total_trades INTEGER DEFAULT 0,
        winning_trades INTEGER DEFAULT 0,
        losing_trades INTEGER DEFAULT 0,
        win_rate DECIMAL(10,4),
        total_pnl_usdt DECIMAL(20,2) DEFAULT 0,
        total_pnl_percent DECIMAL(10,4) DEFAULT 0,
        best_trade_pnl DECIMAL(20,2),
        worst_trade_pnl DECIMAL(20,2),
        portfolio_value DECIMAL(20,2),
        analyses_run INTEGER DEFAULT 0,
        trades_skipped INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Market memory: patterns the AI learns from
      CREATE TABLE IF NOT EXISTS market_memory (
        id SERIAL PRIMARY KEY,
        pattern_type VARCHAR(50),              -- what setup this was
        pair VARCHAR(20),
        conditions JSONB,                      -- indicators at time of trade
        outcome VARCHAR(10),                   -- win or loss
        pnl_percent DECIMAL(10,4),
        lesson TEXT,                           -- what Claude learned
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Bot settings
      CREATE TABLE IF NOT EXISTS bot_settings (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Error log
      CREATE TABLE IF NOT EXISTS error_log (
        id SERIAL PRIMARY KEY,
        error_type VARCHAR(50),
        error_message TEXT,
        context TEXT,
        resolved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Insert default settings if not exist
      INSERT INTO bot_settings (key, value) VALUES
        ('trading_mode', 'paper'),
        ('is_paused', 'false'),
        ('consecutive_losses', '0'),
        ('current_portfolio', '1000'),
        ('daily_loss_today', '0'),
        ('weekly_loss_this_week', '0'),
        ('total_analyses', '0'),
        ('last_analysis', NULL)
      ON CONFLICT (key) DO NOTHING;
    `);

    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function query(text, params) {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (err) {
    console.error('DB Query Error:', err.message);
    throw err;
  }
}

async function getSetting(key) {
  const result = await query('SELECT value FROM bot_settings WHERE key = $1', [key]);
  return result.rows[0]?.value;
}

async function setSetting(key, value) {
  await query(
    'INSERT INTO bot_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
    [key, value]
  );
}

async function logError(type, message, context = '') {
  try {
    await query(
      'INSERT INTO error_log (error_type, error_message, context) VALUES ($1, $2, $3)',
      [type, message, context]
    );
  } catch (err) {
    console.error('Failed to log error:', err.message);
  }
}

module.exports = { pool, initializeDatabase, query, getSetting, setSetting, logError };
