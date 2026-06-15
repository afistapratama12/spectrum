# ADR-0006: Trading-style presets (scalping/intraday/swing)

- Status: Accepted
- Date: 2026-06-14

## Context

The operator should set high-level intent, not tune a dozen low-level knobs. The
desired UX: "set the prop-firm rules once, pick a trading style, let the AI do the
rest."

## Decision

Add `tradingStyle` (`scalping` | `intraday` | `swing`) to config. When set,
`config.js` applies a preset that fills timeframes, risk %, trailing, min R:R, and
cycle intervals.

Crucial merge order so the preset never overrides an explicit choice:

```
mergeDefault(userConfig, STYLE_PRESETS[style]); // fill only unset fields
mergeDefault(userConfig, DEFAULTS);             // then fill the rest
```

`mergeDefault` only fills `undefined` fields, so **user-set values win over the
preset, which wins over defaults**.

## Consequences

- Most users only need `tradingStyle` + the prop-firm challenge rules.
- A preset is a starting point, not a lock-in.
- Note the cost implication: `scalping` sets `scannerIntervalMin: 5` (~24× the
  scanner cycles of `swing` at 120m), which is the single biggest driver of
  monthly LLM cost. See [ADR-0001](0001-llm-brain-code-gate.md).
