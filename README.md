# Spectrum

**AI Autonomous Forex Trader for Prop-Firm Challenges — powered by LLMs via TradeLocker or MetaTrader 5 (MetaApi Cloud).**

Spectrum runs a Meridian-style ReAct agent loop, continuously scanning forex markets, executing trades, and managing positions — all while enforcing prop-firm challenge rules (daily drawdown, consistency, profit target) in hard code, never left to LLM discretion.

Supports two brokers via a unified adapter layer: **TradeLocker** (OAuth 2.0, many prop firms) and **MetaTrader 5** via **MetaApi Cloud** (API-token auth, any MT5 prop firm).

---

## What it does

- **Scans markets** — evaluates all configured forex pairs with multi-timeframe technical analysis (trend, momentum, volatility, session context) and surfaces high-conviction trade setups
- **Manages trades** — monitors open positions, activates trailing stops, evaluates time-decay, and closes positions based on technical context and risk limits
- **Market & pending orders** — places market entries plus **buy stop / sell stop / buy limit / sell limit** pending orders at precise levels. SL/TP use each instrument's real pip size (JPY-aware), never a hardcoded value.
- **Enforces challenge rules** — hard-coded risk engine tracks daily loss, total drawdown, consistency, consecutive loss cooldowns, and news buffers. The LLM *cannot* override these.
- **Equity Guardian** — a real-time safety net that polls equity every ~45s and, when the account nears a daily-loss or drawdown limit, closes all positions and halts new entries for the rest of the day. Closes the gap between the slower cron cycles.
- **Broker reconciliation** — the broker is the source of truth: on startup and every few minutes, untracked broker positions are adopted and phantom local trades are closed, so state survives crashes and manual interventions.
- **Production-grade reliability** — crash-safe SQLite state store, fill confirmation, stale-data guard, a model fallback chain for 24/7 uptime, a model eval harness, and an automated test suite.
- **Trading style presets** — pick `scalping`, `intraday`, or `swing` and the agent auto-configures timeframes, risk, trailing, and cycle intervals. Any value you set explicitly still wins.
- **Learns from performance** — records every closed trade, derives lessons from wins and losses, and injects them into future agent cycles
- **Forex news integration** — scrapes ForexFactory for high-impact events, blocks trading on affected pairs within configurable buffer windows
- **12-hour reporting** — a full account/challenge/performance report is generated every 12 hours and pushed to Telegram
- **Multi-broker support** — TradeLocker REST + WebSocket or MetaTrader 5 via MetaApi Cloud. Switch with `BROKER=metaapi` in `.env`. Unified adapter layer means all tools and strategies work identically on both platforms.
- **CLI** — every tool accessible directly from the terminal with JSON output

---

## How it works

Spectrum runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Scanner Agent** | Every 30 min | Market scanning — finds high-conviction trade setups and executes entries |
| **Manager Agent** | Every 10 min | Trade management — monitors positions, trails stops, closes on rules |
| **Equity Guardian** | Every 45 sec | Real-time safety net — closes all + halts the day if equity nears a limit |

### Agent harness

The agent harness is the runtime wrapper around every autonomous cycle. It loads live account state, injects relevant risk reports and lessons, exposes only role-appropriate tools, executes tool calls, and returns a readable cycle summary.

The harness also keeps a structured decision log in `decision-log.json` for entries, exits, and skips. Each entry records the actor, symbol, summary, reason, and key metrics. Recent decisions are injected into the system prompt so the agent can answer "why did you enter?" or "why did you skip?" without guessing.

### Risk enforcement

All challenge rules are enforced in **`risk-manager.js`** — not in the LLM. Before any trade is placed, the executor validates:

- Daily loss limit (default 4% from start-of-day equity)
- Total drawdown from peak (default 8%)
- Position count limit (default 3)
- News buffer (no trading on pairs with imminent high-impact events)
- Consecutive loss cooldown
- Daily trade limit
- Position size (always calculated in code, never by the LLM)

### Equity Guardian

The cron cycles run every few minutes, so a fast move (news spike, gap) could blow through a limit *between* cycles. The **Equity Guardian** (`guardian.js`) polls equity on a short interval (default 45s) and acts *before* the hard limit is reached:

