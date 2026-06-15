# ADR-0005: 12-hour reporting pushed to Telegram

- Status: Accepted
- Date: 2026-06-14

## Context

The operator wants to monitor passively and receive a report every 12 hours. The
app only generated a single daily briefing, and `generateBriefing()` merely
logged — it was never pushed anywhere.

## Decision

- The briefing cron in `index.js` runs every `schedule.reportIntervalHours`
  (default 12, cron `0 */12 * * *`) and **pushes the report to Telegram** when
  enabled.
- `briefing.js` is a deterministic template (account, challenge progress,
  performance, upcoming news, risk status) — **no LLM call**, so reporting costs
  nothing in tokens.
- Title changed from "Morning Briefing" to "12-Hour Report".

## Consequences

- Reporting is free (template-based) and independent of model choice.
- The legacy `schedule.dailyBriefingHourUTC` field remains for backward
  compatibility but is no longer the driver.
