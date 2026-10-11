# Auto-Trading AI

Personal Node.js crypto trading bot that combines Claude-based market analysis, hard-coded risk limits, optional RSI/EMA confluence signals, and grid helpers — controlled over Telegram. Supports paper and live modes against Binance spot.

> **Not financial advice.** This is experimental software. Crypto trading involves substantial risk of loss. Past backtests or paper results do not predict future performance. Use at your own risk and only with capital you can afford to lose.

## Features

- Scheduled multi-pair analysis (default every 4 hours on UTC candle closes)
- Three-stage Claude analysis: technical → news/sentiment → final verdict
- Risk Guardian gates every trade (confidence, R/R, max opens, daily/weekly loss limits, consecutive-loss pause)
- Paper mode by default; live Binance spot orders only when explicitly enabled
- Telegram command surface for status, reports, pause/resume, force analysis, and emergency close
- Optional RSI + EMA confluence strategy (`ENABLE_RSI_EMA=true`)
- Optional arithmetic / geometric grid tools with trend-based auto-pause
- PostgreSQL persistence (trades, analysis log, settings, lessons, grids)
- Offline backtester for RSI/EMA and grid strategies (`npm run backtest`)

## Tech stack

| Area       | Choice                                                            |
| ---------- | ----------------------------------------------------------------- |
| Runtime    | Node.js 18+                                                       |
| LLM        | Anthropic Claude (Haiku for stages 1–2, Sonnet for final verdict) |
| Exchange   | Binance (public market data + optional private spot orders)       |
| Messaging  | Telegram Bot API                                                  |
| Database   | PostgreSQL (Neon-compatible)                                      |
| Scheduling | `node-cron`                                                       |
| Indicators | `technicalindicators`                                             |
| Hosting    | Railway (`railway.json`)                                          |

## Architecture

```
Telegram commands ──► src/telegram.js
                           │
Cron /forcecheck ──► src/index.js (orchestrator)
                           │
         ┌─────────────────┼──────────────────┐
         ▼                 ▼                  ▼
  marketData.js       aiBrain.js        strategies/rsiEma.js
  (Binance public     (Claude stages)   (optional signals)
   + Fear & Greed)
         │                 │                  │
         └────────► riskGuardian.js ◄─────────┘
                           │
                    executor.js ──► Binance (live) + PostgreSQL
                           │
                    gridBot.js (optional grids)
```

Core modules live under `src/`. Schema and DB helpers are in `database/`. Offline simulations are in `scripts/backtest.js`. Pure risk helpers used by tests are in `src/risk/`.

## Live deployment

Configured for [Railway](https://railway.app) via `railway.json` (`npm start`). There is no public web UI or documented public URL in this repository — interaction is through Telegram after you deploy your own instance.

## Local setup

### Prerequisites

- Node.js 18+
- PostgreSQL database (local or Neon)
- Telegram bot token + chat ID
- Anthropic API key
- Binance API key/secret (read-only for paper; spot trade permission only if you enable live mode)

### Install

```bash
git clone https://github.com/sohan9542/Auto-Trading-AI.git
cd Auto-Trading-AI
npm install
cp .env.example .env
# fill in required values in .env
npm start
```

For local iteration with auto-restart:

```bash
npm run dev
```

### Required environment variables

See `.env.example` for the full name list. At minimum the bot refuses to start without:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `ANTHROPIC_API_KEY`
- `DATABASE_URL`

Binance keys are required for live order placement. Market data uses Binance’s public data API.

Common optional knobs: `TRADING_MODE` (`paper` / `live`), `TRADE_PAIRS`, `MIN_CONFIDENCE`, `MAX_RISK_PER_TRADE`, loss limits, and RSI/EMA / grid-related settings.

**Never commit a real `.env` file.** Rotate any key that may have been exposed outside this repo.

## Scripts

| Script                 | Purpose                     |
| ---------------------- | --------------------------- |
| `npm start`            | Run the bot                 |
| `npm run dev`          | Run with nodemon            |
| `npm test`             | Unit tests (`node:test`)    |
| `npm run lint`         | ESLint                      |
| `npm run format`       | Prettier write              |
| `npm run format:check` | Prettier check              |
| `npm run backtest`     | Offline strategy backtester |

## Project structure

```
.
├── .github/workflows/ci.yml   # lint, format check, test
├── database/
│   └── db.js                  # PostgreSQL pool + schema bootstrap
├── scripts/
│   └── backtest.js            # RSI/EMA + grid backtester
├── src/
│   ├── index.js               # Orchestrator, cron jobs, startup
│   ├── aiBrain.js             # Claude analysis pipeline
│   ├── marketData.js          # Candles, indicators, news, Fear & Greed
│   ├── riskGuardian.js        # Risk gates + position sizing
│   ├── risk/checks.js         # Pure risk helpers (testable)
│   ├── executor.js            # Paper/live trade open/close/monitor
│   ├── telegram.js            # Bot commands
│   ├── gridBot.js             # Grid trading helpers
│   ├── strategies/rsiEma.js   # Confluence strategy
│   └── utils/                 # env validation, JSON parsing
├── tests/
├── .env.example
├── package.json
└── railway.json
```

## Telegram commands (summary)

Info: `/open`, `/closed`, `/report`, `/weekly`, `/balance`, `/winrate`, `/lastanalysis`, `/memory`, `/status`, `/settings`, `/rsistatus`

Control: `/pause`, `/resume`, `/papermode`, `/livemode` (double-confirm), `/forcecheck`, `/closeall`, `/setsize`

Grids: `/gridstart`, `/gridpct`, `/gridsuggest`, `/gridstatus`, `/gridstop`

## Safety notes

- Default intended mode is paper trading. Confirm with `/status` before assuming live.
- Risk rules can auto-pause after daily/weekly loss limits or a streak of losses.
- Do not enable Binance withdrawal permissions on bot API keys.
- Restrict API keys by IP when your host supports it.
- `/livemode` requires a second confirmation within 60 seconds.

## Disclaimer

This project is for educational and personal experimentation. It is **not** financial advice, an investment product, or a guarantee of profit. Markets are volatile; bugs and API outages can cause unexpected behaviour. You are solely responsible for how you configure and run it.