- When daily loss reaches `guardianDailyLossTriggerPct` (default 90%) of the daily budget, **or** drawdown reaches `guardianTotalDDTriggerPct` (default 90%) of the max, it **closes all positions** and sets a day-scoped halt.
- While halted, the executor blocks every new entry (market and pending) until the next UTC day.
- The halt is surfaced in `/status` and the 12-hour report, and pushed to Telegram.

This sharply reduces the chance of breaching a limit but cannot eliminate it — slippage and large gaps are physical market limits, not code.

### Reliability & production-grade

| Concern | How it's handled | Where |
|---|---|---|
| State integrity | All state in one **SQLite** DB (WAL, built-in `node:sqlite`, zero-dep). Crash-safe, concurrency-safe; legacy JSON files auto-migrated. Falls back to atomic file writes on Node < 22.5. | `storage.js` |
| Drift from reality | **Broker reconciliation** adopts untracked positions and closes phantoms on startup + every `reconcileIntervalMin`. | `reconcile.js` |
| Optimistic fills | **Fill confirmation** polls positions after a market order (no blind-retry → no double fill); unconfirmed fills are flagged for reconcile. | `tools/executor.js` |
| Stale / dead feed | **Stale-data guard** refuses entries when the latest candle is older than `maxCandleAgeMin` or the price is invalid. | `tools/executor.js` |
| Model outage | **Model fallback chain** — on timeout/rate-limit/5xx the agent fails over to `fallbackModels` and keeps running. | `agent.js` |
| Picking a model | **Eval harness** scores a model's tool-call reliability before live: `node cli.js eval <model>`. | `eval-model.js` |
| Regressions | **Automated tests**: `npm test`. | `test/` |

The design rule behind all of this: **the LLM is the brain; code is the gate and execution layer.** See [docs/adr/](docs/adr/) for the full rationale.

