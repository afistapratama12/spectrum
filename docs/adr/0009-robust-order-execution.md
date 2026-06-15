# ADR-0009: Robust execution — fill confirmation + real external-close P&L

- Status: Accepted
- Date: 2026-06-14

## Context

`placeOrder` returned optimistically: the broker's response was trusted as a fill,
with no verification that the position actually landed. And when reconciliation
closed an externally-closed trade, it recorded P&L as 0, polluting performance
stats.

## Decision

- **Fill confirmation** (`confirmFill` in `tools/executor.js`): after a market
  order, poll `getOpenPositions` up to 3× to confirm the ticket exists. We
  **never blind-retry the order** (that risks a double fill); an unconfirmed fill
  is logged and left for reconciliation to verify. `place_trade` returns a
  `confirmed` flag.
- **Real external-close P&L**: `reconcile.js` fetches `getTodayClosedTrades()` and
  matches by id to record the actual realized P&L (and close price) instead of 0,
  falling back to 0 only when no matching deal is found.

## Consequences

- A submit whose fill can't be confirmed is surfaced, not silently trusted.
- Externally-closed trades carry correct P&L in the registry and reports.
- Partial-fill and idempotency-key handling on resubmit remain future work; the
  current stance favors *no duplicate orders* over *automatic retry*.
