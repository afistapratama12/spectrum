/**
 * Telegram Bot — full async polling bot with notifications and inline settings.
 *
 * Features:
 * - Command handling (/status, /positions, /close, /config, etc.)
 * - Inline button settings menu
 * - Cycle notifications (scanner reports, manager reports)
 * - Emergency alerts (daily loss approaching, drawdown warning)
 * - graceful shutdown + connection recovery
 */

import fetch from "node-fetch";
import { log } from "./logger.js";
import { config } from "./config.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALLOWED_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let _polling = false;
let _lastUpdateId = 0;
let _commandHandler = null;
let _pollTimer = null;

// ─── Core API ──────────────────────────────────────────────────────

function apiUrl(method) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function api(method, body = {}) {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) {
        log("telegram", "401 Unauthorized — check TELEGRAM_BOT_TOKEN");
        stopPolling();
        return null;
      }
      log("telegram_warn", `API ${method} failed (${res.status}): ${text.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (error) {
    log("telegram_warn", `API ${method} error: ${error.message}`);
    return null;
  }
}

// ─── Bot Status ────────────────────────────────────────────────────

export function isEnabled() {
  return !!BOT_TOKEN;
}

// ─── Send Messages ─────────────────────────────────────────────────

export async function sendMessage(text, opts = {}) {
  if (!isEnabled() || !CHAT_ID) return null;
  return api("sendMessage", {
    chat_id: CHAT_ID,
    text: String(text).slice(0, 4096),
    parse_mode: opts.parse_mode || "",
    ...opts,
  });
}

export async function sendHTML(html) {
  if (!isEnabled() || !CHAT_ID) return null;
  const clean = String(html)
    .replace(/<b>/g, "<b>").replace(/<\/b>/g, "</b>")
    .replace(/<i>/g, "<i>").replace(/<\/i>/g, "</i>")
    .replace(/<code>/g, "<code>").replace(/<\/code>/g, "</code>")
    .replace(/<pre>/g, "<pre>").replace(/<\/pre>/g, "</pre>");
  return api("sendMessage", {
    chat_id: CHAT_ID,
    text: clean.slice(0, 4096),
    parse_mode: "HTML",
  });
}

export async function sendMessageWithButtons(text, keyboard) {
  if (!isEnabled() || !CHAT_ID) return null;
  return api("sendMessage", {
    chat_id: CHAT_ID,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function editMessage(text, messageId) {
  if (!isEnabled() || !CHAT_ID) return null;
  return api("editMessageText", {
    chat_id: CHAT_ID,
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, keyboard) {
  if (!isEnabled() || !CHAT_ID) return null;
  return api("editMessageText", {
    chat_id: CHAT_ID,
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!isEnabled()) return null;
  return api("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: String(text).slice(0, 200),
  });
}

// ─── Live Message (editable progress) ──────────────────────────────

export async function createLiveMessage(title, initial) {
  if (!isEnabled() || !CHAT_ID) return null;

  const msg = await sendMessage(`${title}\n\n${initial}`);
  if (!msg?.result?.message_id) return null;

  return {
    messageId: msg.result.message_id,
    text: `${title}\n\n${initial}`,

    async toolStart(name) {
      this.text += `\n🔄 ${name}...`;
      await editMessage(this.text, this.messageId);
    },

    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      this.text = this.text.replace(`🔄 ${name}...`, `${icon} ${name}`);
      await editMessage(this.text, this.messageId);
    },

    async note(text) {
      this.text += `\n${text}`;
      await editMessage(this.text, this.messageId);
    },

    async finalize(content) {
      await editMessage(String(content).slice(0, 4096), this.messageId);
    },

    async fail(error) {
      await editMessage(`${this.text}\n\n❌ Error: ${error}`, this.messageId);
    },
  };
}

// ─── Notifications ─────────────────────────────────────────────────

export async function notifyScannerReport(report) {
  return sendMessage(`🔍 Scanner Cycle\n\n${String(report).slice(0, 3900)}`);
}

export async function notifyManagerReport(report) {
  return sendMessage(`🔄 Manager Cycle\n\n${String(report).slice(0, 3900)}`);
}

export async function notifyTrade(entry) {
  const symbol = entry.symbol || "?";
  const type = entry.type === "buy" ? "📈 LONG" : "📉 SHORT";
  const volume = entry.volume || "?";
  const sl = entry.sl || "?";
  const tp = entry.tp || "?";
  return sendMessage(
    `🚀 NEW TRADE\n\n${type} ${symbol}\nVolume: ${volume} lots\nSL: ${sl} | TP: ${tp}\n\nReason: ${entry.reason || "AI setup"}`.slice(0, 500)
  );
}

export async function notifyTradeClosed({ symbol, pnl, reason }) {
  const emoji = pnl > 0 ? "🟢" : "🔴";
  return sendMessage(
    `${emoji} CLOSED: ${symbol}\nPnL: ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}\nReason: ${reason || "manual"}`.slice(0, 500)
  );
}

export async function notifyDailyLossWarning({ dailyLossPct, remainingPct }) {
  return sendMessage(
    `⚠️ DAILY LOSS WARNING\n\nCurrent: -${dailyLossPct.toFixed(2)}%\nRemaining: ${remainingPct.toFixed(2)}%\n\nConsider pausing or reducing size.`
  );
}

export async function notifyConsistencyWarning({ message }) {
  return sendMessage(`⚠️ CONSISTENCY WARNING\n\n${message}`);
}

export async function notifyChallengePhase({ from, to }) {
  return sendMessage(`🎯 PHASE TRANSITION\n\n${from.toUpperCase()} → ${to.toUpperCase()}\n\nCongratulations!`);
}

// ─── Polling ───────────────────────────────────────────────────────

export function startPolling(handler) {
  if (!isEnabled()) return;
  if (_polling) return;

  _commandHandler = handler;
  _polling = true;
  log("telegram", "Bot polling started");

  poll();
}

export function stopPolling() {
  _polling = false;
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
  log("telegram", "Bot polling stopped");
}

async function poll() {
  if (!_polling) return;

  try {
    const res = await api("getUpdates", {
      offset: _lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ["message", "callback_query"],
    });

    if (res?.ok && Array.isArray(res.result)) {
      for (const update of res.result) {
        _lastUpdateId = update.update_id;

        if (update.callback_query) {
          handleCallback(update.callback_query);
        } else if (update.message?.text) {
          handleMessage(update.message);
        }
      }
    }
  } catch (error) {
    log("telegram_warn", `Poll error: ${error.message}`);
  }

  _pollTimer = setTimeout(poll, 1000);
}

async function handleMessage(msg) {
  const text = msg.text?.trim();
  if (!text) return;

  const userId = String(msg.from?.id || "");
  const chatId = String(msg.chat?.id || "");

  // Auto-set CHAT_ID on first message if not configured
  if (!CHAT_ID && chatId) {
    process.env.TELEGRAM_CHAT_ID = chatId;
    log("telegram", `Auto-set CHAT_ID: ${chatId}`);
  }

  // Authorization
  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId)) {
    await sendMessage("⛔ Unauthorized. Your user ID is not in TELEGRAM_ALLOWED_USER_IDS.");
    return;
  }

  // Queue message for handler
  if (_commandHandler) {
    await _commandHandler(msg);
  }
}

async function handleCallback(query) {
  const data = query.data;
  const userId = String(query.from?.id || "");

  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId)) {
    await answerCallbackQuery(query.id, "Unauthorized");
    return;
  }

  // Forward to handler as synthetic message
  if (_commandHandler) {
    await _commandHandler({
      text: data,
      isCallback: true,
      callbackQueryId: query.id,
      messageId: query.message?.message_id,
      chat: query.message?.chat,
      from: query.from,
    });
  }
}

// ─── Settings Menu ─────────────────────────────────────────────────

export function buildSettingsInlineMenu() {
  const challenge = config.challenge;
  const risk = config.risk;

  const summary = [
    "⚙️ Spectrun Settings",
    "",
    `Phase: ${challenge.phase.toUpperCase()}`,
    `Risk/Trade: ${risk.riskPerTradePct}% | Max Daily Loss: ${challenge.maxDailyLossPct}%`,
    `Trailing: ${risk.trailingStopEnabled ? "ON" : "OFF"} | TP/SL: ${challenge.minRiskRewardRatio}R min`,
    "",
    "Select a setting to change:",
  ].join("\n");

  const keyboard = [
    [
      { text: "🔻 Risk/Trade", callback_data: "cfg:step:riskPerTradePct:-0.1" },
      { text: "🔼 Risk/Trade", callback_data: "cfg:step:riskPerTradePct:0.1" },
    ],
    [
      { text: "🔻 Max Daily Loss", callback_data: "cfg:step:maxDailyLossPct:-1" },
      { text: "🔼 Max Daily Loss", callback_data: "cfg:step:maxDailyLossPct:1" },
    ],
    [
      { text: "🔻 Max Positions", callback_data: "cfg:step:maxOpenPositions:-1" },
      { text: "🔼 Max Positions", callback_data: "cfg:step:maxOpenPositions:1" },
    ],
    [
      { text: risk.trailingStopEnabled ? "✅ Trailing ON" : "❌ Trailing OFF", callback_data: "cfg:toggle:trailingStopEnabled" },
    ],
    [
      { text: "📊 Status", callback_data: "cmd:status" },
      { text: "📋 Positions", callback_data: "cmd:positions" },
      { text: "📰 News", callback_data: "cmd:news" },
    ],
    [
      { text: "⏸ Pause", callback_data: "cmd:pause" },
      { text: "▶️ Resume", callback_data: "cmd:resume" },
      { text: "❌ Close Menu", callback_data: "cfg:close" },
    ],
  ];

  return { text: summary, keyboard };
}
