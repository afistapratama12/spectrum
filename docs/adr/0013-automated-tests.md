# ADR-0013: Automated tests with node:test

- Status: Accepted
- Date: 2026-06-14

## Context

The codebase had no automated tests. The production-grade work (ADR-0002 through
ADR-0012) added safety-critical logic — risk gates, pip math, the guardian halt,
reconciliation, storage — that must not silently regress.

## Decision

Use the built-in `node:test` runner (zero dependency, consistent with the
`node:sqlite` choice). Tests live in `test/*.test.js`. The `npm test` script
isolates state and forbids live orders:

```
rm -f /tmp/spectrum-test.db* && \
SPECTRUM_DB=/tmp/spectrum-test.db DRY_RUN=true BROKER=metaapi \
node --test --test-concurrency=1 test/*.test.js
```

Coverage of the critical gates: `storage` (round-trip/fallback/overwrite),
`trading-halt` lifecycle, `risk-manager` (daily-loss block, position sizing, JPY
trailing pip, time decay), `news` normalization (object/array forms),
`reconcile` (phantom close), and `executor` (JPY SL/TP math, halt blocks entry,
pending wrong-side rejection).

## Consequences

- The B-series guarantees are locked against regression (17 tests at time of writing).
- Tests run in DRY_RUN against a throwaway SQLite DB (`SPECTRUM_DB`) and
  `BROKER=metaapi` so broker reads return empty offline; `--test-concurrency=1`
  keeps the shared DB deterministic.
- Extend this suite when adding new gates or changing risk logic — treat a failing
  `npm test` as a release blocker.
