'use strict';

/**
 * Fail fast when required environment variables are missing.
 * @param {string[]} names
 */
function requireEnv(names) {
  const missing = names.filter((name) => {
    const value = process.env[name];
    return value === undefined || value === null || String(value).trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

/**
 * Env vars required for the bot to start (paper or live).
 * Binance trading keys are only required when trading_mode is live.
 */
const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
];

module.exports = { requireEnv, REQUIRED_ENV };
