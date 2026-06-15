# ADR-0003: Per-instrument pip precision (no hardcoded 0.0001)

- Status: Accepted
- Date: 2026-06-14

## Context

`tools/executor.js` computed SL/TP prices with a hardcoded `pipSize = 0.0001` and
rounded with `* 100000`. This is wrong for JPY pairs (pip = 0.01) — and USDJPY was
in the default pair list — and would be catastrophically wrong for crypto/indices/
metals. The broker instrument specs already exposed the correct `pipSize` and
`digits`, but the executor ignored them.

## Decision

Resolve pip size and price precision **per instrument**:

- `getSymbolPrecision(symbol)` in the executor fetches `pipSize`/`digits` from the
  broker instrument specs (cached), falling back to symbol inference only when
  specs are unavailable (JPY-suffix → 0.01/3 digits, else 0.0001/5 digits).
- SL/TP prices are rounded to the instrument's `digits`, not a fixed factor.
- `evaluateTrailingStop` in `risk-manager.js` accepts a `pipSize` (JPY-aware
  default) instead of assuming 0.0001.

## Consequences

- JPY pairs now price SL/TP correctly. Verified in tests
  ([ADR-0013](0013-automated-tests.md)).
- The architecture is **crypto-ready**: adding BTCUSD etc. no longer requires
  touching SL/TP math, only ensuring the broker returns correct specs (plus
  contract-size handling for position sizing, which remains future work).
- Never reintroduce a hardcoded pip size. If specs are missing, extend the
  inference table rather than assuming a constant.
