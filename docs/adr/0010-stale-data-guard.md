# ADR-0010: Stale-data guard before entries

- Status: Accepted
- Date: 2026-06-14

## Context

MetaApi market data is REST-polled. A dead feed, weekend, or gap can return old or
zero-valued candles. Entering off a price that no longer exists produces wrong
SL/TP and bad fills.

## Decision

`checkDataFreshness(candles)` in `tools/executor.js` blocks an entry when:

- there is no candle data, or
- the last close price is not `> 0`, or
- the last candle is older than `risk.maxCandleAgeMin` (default 10 minutes).

Applied to both `place_trade` and `place_pending_order`, **live only** — skipped
when `DRY_RUN=true` because dry-run uses synthetic candles.

## Consequences

- Entries are refused on stale/invalid feeds instead of trading bad prices.
- The 10-minute default suits 5m candles (a forming bar can legitimately be a few
  minutes old); tighten via config for faster timeframes.
- This is the data-integrity counterpart to the broker-truth guarantee in
  [ADR-0008](0008-broker-reconciliation.md).