**Data sources:**
- Broker REST API — account status, order execution, positions, OHLCV candles
- Broker WebSocket — real-time price feed and account updates (MetaApi WebSocket not yet implemented; uses REST polling)
- ForexFactory (scraped) — high-impact news calendar
- Economic Calendar API — fallback if scraping fails
- OpenRouter — LLM inference (any compatible model)

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key (or any OpenAI-compatible endpoint)
- **Broker (choose one):**
  - TradeLocker account (demo or live) — most prop firms offer TradeLocker
  - [MetaApi Cloud](https://metaapi.cloud) account — for MetaTrader 4/5 prop firms. API token + MT5 account ID required.
- Telegram bot token (optional)

---

## Setup

### 1. Clone & install

```bash
git clone <repo-url> spectrum
cd spectrum
npm install
```

### 2. Configure

Create `.env` from the example:

```bash
cp .env.example .env
```

Fill in your credentials:

```env
# Broker selection: "tradelocker" (default) or "metaapi"
BROKER=tradelocker

# ── TradeLocker (required when BROKER=tradelocker) ──
TRADELOCKER_EMAIL=your_email@example.com
TRADELOCKER_PASSWORD=your_password
TRADELOCKER_SERVER=demo           # "demo" or "live"
TRADELOCKER_ACCOUNT_ID=0

# ── MetaApi Cloud (required when BROKER=metaapi) ──
# Get your API token at https://app.metaapi.cloud/token
# METAAPI_API_KEY=your_token
# METAAPI_ACCOUNT_ID=your_account_id

# OpenRouter
OPENROUTER_API_KEY=sk-or-...

# Safety — always start with dry run
DRY_RUN=true
```

Create `user-config.json` from the example:

```bash
cp user-config.example.json user-config.json
```

Edit challenge rules, risk parameters, and strategy as needed.

### 3. Run

```bash
npm start    # interactive REPL with autonomous cycles
npm run dev  # same as npm start
```

On startup Spectrum fetches your account status, open positions, and begins autonomous cycles immediately.

---

## Running modes

### Interactive REPL

```bash
npm start
```

Starts the full autonomous agent with cron-based scanning + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[scan: 24m 3s | manage: 8m 12s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `/status` | Full risk report — equity, daily P&L, drawdown, limits |
| `/positions` | List open trades with P&L |
| `/scan` | Trigger a scanner cycle manually |
| `/manage` | Trigger a manager cycle manually |
| `/news` | Upcoming high-impact events (24h) |
| `/briefing` | Full performance report (same as the 12-hour report) |
| `/config` | Show current runtime config |
| `/stop` | Graceful shutdown |
| `<anything>` | Free-form chat — ask anything, request trades |

### CLI (direct tool invocation)

```bash
node cli.js <command> [options]
```

**Account:**

```bash
node cli.js status              # Account equity, balance, risk status
node cli.js positions           # List open positions
node cli.js closed 24           # Closed trades in last 24h
```

**Markets:**

```bash
node cli.js news 12             # Upcoming news events (12h)
node cli.js analyze EURUSD      # Deep technical analysis on a pair
```

**Trading:**

```bash
node cli.js place EURUSD buy 0.10 20 30    # Place a trade (symbol, dir, lots, sl_pips, tp_pips)
node cli.js close 123456 "take profit"     # Close a trade
node cli.js close-all "emergency"          # Close all trades
node cli.js place EURUSD buy 0.10 20 30 --dry-run   # Simulate
```

**Info:**

```bash
node cli.js config                       # Show current config
node cli.js config set riskPerTradePct 1 # Update config
node cli.js performance                  # Performance summary
node cli.js decisions 10                 # Recent decisions
node cli.js briefing                     # Full performance report
```

**Eval (qualify a model before going live):**

```bash
node cli.js eval deepseek/deepseek-chat 5   # Score reliability over 5 dry-run runs
```

### Non-TTY / PM2

```bash
npm run pm2:start    # daemonize with PM2
npm run pm2:restart  # restart after code/config changes
npm run pm2:logs     # tail logs
npm run pm2:stop     # stop
```

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

### Trading style (the only field most users need)

| Field | Default | Description |
|---|---|---|
| `tradingStyle` | _(none)_ | `scalping`, `intraday`, or `swing`. Auto-fills timeframes, risk %, trailing, min R:R, and cycle intervals. |

Presets are a starting point — any field you set explicitly elsewhere in `user-config.json` still overrides the preset.

| Style | Entry TFs | Trend TFs | Risk/trade | Scanner / Manager |
|---|---|---|---|---|
| `scalping` | `1m, 5m` | `15m, 1h` | `0.5%` | `5m / 2m` |
| `intraday` | `5m, 15m` | `1h, 4h` | `0.5%` | `30m / 10m` |
| `swing` | `1h, 4h` | `4h, 1D` | `0.75%` | `120m / 30m` |

### Challenge

| Field | Default | Description |
|---|---|---|
| `phase` | `evaluation` | Current phase: `evaluation`, `verification`, or `funded` |
| `profitTargetPct` | `4` | Profit target % |
| `maxDailyLossPct` | `4` | Maximum daily loss from start-of-day equity |
| `maxTotalLossPct` | `8` | Maximum total drawdown from peak equity |
| `minTradingDays` | `4` | Minimum unique trading days |
| `consistencyMinPct` | `25` | No single day > X% of total challenge profit |
| `timeLimitDays` | `30` | Challenge time limit |
| `maxOpenPositions` | `3` | Maximum concurrent positions |
| `newsBufferMinutes` | `15` | No trading N minutes before/after high-impact news |
| `allowedSessions` | `["London","New York"]` | Trading session filter |
| `minRiskRewardRatio` | `1.5` | Minimum TP/SL ratio |

### Risk

| Field | Default | Description |
|---|---|---|
| `riskPerTradePct` | `0.5` | % of equity risked per trade |
| `maxDailyTrades` | `5` | Maximum trades per day |
| `maxConsecutiveLosses` | `3` | Consecutive losses before cooldown |
| `consecutiveLossCooldownMinutes` | `60` | Cooldown duration after consecutive losses |
| `trailingStopEnabled` | `true` | Enable trailing stop |
| `trailingTriggerPips` | `10` | Pips in profit before activating trail |
| `trailingDistancePips` | `5` | Pips to trail behind current price |
| `guardianDailyLossTriggerPct` | `0.9` | Equity Guardian acts at this fraction of the daily-loss budget |
| `guardianTotalDDTriggerPct` | `0.9` | Equity Guardian acts at this fraction of the max drawdown |
| `maxCandleAgeMin` | `10` | Block entries if the latest candle is older than this (stale-feed guard) |

### Strategy

| Field | Default | Description |
|---|---|---|
| `trendTimeframes` | `["1h","4h","1D"]` | Timeframes for trend analysis |
| `entryTimeframes` | `["5m","15m"]` | Timeframes for entry signals |
| `allowedPairs` | `["EURUSD",...]` | Forex pairs to trade |
| `requireTrendAlignment` | `true` | Require multi-TF trend agreement |
| `avoidHighImpactNewsPairs` | `true` | Skip pairs with upcoming high-impact news |

### Schedule

| Field | Default | Description |
|---|---|---|
| `scannerIntervalMin` | `30` | Scanner cycle frequency |
| `managerIntervalMin` | `10` | Manager cycle frequency |
| `reportIntervalHours` | `12` | Hours between full reports (pushed to Telegram) |
| `guardianIntervalSec` | `45` | Equity Guardian polling interval |
| `reconcileIntervalMin` | `5` | Broker reconciliation frequency |

### Models

| Field | Default | Description |
|---|---|---|
| `scannerModel` | `openrouter/healer-alpha` | LLM for scanner cycles |
| `managerModel` | `openrouter/healer-alpha` | LLM for manager cycles |
| `generalModel` | `openrouter/healer-alpha` | LLM for chat/REPL |
| `fallbackModels` | `[]` | Models tried in order if the primary times out / rate-limits / errors |
| `temperature` | `0.3` | LLM temperature |
| `maxSteps` | `15` | Maximum ReAct loop iterations |

---

## How it learns

### Performance recording

After every closed trade, performance is recorded to `lessons.json`:

- Symbol, direction, volume, entry/exit prices
- P&L ($ and %), risk:reward ratio, hold time
- Session, trend context, close reason

### Lesson derivation

Significant outcomes (good or bad) automatically generate lessons:

```
[GOOD] WORKED: EURUSD buy during London session — PnL +1.2%, trend=bullish.
[BAD]  FAILED: USDJPY sell — PnL -2.1%. Reason: stopped out by news spike.
```

Lessons are injected into future agent cycles as part of the system prompt.

### Manual lessons

```bash
node cli.js lesson add "AVOID: trading GBP pairs during BOE speeches"
```

---

## Challenge phases

### Phase 1: Evaluation (default)

- Profit target: configurable (default 4%)
- Daily loss limit enforced
- Total drawdown enforced
- Consistency rule active
- Phase auto-transitions to Verification when profit target is hit

### Phase 2: Verification

- Profit target: same as evaluation (configurable separately)
- Same risk rules apply
- Auto-transitions to Funded when target is hit

### Funded

- No profit target
- Same risk rules (daily loss + total drawdown)
- Payout tracking (to be implemented)

Phase management is handled in `state.js` and checked every manager cycle. Transitions are logged and persisted.

---

## Architecture

```
index.js              Main entry: REPL + cron orchestrator
agent.js              ReAct loop: LLM → tool call → repeat
prompt.js             System prompt builder (SCANNER / MANAGER / GENERAL roles)
config.js             Runtime config from user-config.json + .env
repo-root.js          Stable absolute repo path
logger.js             Structured logging with action audit trail
risk-manager.js       Hard risk enforcement (daily loss, drawdown, consistency)
guardian.js           Equity Guardian — real-time equity watcher + day halt
trading-halt.js       Day-scoped halt flag shared by guardian + executor
reconcile.js          Broker reconciliation — adopt/close vs broker truth
storage.js            SQLite-backed state persistence (readJSON/writeJSONAtomic)
state.js              Trade registry, daily snapshots, challenge phase state
news.js               ForexFactory scraper + economic calendar API fallback
lessons.js            Learning engine: performance records, lesson derivation
decision-log.js       Decision log for entries, exits, skips
briefing.js           12-hour performance report generator
eval-model.js         Model evaluation harness (reliability scorecard)
indicators.js         Shared pure-math indicators (ATR, EMA, RSI, trend)
cli.js                Direct CLI — all tools as subcommands with JSON output

tools/
  definitions.js      Tool schemas (OpenAI function-calling format)
  executor.js         Tool dispatch + pre-execution safety checks

broker/               Unified adapter layer — delegates to active broker
  account.js          Account status, positions, order history
  trading.js          Place/modify/close market + pending orders, cancel, lot size
  market-data.js      OHLCV candles, instrument specs, pip values, indicators
  client.js           WebSocket connect/disconnect, account ID resolver

tradelocker/          TradeLocker implementation (default broker)
  client.js           REST + WebSocket client with OAuth 2.0, retry, rate limiting
  account.js          TradeLocker API normalization
  trading.js          TradeLocker order execution
  market-data.js      TradeLocker OHLCV + re-exports indicators from ../indicators.js

metaapi/              MetaApi Cloud (MetaTrader 5) implementation
  client.js           REST client with API token auth + WebSocket stub
  account.js          MetaApi API normalization
  trading.js          MetaApi order execution
  market-data.js      MetaApi OHLCV + instrument specs + re-exports indicators
```

---

## Position sizing

Position size is **always calculated in code**, not by the LLM. The formula:

```
risk_amount = equity × (riskPerTradePct / 100)
lot_size    = risk_amount / (sl_pips × pip_value)
```

The LLM provides direction + SL pips. The executor calculates the exact lot size and validates against all risk rules before sending to the broker.

SL/TP **prices** are derived from each instrument's real pip size and digit precision (fetched from the broker's instrument specs, with a JPY-aware fallback) — never a hardcoded `0.0001`. This holds for both market and pending orders.

### Pending orders

Beyond market entries, the agent can place **buy stop / sell stop / buy limit / sell limit** orders via `place_pending_order` and withdraw them with `cancel_pending_order`. Lot size is still calculated in code, the same risk + news checks apply, and the executor validates that `entry_price` sits on the correct side of the current price for the chosen order type.

---

## News integration

Spectrum scrapes ForexFactory for high-impact news events. If scraping fails, it falls back to a free economic calendar API.

The `check_news_buffer` tool extracts currencies from the pair symbol (e.g., `EURUSD` → `["EUR", "USD"]`) and checks for HIGH-impact events within the configured buffer window. If a conflict is found, trading on that pair is blocked with a clear reason.

---

## MetaTrader 5 / MetaApi Cloud setup

1. Sign up at [MetaApi Cloud](https://app.metaapi.cloud) and copy your API token
2. Add your MT5 account in the MetaApi dashboard — you'll get an Account ID
3. Set these in `.env`:

```env
BROKER=metaapi
METAAPI_API_KEY=your_token
METAAPI_ACCOUNT_ID=your_account_id
DRY_RUN=true    # test first, false when ready
```

MetaApi Cloud connects to your MT5 terminal (or VPS) via a MetaTrader bridge. No OAuth — authentication is via the API token header. Rate limiting and auto-retry are built in.

**Note:** Real-time WebSocket streaming is not yet implemented for MetaApi. The agent uses REST polling for market data and account updates, which is sufficient for the current synchronous agent loop. WebSocket price streaming will be added in a future update.

## TradeLocker setup

1. Create a TradeLocker demo account at your prop firm's platform
2. Get your credentials (email + password)
3. Set `TRADELOCKER_SERVER=demo` in `.env`
4. Set `DRY_RUN=false` when ready for real trading

The client handles OAuth 2.0 token management (login, refresh, expiry) automatically. WebSocket streams provide real-time price and account updates.

---

## Using a local model

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works. Recommended: set `temperature: 0.3` in `user-config.json` for consistent trading decisions.

---

## Testing

```bash
npm test
```

Runs the built-in `node:test` suite (zero dependency) against an isolated SQLite
DB in `DRY_RUN` — it never places live orders. It covers the safety-critical
gates: risk rules, position sizing, JPY pip math, the Equity Guardian halt, broker
reconciliation, news-payload normalization, and the storage layer. Treat a failing
`npm test` as a release blocker.

---

## Architecture decisions (ADR)

The *why* behind the system — the LLM-as-brain/code-as-gate principle, the Equity
Guardian, SQLite state, broker reconciliation, the model fallback chain, and more —
is recorded in [docs/adr/](docs/adr/). Read it before making structural changes.

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose money, and you can fail prop-firm challenges. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software, including failed prop-firm challenges, lost evaluation fees, or trading losses.
