/**
 * Provider-agnostic tool-calling conversation loop.
 *
 * The model drives: it decides when to look up market data, run a council
 * analysis, or modify the watchlist. This replaces code-side intent guessing,
 * and — critically — means the bot can no longer claim it performed an action
 * without a tool actually having run.
 *
 * Anthropic and OpenAI express tool use differently (stop_reason + tool_result
 * blocks vs. tool_calls + role:"tool" messages), so each has its own loop body
 * while sharing the executor and the same spend caps.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { claudeToolTurn } from "./claude.js";
import { openaiToolTurn } from "./openai.js";
import { hasClaude, hasOpenAI } from "../config.js";
import { toAnthropicTools, toOpenAITools } from "./tools/definitions.js";
import { executeTool, type ToolArtifacts } from "./tools/executor.js";

/**
 * Spend caps. A single message previously fanned out to hundreds of LLM calls
 * before symbol caps were added; tool loops can misbehave the same way, so the
 * budget is explicit and enforced regardless of what the model asks for.
 */
export const MAX_ROUNDS = 4;
export const MAX_TOOL_CALLS = 6;
/**
 * Expensive tools share this per-message allowance: run_analysis fires a full
 * council (one call per model), and evaluate_trade runs the whole multi-agent
 * pipeline on top of that.
 */
export const MAX_ANALYSIS_CALLS = 1;
const RATIONED_TOOLS: ReadonlySet<string> = new Set(["run_analysis", "evaluate_trade"]);

export interface ToolConversationOptions {
  system: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  maxRounds?: number;
}

export interface ToolConversationResult {
  text: string;
  artifacts: ToolArtifacts[];
  toolsUsed: string[];
}

/** Tracks and enforces per-message tool spend. */
class ToolBudget {
  private calls = 0;
  private analysisCalls = 0;
  readonly used: string[] = [];

  /** Returns an error string when the call is not allowed, else null. */
  check(name: string): string | null {
    if (this.calls >= MAX_TOOL_CALLS) {
      return `Tool call limit (${MAX_TOOL_CALLS}) reached for this message. Answer with what you already have.`;
    }
    if (RATIONED_TOOLS.has(name) && this.analysisCalls >= MAX_ANALYSIS_CALLS) {
      return `Only ${MAX_ANALYSIS_CALLS} expensive call (run_analysis or evaluate_trade) is allowed per message. Use get_market_data or summarize what you have.`;
    }
    return null;
  }

  record(name: string): void {
    this.calls++;
    if (RATIONED_TOOLS.has(name)) this.analysisCalls++;
    this.used.push(name);
  }

  get anyExecuted(): boolean {
    return this.calls > 0;
  }
}

/** Parse model-supplied JSON arguments without trusting them. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function dispatch(
  name: string,
  input: Record<string, unknown>,
  budget: ToolBudget,
  artifacts: ToolArtifacts[]
): Promise<string> {
  const denied = budget.check(name);
  if (denied) return `ERROR: ${denied}`;

  budget.record(name);
  const result = await executeTool(name, input);
  if (result.artifacts) artifacts.push(result.artifacts);
  return result.text;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function anthropicText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function runClaudeLoop(
  opts: ToolConversationOptions,
  budget: ToolBudget,
  artifacts: ToolArtifacts[]
): Promise<string> {
  const tools = toAnthropicTools() as Anthropic.Tool[];
  const messages: Anthropic.MessageParam[] = [
    ...opts.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: opts.userMessage },
  ];

  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  let lastText = "";

  for (let round = 0; round < maxRounds; round++) {
    const message = await claudeToolTurn(opts.system, messages, tools);
    lastText = anthropicText(message.content) || lastText;

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
      return lastText;
    }

    messages.push({
      role: "assistant",
      content: message.content as unknown as Anthropic.ContentBlockParam[],
    });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const text = await dispatch(
        use.name,
        (use.input ?? {}) as Record<string, unknown>,
        budget,
        artifacts
      );
      results.push({ type: "tool_result", tool_use_id: use.id, content: text });
    }

    messages.push({ role: "user", content: results });
  }

  // Rounds exhausted — ask for a final answer using what has been gathered.
  const closing = await claudeToolTurn(
    `${opts.system}\n\nYou have used all available tool calls. Answer now with the information you have.`,
    messages,
    []
  );
  return anthropicText(closing.content) || lastText;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function runOpenAILoop(
  opts: ToolConversationOptions,
  budget: ToolBudget,
  artifacts: ToolArtifacts[]
): Promise<string> {
  const tools = toOpenAITools() as OpenAI.Chat.ChatCompletionTool[];
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.system },
    ...opts.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: opts.userMessage },
  ];

  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  let lastText = "";

  for (let round = 0; round < maxRounds; round++) {
    const message = await openaiToolTurn(messages, tools);
    lastText = message.content?.trim() || lastText;

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return lastText;
    }

    messages.push(message);

    for (const call of toolCalls) {
      // Only function tool calls carry a name/arguments pair.
      if (call.type !== "function") continue;
      const text = await dispatch(
        call.function.name,
        parseArgs(call.function.arguments),
        budget,
        artifacts
      );
      messages.push({ role: "tool", tool_call_id: call.id, content: text });
    }
  }

  const closing = await openaiToolTurn(
    [
      ...messages,
      {
        role: "system",
        content: "You have used all available tool calls. Answer now with the information you have.",
      },
    ],
    []
  );
  return closing.content?.trim() || lastText;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Run a tool-enabled conversation turn.
 *
 * Prefers Claude and falls back to OpenAI — but ONLY when no tool has executed
 * yet. Restarting after a write (an added alert, say) would run it twice, and
 * not every tool is idempotent, so a mid-loop failure surfaces instead.
 */
export async function runToolConversation(
  opts: ToolConversationOptions
): Promise<ToolConversationResult> {
  const budget = new ToolBudget();
  const artifacts: ToolArtifacts[] = [];

  if (hasClaude()) {
    try {
      const text = await runClaudeLoop(opts, budget, artifacts);
      return { text, artifacts, toolsUsed: budget.used };
    } catch (err) {
      if (budget.anyExecuted || !hasOpenAI()) throw err;
      console.error(
        "[ToolLoop] Claude failed before any tool ran, falling back to OpenAI:",
        err instanceof Error ? err.message : err
      );
    }
  }

  if (hasOpenAI()) {
    const text = await runOpenAILoop(opts, budget, artifacts);
    return { text, artifacts, toolsUsed: budget.used };
  }

  return {
    text: "No AI models are configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.",
    artifacts,
    toolsUsed: [],
  };
}
