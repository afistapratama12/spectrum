import { repoPath } from "./repo-root.js";
import { readJSON, writeJSONAtomic } from "./storage.js";

const DECISION_LOG_FILE = repoPath("decision-log.json");
const MAX_DECISIONS = 100;

function load() {
  return readJSON(DECISION_LOG_FILE, () => ({ decisions: [] }));
}

function save(data) {
  writeJSONAtomic(DECISION_LOG_FILE, data);
}

function sanitize(value, maxLen = 300) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

export function appendDecision(entry) {
  const data = load();
  const decision = {
    id: `dec_${Date.now()}`,
    ts: new Date().toISOString(),
    type: entry.type || "note",
    actor: entry.actor || "GENERAL",
    symbol: entry.symbol || null,
    summary: sanitize(entry.summary),
    reason: sanitize(entry.reason, 500),
    metrics: entry.metrics || {},
    rejected: Array.isArray(entry.rejected) ? entry.rejected.map((r) => sanitize(r, 180)).filter(Boolean) : [],
  };
  data.decisions.unshift(decision);
  data.decisions = data.decisions.slice(0, MAX_DECISIONS);
  save(data);
  return decision;
}

export function getRecentDecisions(limit = 10) {
  const data = load();
  return (data.decisions || []).slice(0, limit);
}

export function getDecisionSummary(limit = 6) {
  const decisions = getRecentDecisions(limit);
  if (!decisions.length) return "No recent decisions.";
  return decisions.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.actor}] ${d.type.toUpperCase()} ${d.symbol || ""}`,
      d.summary ? `summary: ${d.summary}` : null,
      d.reason ? `reason: ${d.reason}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}
