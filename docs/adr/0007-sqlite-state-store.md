# ADR-0007: SQLite-backed state store via a stable storage interface

- Status: Accepted
- Date: 2026-06-14

## Context

All state lived in flat JSON files (`state.json`, `lessons.json`, `decision-log.json`,
`consistency.json`, `trading-journal.json`, `trading-memory.json`,
`news-correlation.json`). These were written with `fs.writeFileSync` by the
guardian (every 45s), the cycles, and a possible second process (PM2 agent +
manual `node cli.js`). Risks: corruption on crash mid-write, lost updates, and no
real concurrency safety. The operator chose SQLite.

## Decision

Two steps, intentionally ordered:

1. **Centralize** all persistence behind `storage.js` (`readJSON` /
   `writeJSONAtomic`). This step alone made the backend swappable.
2. **Back it with SQLite** using the built-in `node:sqlite` (Node ≥ 22.5) in WAL
   mode — **zero dependency**, no native compile. Each former JSON document is a
   row in one key-value table (`spectrum.db`), keyed by the file's basename, so
   **no caller changed**. Legacy JSON files are migrated into the DB on first read.
   If `node:sqlite` is unavailable, `storage.js` falls back to crash-safe atomic
   file writes (temp file + rename).

`SPECTRUM_DB` env var overrides the DB path (used by tests for isolation).

Also: the Equity Guardian's `updateDailySnapshot` now only writes when peak/trough
actually changes, eliminating ~1,920 redundant writes/day.

## Consequences

- Atomic, crash-safe, concurrency-safe state. `spectrum.db*` is gitignored.
- The `readJSON`/`writeJSONAtomic` interface is the contract — keep new state
  going through it. Do not reintroduce direct `fs` writes for state.
- `node:sqlite` is marked experimental; the warning is suppressed in `storage.js`.
  If it ever changes incompatibly, swap the backend inside `storage.js` only.
