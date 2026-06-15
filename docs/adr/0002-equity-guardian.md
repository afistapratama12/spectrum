# ADR-0002: Equity Guardian — real-time safety net with day halt

- Status: Accepted
- Date: 2026-06-14

## Context

Risk checks were only pre-trade and per-cycle. The scanner runs every ~30 min and
the manager every ~10 min, and MetaApi market data is REST-polled (no real-time
stream). A fast move (news spike, gap) between cycles could push an open position
through the daily-loss or total-drawdown limit before any cycle reacts — failing
the challenge. "The risk engine enforces limits" was therefore only true at
discrete moments, not continuously.

## Decision

Add an **Equity Guardian** (`guardian.js`) that polls equity on a short interval
(default 45s, `schedule.guardianIntervalSec`) and acts *before* the hard limit:

- When daily loss reaches `risk.guardianDailyLossTriggerPct` (default 0.9 = 90%
  of the daily budget) **or** drawdown reaches `risk.guardianTotalDDTriggerPct`,
  it **closes all positions** and sets a day-scoped halt.
- The halt lives in `trading-halt.js` — a dependency-free leaf module so both the
  guardian and the executor can import it without a cycle. It auto-resets at the
  next UTC day.
- While halted, `tools/executor.js` blocks every new entry (market and pending).
- The halt is surfaced in `/status`, the 12h report, and Telegram.

## Consequences

- Sharply reduces the chance of breaching a limit between cycles, but does **not**
  eliminate it — slippage and large gaps are physical market limits, not code.
  Do not document the guardian as a guarantee.
- The guardian triggers *below* the real limit on purpose, to leave room for
  slippage on the emergency close.
- It runs frequently; it must stay cheap. It performs no LLM calls and (after
  [ADR-0007](0007-sqlite-state-store.md)) only writes the daily snapshot when peak/
  trough actually moves.
