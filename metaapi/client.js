import fetch from "node-fetch";
import { log } from "../logger.js";

const BASE = "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai";

let _ws = null;
let _wsSubscriptions = new Map();
let _wsReconnectTimer = null;

function apiKey() {
  const key = process.env.METAAPI_API_KEY;
  if (!key) throw new Error("METAAPI_API_KEY must be set in .env");
  return key;
}

// ─── REST Client ──────────────────────────────────────────────────

async function request(method, path, body = null, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = {
        "auth-token": apiKey(),
        "Accept": "application/json",
      };
      if (body) {
        headers["Content-Type"] = "application/json";
      }

      const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
        log("metaapi_warn", `Rate limited, waiting ${retryAfter}s`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`MetaApi ${res.status}: ${text.slice(0, 300)}`);
      }

      return await res.json();
    } catch (error) {
      if (attempt === retries) throw error;
      log("metaapi_warn", `Request retry ${attempt + 1}/${retries}: ${error.message}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

export function get(path, query = {}) {
  const qs = Object.entries(query)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const fullPath = qs ? `${path}?${qs}` : path;
  return request("GET", fullPath);
}

export function post(path, body = {}) {
  return request("POST", path, body);
}

export function put(path, body = {}) {
  return request("PUT", path, body);
}

export function del(path) {
  return request("DELETE", path);
}

// ─── Account ID ───────────────────────────────────────────────────

export async function getDefaultAccountId() {
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  if (!accountId) throw new Error("METAAPI_ACCOUNT_ID must be set in .env");
  return accountId;
}

// ─── WebSocket (stub) ─────────────────────────────────────────────

export function connectWebSocket(onMessage, onAccountUpdate) {
  log("metaapi_warn", "MetaApi WebSocket streaming not yet implemented; using REST polling fallback. Real-time account/price updates unavailable.");
  if (onMessage) _wsSubscriptions.set("_account", onMessage);
}

export function subscribePrice(symbol, callback) {
  _wsSubscriptions.set(symbol, callback);
}

export function unsubscribePrice(symbol) {
  _wsSubscriptions.delete(symbol);
}

export function disconnectWebSocket() {
  if (_wsReconnectTimer) {
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = null;
  }
  _wsSubscriptions.clear();
  _ws = null;
}
