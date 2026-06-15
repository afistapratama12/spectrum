# ADR-0011: Model fallback chain for 24/7 resilience

- Status: Accepted
- Date: 2026-06-14

## Context

An autonomous 24/7 agent must survive a model that times out, rate-limits, or
errors — especially when running cheaper models that can be flaky. Previously a
single model was used per call, with only a basic 429 wait.

## Decision

`chatWithFallback` in `agent.js` runs the completion across a **chain**: the
role's primary model (`config.llm.scannerModel` etc.) followed by
`config.llm.fallbackModels` (in order). On a **retryable** failure (429, 5xx,
timeout/network, or an empty response) it falls back to the next model and
**remembers the working one for the rest of the loop**. **Non-retryable** errors
(400/401/403 — same on every model) are thrown immediately so calls aren't wasted.

A side effect of this change: `agentLoop` now returns telemetry (`toolsUsed`,
`steps`, `model`) on all paths, which feeds [ADR-0012](0012-model-eval-harness.md).

## Consequences

- The 24/7 agent keeps running when the primary model has a bad moment.
- Intentional limitation: a wrong/invalid model *name* surfaces as a 400 and is
  **not** failed over (we can't distinguish "bad model name" from "bad request").
  Configure valid models.
- `config.llm.fallbackModels` defaults to `[]` (no fallback) — set it for prod.
