# ADR-0004: Pending orders (stop/limit), exposed to autonomous roles

- Status: Accepted
- Date: 2026-06-14

## Context

The agent could only place market orders. A pro trader also works
breakout/pullback entries with `buy_stop` / `sell_stop` / `buy_limit` /
`sell_limit`. The TradeLocker adapter had a latent `limit` path but it was never
used; MetaApi had no pending support at all.

## Decision

Add pending orders end-to-end:

- Broker adapters gain `placePendingOrder` and `cancelOrder`
  (`metaapi/trading.js` maps to `ORDER_TYPE_BUY_STOP` etc.; `tradelocker/trading.js`
  mirrors it), re-exported via `broker/trading.js`.
- Tools `place_pending_order`, `cancel_pending_order`, and `get_pending_orders`
  in `tools/definitions.js` + `tools/executor.js`. The executor runs the same
  gates as market orders (halt → risk → news → stale-data) and **validates that
  `entry_price` is on the correct side** of current price for the order type. Lot
  size is computed in code; the LLM never passes volume.
- Exposed to autonomous roles in `agent.js`: SCANNER can place/list/cancel;
  MANAGER can list/cancel (to clean up invalidated working orders). `place_pending_
  order` is `ONCE_PER_SESSION` to prevent spam. Prompts updated to explain
  market-vs-pending and stop-vs-limit semantics.

## Consequences

- Pending orders work both via chat and in autonomous cycles.
- Pending orders are **not mirrored in the local trade registry** until they fill
  (they become positions and are then adopted by reconciliation,
  [ADR-0008](0008-broker-reconciliation.md)); `get_pending_orders` reads them live
  from the broker.
