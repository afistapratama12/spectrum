# ADR-0012: Model evaluation harness

- Status: Accepted
- Date: 2026-06-14

## Context

[ADR-0001](0001-llm-brain-code-gate.md) establishes that the real risk in picking
a cheap model is **tool-calling reliability and process adherence**, not benchmark
reasoning. We needed a way to *measure* a candidate model before trusting it live,
rather than guessing from leaderboards.

## Decision

`eval-model.js` + the `node cli.js eval <model> [runs]` command run the real
SCANNER agent loop N times against a model **in DRY_RUN** (it force-sets
`DRY_RUN=true`, so no live orders) and produce a scorecard:

- completion rate (ran without error)
- tool-call reliability (called ≥1 tool)
- process adherence (called `check_challenge_rules` + `scan_markets`)
- valid-decision rate, action stability across runs, avg steps, avg latency,
  action distribution, errors.

## Consequences

- Cheap models can be **qualified empirically** before going live.
- It measures *reliability/process*, not trading alpha (that's what backtests are
  for). Naming it an "accuracy" test would be misleading.
- It needs a real API key + network to exercise a model; offline it reports the
  model erroring (itself a signal).
- It may append a few dry-run decisions to the log; run it against a throwaway
  `SPECTRUM_DB` if that matters.
