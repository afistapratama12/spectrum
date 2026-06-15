import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import { getAccountStatus, getOpenPositions, getTodayClosedTrades } from "./broker/account.js";
import { getRiskReport, updateDailySnapshot } from "./risk-manager.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";
import { config } from "./config.js";
import { log } from "./logger.js";

const SCANNER_TOOLS = new Set([
  "get_account_status", "check_challenge_rules", "calculate_position_size",
  "get_pair_analysis", "scan_markets", "get_forex_news", "check_news_buffer",
  "place_trade", "place_pending_order", "get_pending_orders", "cancel_pending_order",
  "get_open_trades",
  "scan_strategies", "get_consistency_report", "get_strategy_usage", "check_daily_consistency",
  "get_pattern_report", "query_journal",
]);

const MANAGER_TOOLS = new Set([
  "get_account_status", "check_challenge_rules",
  "get_open_trades", "close_trade", "close_all_trades", "modify_trade",
  "get_pending_orders", "cancel_pending_order",
  "get_forex_news",
  "get_consistency_report", "get_pattern_report",
]);

const GENERAL_PERSIST_TOOLS = new Set([
  "update_config", "add_lesson", "get_performance_history", "get_recent_decisions",
]);

const WRITE_TOOLS = new Set(["place_trade", "place_pending_order", "close_trade", "close_all_trades", "modify_trade"]);

const ONCE_PER_SESSION = new Set(["place_trade", "place_pending_order", "close_trade"]);
const NO_RETRY_TOOLS = new Set(["place_trade"]);

function getToolsForRole(agentType) {
  if (agentType === "SCANNER") return tools.filter((t) => SCANNER_TOOLS.has(t.function.name));
  if (agentType === "MANAGER") return tools.filter((t) => MANAGER_TOOLS.has(t.function.name));
  return tools;
}

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "sk-placeholder",
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";

function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Run a chat completion across a chain of models (B5). On a *retryable* failure
 * (timeout, network, 429, 5xx, or an empty response) it falls back to the next
 * model and remembers it for the rest of the loop. Non-retryable errors
 * (400/401/403 — bad request/auth, identical on every model) are thrown
 * immediately so we don't waste calls.
 */
async function chatWithFallback(models, startIdx, params) {
  let lastErr;
  for (let i = startIdx; i < models.length; i++) {
    const model = models[i];
    try {
      const response = await client.chat.completions.create({ ...params, model });
      if (!response.choices?.length) {
        const e = new Error("API returned no choices");
        e.retryable = true;
        throw e;
      }
      return { response, usedModel: model, activeIdx: i };
    } catch (err) {
      lastErr = err;
      const status = err.status;
      const retryable = err.retryable === true || status === 429 || status >= 500 || status == null;
      if (!retryable) throw err;
      if (status === 429) await new Promise((r) => setTimeout(r, 15000));
      log("agent_warn", `Model "${model}" failed (${status ?? err.message}); ${i + 1 < models.length ? `falling back to "${models[i + 1]}"` : "no fallback left"}`);
    }
  }
  throw lastErr;
}

export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false } = options;

  const account = await getAccountStatus();
  const positions = await getOpenPositions();
  const closedToday = await getTodayClosedTrades();
  updateDailySnapshot(account);

  const riskReport = getRiskReport(account, positions, closedToday);
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();

  const systemPrompt = buildSystemPrompt(agentType, account, positions, riskReport, lessons, perfSummary, decisionSummary);

  let messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];

  const firedOnce = new Set();
  let sawToolCall = false;

  // B5: build the model fallback chain (primary first, then configured fallbacks)
  const primaryModel = model || config.llm[`${agentType.toLowerCase()}Model`] || DEFAULT_MODEL;
  const fallbacks = Array.isArray(config.llm.fallbackModels) ? config.llm.fallbackModels : [];
  const modelChain = [primaryModel, ...fallbacks.filter((m) => m && m !== primaryModel)];
  let activeIdx = 0;

  // Telemetry (used by the eval harness, B6)
  const toolsUsed = [];
  let stepsUsed = 0;

  for (let step = 0; step < maxSteps; step++) {
    stepsUsed = step + 1;

    try {
      const { response, activeIdx: nextIdx } = await chatWithFallback(modelChain, activeIdx, {
        messages,
        tools: getToolsForRole(agentType),
        temperature: config.llm.temperature,
        max_tokens: maxOutputTokens ?? config.llm.maxTokens,
        tool_choice: "auto",
      });
      activeIdx = nextIdx;

      const msg = response.choices[0].message;

      // Repair malformed JSON args
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
              } catch {
                tc.function.arguments = "{}";
              }
            }
          }
        }
      }

      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        if (!msg.content) {
          messages.pop();
          continue;
        }

        if (!sawToolCall) {
          const ACTION_INTENTS = /\b(deploy|trade|position|order|buy|sell|close|exit|market)\b/i;
          if (ACTION_INTENTS.test(goal)) {
            messages.pop();
            messages.push({
              role: "system",
              content: "This request requires tool execution. Call the appropriate tool first.",
            });
            continue;
          }
        }

        return { content: stripThink(msg.content), userMessage: goal, toolsUsed, steps: stepsUsed, model: modelChain[activeIdx] };
      }

      sawToolCall = true;

      // Execute all tool calls in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (tc) => {
        const name = tc.function.name.replace(/<.*$/, "").trim();
        toolsUsed.push(name);
        let args;

        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "Invalid args" }) };
        }

        // Block once-per-session tools from double execution
        if (ONCE_PER_SESSION.has(name) && firedOnce.has(name)) {
          return {
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ blocked: true, reason: `${name} already executed this session` }),
          };
        }

        const result = await executeTool(name, args);

        if (NO_RETRY_TOOLS.has(name)) firedOnce.add(name);
        else if (ONCE_PER_SESSION.has(name) && result?.success === true) firedOnce.add(name);

        return {
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      // All models in the chain failed (chatWithFallback already handled 429
      // waits and fallbacks), or a tool step threw.
      log("agent_error", `Step ${step + 1}: ${error.message}`);
      if (step === 0) throw error;
      return { content: `Agent encountered an error after ${step + 1} steps: ${error.message}`, userMessage: goal, toolsUsed, steps: stepsUsed, error: error.message };
    }
  }

  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal, toolsUsed, steps: stepsUsed, maxStepsReached: true };
}
