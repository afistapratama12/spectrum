/**
 * Day-scoped emergency trading halt.
 *
 * Set by the Equity Guardian when the account breaches (or nearly breaches)
 * a prop-firm limit. While halted, the executor blocks ALL new entries.
 * Auto-resets at the next UTC day so trading resumes the following session.
 *
 * This is a dependency-free leaf module so both the guardian and the executor
 * can import it without creating a circular dependency.
 */

let _halt = null; // { date, reason, at }

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export function haltTrading(reason) {
  _halt = { date: todayUTC(), reason, at: new Date().toISOString() };
  return _halt;
}

export function clearHalt() {
  _halt = null;
}

export function isTradingHalted() {
  if (!_halt) return false;
  if (_halt.date !== todayUTC()) {
    _halt = null; // new UTC day — auto-reset
    return false;
  }
  return true;
}

export function getHaltReason() {
  return isTradingHalted() ? _halt.reason : null;
}
