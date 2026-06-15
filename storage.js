import fs from "fs";
import path from "path";
import { repoPath } from "./repo-root.js";

/**
 * State persistence backed by SQLite (B1).
 *
 * Every JSON "document" the app used to keep in a flat file is now a row in a
 * single key-value table inside one SQLite database (WAL mode). This gives us
 * atomic writes, crash safety, and safe concurrent access from multiple
 * processes (the PM2 agent + a manual `node cli.js`) — none of which flat
 * files provided.
 *
 * The public interface (readJSON / writeJSONAtomic) is unchanged, so every
 * caller (state.js, lessons.js, decision-log.js, …) keeps working untouched.
 * The `file` path argument is reused as the row key (by basename).
 *
 * If `node:sqlite` is unavailable (Node < 22.5), we fall back to crash-safe
 * atomic file writes so the app still runs everywhere.
 */

let DatabaseSync = null;
try {
  // Silence the one-time "SQLite is experimental" warning for clean logs.
  const origEmit = process.emitWarning;
  process.emitWarning = (w, ...a) => {
    if (String(w).includes("SQLite is an experimental")) return undefined;
    return origEmit.call(process, w, ...a);
  };
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null; // older Node — use file fallback
}

let db = null;
let stmtGet = null;
let stmtSet = null;

if (DatabaseSync) {
  try {
    // SPECTRUM_DB lets tests (and isolated runs) point at a throwaway database.
    db = new DatabaseSync(process.env.SPECTRUM_DB || repoPath("spectrum.db"));
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)");
    stmtGet = db.prepare("SELECT value FROM kv WHERE key = ?");
    stmtSet = db.prepare(
      "INSERT INTO kv(key, value, updated_at) VALUES(?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    );
  } catch {
    db = null; // any init failure → fall back to files
  }
}

function keyFor(file) {
  return path.basename(file);
}

function resolveFallback(fallback) {
  return typeof fallback === "function" ? fallback() : fallback;
}

export function readJSON(file, fallback) {
  if (db) {
    try {
      const key = keyFor(file);
      const row = stmtGet.get(key);
      if (row && row.value != null) return JSON.parse(row.value);

      // One-time migration: import an existing legacy JSON file into the DB
      // so prior trade history / lessons survive the switch.
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        stmtSet.run(key, JSON.stringify(data), new Date().toISOString());
        return data;
      }
      return resolveFallback(fallback);
    } catch {
      return resolveFallback(fallback);
    }
  }

  // File fallback (Node < 22.5)
  try {
    if (!fs.existsSync(file)) return resolveFallback(fallback);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return resolveFallback(fallback);
  }
}

export function writeJSONAtomic(file, data) {
  if (db) {
    try {
      stmtSet.run(keyFor(file), JSON.stringify(data), new Date().toISOString());
      return;
    } catch {
      // fall through to file write on DB error
    }
  }

  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic on the same filesystem
}

/** Whether the SQLite backend is active (false = file fallback). */
export function usingSqlite() {
  return db != null;
}
