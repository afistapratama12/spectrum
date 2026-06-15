# ADR-0008: Broker reconciliation — broker is source of truth

- Status: Accepted
- Date: 2026-06-14

## Context

The local trade registry can drift from reality: the process may crash after an
order fills but before tracking, a position may be closed manually in the broker
UI, or another process may act. Drift corrupts risk math (phantom open positions)
and reporting.

## Decision

`reconcile.js` treats the **broker as the source of truth**:

- **ADOPT** — a position open at the broker but untracked locally is added to the
  registry.
- **CLOSE** — a locally-open ("phantom") trade the broker no longer reports is
  marked closed; its realized P&L is pulled from `getTodayClosedTrades()` when
  available (see [ADR-0009](0009-robust-order-execution.md)).
- Then `openTradeIds` is aligned to the broker set.

Runs on startup (before the first cycle, both TTY and non-TTY) and on a cron every
`schedule.reconcileIntervalMin` (default 5).

## Consequences

- Local state self-heals after crashes, manual interventions, or missed tracking.
- Pending orders are read for visibility only (no open risk), not mirrored.
- Reconciliation is the safety net behind optimistic fill tracking — together with
  fill confirmation it keeps the registry honest.
