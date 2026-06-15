# Architecture Decision Records

This directory records the significant architectural decisions for Spectrum, the
AI autonomous prop-firm trader. Each ADR captures the **context**, the
**decision**, and its **consequences** so a future engineer (or AI agent) can
understand *why* the system is shaped the way it is — not just *what* it does.

Format: lightweight [MADR](https://adr.github.io/madr/). One decision per file.
Status values: `Proposed` · `Accepted` · `Superseded by ADR-NNNN`.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-llm-brain-code-gate.md) | LLM is the brain, code is the gate & execution layer | Accepted |
| [0002](0002-equity-guardian.md) | Equity Guardian — real-time safety net with day halt | Accepted |
| [0003](0003-per-instrument-pip-precision.md) | Per-instrument pip precision (no hardcoded 0.0001) | Accepted |
| [0004](0004-pending-orders.md) | Pending orders (stop/limit), exposed to autonomous roles | Accepted |
| [0005](0005-twelve-hour-reporting.md) | 12-hour reporting pushed to Telegram | Accepted |
| [0006](0006-trading-style-presets.md) | Trading-style presets (scalping/intraday/swing) | Accepted |
| [0007](0007-sqlite-state-store.md) | SQLite-backed state store via a stable storage interface | Accepted |
| [0008](0008-broker-reconciliation.md) | Broker reconciliation — broker is source of truth | Accepted |
| [0009](0009-robust-order-execution.md) | Robust execution: fill confirmation + real external-close P&L | Accepted |
| [0010](0010-stale-data-guard.md) | Stale-data guard before entries | Accepted |
| [0011](0011-model-fallback-chain.md) | Model fallback chain for 24/7 resilience | Accepted |
| [0012](0012-model-eval-harness.md) | Model evaluation harness | Accepted |
| [0013](0013-automated-tests.md) | Automated tests with node:test | Accepted |

All ADRs here were accepted on 2026-06-14.
