# ADR-0001: LLM is the brain, code is the gate & execution layer

- Status: Accepted
- Date: 2026-06-14

## Context

Spectrum trades autonomously on prop-firm accounts. The operator wants to run
cost-efficient reasoning models (e.g. DeepSeek, Kimi, Qwen) rather than only
flagship models, while keeping account safety guaranteed. A key risk with weaker
models is that they hallucinate numbers, skip steps, or produce unreliable
tool-calls.

## Decision

Keep the **LLM as the decision-making brain** (which setup to take, direction,
SL/TP intent, when to skip) but make **deterministic code the authority** for
everything that protects the account:

- Risk rules (daily loss, drawdown, consistency, position/trade limits, news
  buffer, consecutive-loss cooldown) are enforced in `risk-manager.js` and
  re-checked in `tools/executor.js` **before** any order. The LLM cannot override
  them.
- Position size is always computed in code, never by the LLM.
- SL/TP prices are computed in code from the instrument's real pip size.
- The executor is the single choke point; every write tool re-validates.

Corollary: because we trust the brain, the **gate layer must be strong**. New
LLM-provided values must be validated/clamped, not taken on faith.

## Consequences

- Model quality affects *decision quality* (alpha), not *safety*. A weaker model
  can fail a challenge by trading poorly but cannot breach a hard limit through
  bad output.
- The real risk when picking a cheap model is **tool-calling reliability**, not
  raw reasoning — verify it empirically (see [ADR-0012](0012-model-eval-harness.md)).
- Reasoning models emit `<think>` traces (stripped via `stripThink`) that still
  cost tokens; "efficient" must be measured, not assumed.
- Future work that moves intelligence into code (deterministic setup scoring,
  output validation) reduces model dependence further — compatible with this ADR.
