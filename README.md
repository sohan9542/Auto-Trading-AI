# 🤖 AI Crypto Trading Bot — Complete Setup Guide

Your fully automated, self-learning crypto trading bot powered by Claude Fable 5.

## What This Bot Does

- Analyzes BTC & ETH every 4 hours using a **3-stage AI system** (technical → news → final verdict)
- Only trades when ALL stages agree AND confidence ≥ 72%
- **Learns from every closed trade** and feeds lessons back into future decisions
- Enforces unbreakable risk rules (1.5% per trade, daily/weekly loss limits, auto-pause)
- Sends everything to your Telegram — trade alerts, daily reports, full control
- Starts in **paper mode** (fake money) so you can verify the win rate risk-free

---

## ⚠️ READ THIS FIRST

1. **Stay in paper mode for at least 2 weeks.** Check `/winrate` — only go live if it's consistently above 65%.
2. **Past performance does not guarantee future results.** Crypto is volatile. Only trade money you can afford to lose entirely.
3. **No bot wins forever.** The risk rules exist to keep losses small, not to prevent them.

---

## Step 1 — Get Your 5 Keys (≈20 minutes)

### 1.1 Telegram Bot Token
1. Open Telegram, search **@BotFather**
2. Send `/newbot`, choose a name and username
3. Copy the token (looks like `7123456789:AAH...`)

### 1.2 Your Telegram Chat ID
1. Search **@userinfobot** on Telegram
2. Send any message — it replies with your ID (a number like `123456789`)

### 1.3 Anthropic API Key
1. Go to **console.anthropic.com**
2. Sign up → Billing → buy **$10 credits**
3. API Keys → Create Key → copy it (starts with `sk-ant-`)

### 1.4 Binance API Key
1. Log in to **binance.com** → Profile → API Management
2. Create API → label it "trading-bot"
3. **For paper trading: enable "Enable Reading" only** ✅
4. For live trading later: also enable "Enable Spot & Margin Trading"
5. ⚠️ NEVER enable withdrawals
6. ⚠️ Restrict to your server IP if possible (Railway shows your IP in logs)
7. Copy both the API Key and Secret

### 1.5 Neon Database
1. Go to **neon.tech** → sign up free
2. Create a project (any name)
3. Copy the connection string (starts with `postgresql://`)

### 1.6 CryptoPanic API Key (optional but recommended)
1. Go to **cryptopanic.com** → register free
2. Go to API page → copy your auth token
3. (If you skip this, the bot still works — just without news analysis)

---

## Step 2 — Deploy to Railway (≈10 minutes)

### 2.1 Push code to GitHub
1. Create a GitHub account if needed
2. Create a new **private** repository called `trading-bot`
3. Upload all the bot files (keep folder structure: `src/`, `database/`, `package.json`)

### 2.2 Deploy on Railway
1. Go to **railway.app** → sign up with GitHub
2. New Project → Deploy from GitHub repo → select `trading-bot`
3. Go to **Variables** tab and add every variable from `.env.example`:

```
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=your_chat_id
ANTHROPIC_API_KEY=sk-ant-...
BINANCE_API_KEY=your_key
BINANCE_API_SECRET=your_secret
DATABASE_URL=postgresql://...
CRYPTOPANIC_API_KEY=your_token
TRADING_MODE=paper
MAX_RISK_PER_TRADE=1.5
MAX_OPEN_TRADES=3
MIN_CONFIDENCE=72
DAILY_LOSS_LIMIT=4
WEEKLY_LOSS_LIMIT=8
TRADE_PAIRS=BTCUSDT,ETHUSDT
PORTFOLIO_SIZE=1000
```

4. Railway auto-deploys. Check **Deployments → Logs** — you should see:
```
✅ Database initialized successfully
✅ Telegram bot initialized
✅ Bot fully operational
```

5. Your Telegram should receive: **"🚀 Bot Started Successfully"**

---

## Step 3 — Verify It Works

In Telegram, send your bot:
- `/status` → should show RUNNING, paper mode
- `/forcecheck` → triggers a full analysis right now (~60 seconds)
- `/lastanalysis` → see what the AI concluded
- `/help` → all commands

---

## Step 4 — The Paper Trading Phase (Weeks 1–2)

Just let it run. Every 4 hours it analyzes; when it finds a setup, you get a trade alert. Check:

- `/report` daily
- `/winrate` after 15+ trades

**Decision point after 2+ weeks:**
- Win rate ≥ 65% over 15+ trades → consider going live with `/livemode`
- Win rate < 65% → keep paper trading, the AI is still learning

---

## Step 5 — Going Live (only when proven)

1. Add trade permission to your Binance API key
2. Transfer your capital (e.g. $1,000 USDT) to Binance Spot wallet
3. Send `/livemode` to the bot → confirm within 60 seconds
4. The bot now trades with real money under the same strict risk rules

You can switch back anytime with `/papermode` or stop everything with `/pause`.

---

## All Commands

| Command | What it does |
|---------|-------------|
| `/open` | Open trades with live P&L |
| `/closed` | Last 20 closed trades |
| `/report` | Today's full report |
| `/weekly` | Weekly performance |
| `/balance` | Portfolio status |
| `/winrate` | Accuracy stats |
| `/lastanalysis` | Latest AI reasoning |
| `/memory` | Lessons the bot has learned |
| `/pause` / `/resume` | Stop/start automation |
| `/livemode` / `/papermode` | Switch trading modes |
| `/forcecheck` | Analyze market right now |
| `/closeall` | Emergency close everything |
| `/setsize 1.5` | Change risk % per trade |
| `/status` | Bot health |
| `/settings` | Current config |

---

## Monthly Costs

| Item | Cost |
|------|------|
| Railway hosting | Free tier (or $5/mo if exceeded) |
| Neon database | Free |
| Claude API | ~$10–20/mo (Fable 5, 3 stages × 6/day × 2 pairs) |
| Binance, Telegram, news | Free |

💡 To cut AI costs ~70%: in `src/aiBrain.js` change `AI_MODEL` to `'claude-sonnet-4-6'`.

---

## Troubleshooting

**Bot doesn't message me** → Check TELEGRAM_CHAT_ID is correct; send /start to your bot first.

**"Database initialization failed"** → Check DATABASE_URL has `?sslmode=require` at the end.

**AI analysis fails** → Check Anthropic credits at console.anthropic.com. The bot auto-falls back to Sonnet 4.6 if Fable 5 is unavailable.

**Railway deploy fails** → Make sure package.json is in the repo root, and Node version is 18+.

**Bot auto-paused itself** → It hit a loss limit or 5 consecutive losses. This is the safety system working. Review /report, then /resume when ready.
