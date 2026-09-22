/**
 * Tool definitions exposed to the chat model.
 *
 * Declared once in a neutral shape and converted per provider: Anthropic wants
 * `input_schema`, OpenAI wants `function.parameters`. Keeping one source of
 * truth prevents the two from drifting.
 *
 * These exist so the bot can actually *do* things rather than claim it did.
 * Before tool use, "add VVV to my briefing" produced a confident confirmation
 * backed by no write at all.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's arguments. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_market_data",
    description:
      "Get the current price, 24h stats, and key technical indicators (RSI, MACD, moving averages) for a crypto or stock symbol. Use this whenever the user asks about current price, how something is doing, or wants data pulled. Cheap and fast — prefer it over run_analysis unless the user explicitly wants deep analysis.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Ticker symbol, e.g. BTC, ETH, VVV, SPY. Letters only.",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "run_analysis",
    description:
      "Run the full multi-model AI council analysis on a symbol and generate a price chart. Expensive and slow (roughly 10 seconds) — use ONLY when the user explicitly asks for analysis, a breakdown, technicals, a deep dive, or whether to buy/sell. At most one call per message.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Ticker symbol to analyze.",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "research_asset",
    description:
      "Get deeper context on a symbol from the Research Agent: news, fundamentals or crypto-native data, analyst views, and how this system's own past calls on it actually resolved. Use when the user asks WHY something is moving, wants the story/narrative behind a move, asks about news or fundamentals, or is weighing a decision. This is context, not technical analysis — pair it with get_market_data for price and indicators.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Ticker symbol, e.g. BTC, VVV, SPY.",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "evaluate_trade",
    description:
      "Run the full multi-agent trade review on a symbol: Sentinel (technicals + AI council) and the Research Agent assess it independently, debate for up to two rounds, vote, and a confidence gate decides whether it would go to the user for approval. Returns the decision record, including any dissent. It NEVER places an order — it only logs a decision. Slow (up to a minute) and costly: use only when the user asks whether the system would trade something, wants a trade proposal, or asks what the agents think together. At most one call per message.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker symbol, e.g. BTC, XRP, VVV." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "list_proposals",
    description:
      "List recent decision records from the multi-agent trade review — what it found eligible, rejected, or vetoed, and why. Use when the user asks what the system has proposed, what it almost traded, or why something was rejected. Read-only.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Only this symbol. Optional." },
        status: {
          type: "string",
          enum: ["eligible", "below_threshold", "vetoed", "no_action", "error"],
          description: "Only this outcome. Optional.",
        },
        limit: { type: "number", description: "How many, newest first (default 5, max 20)." },
      },
    },
  },
  {
    name: "manage_watchlist",
    description:
      "List, add to, or remove from the user's watchlist. The watchlist drives the daily briefing and the automated signal posts (the 'X — BUY/SELL/HOLD' embeds), so 'add X to my daily briefing' means add, and 'stop the X alerts/signals' means remove. Changes take effect on the next signal sweep, within about 5 minutes. Adding is idempotent.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "remove"],
          description: "What to do.",
        },
        symbol: {
          type: "string",
          description: "Ticker symbol. Required for add and remove.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_alerts",
    description:
      "List active price alerts, or create a new one. Alerts fire once when their condition is met and are then deactivated. These are user-set price/RSI triggers only — the automated signal posts are controlled by the watchlist (manage_watchlist), not here.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "set"],
          description: "What to do.",
        },
        symbol: { type: "string", description: "Ticker symbol. Required for set." },
        condition: {
          type: "string",
          enum: ["price_above", "price_below", "pct_change", "rsi_above", "rsi_below"],
          description: "Alert condition. Required for set.",
        },
        threshold: {
          type: "number",
          description: "Price level, percentage, or RSI value. Required for set.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "list_positions",
    description:
      "List the user's recorded portfolio positions with current prices and profit/loss. Read-only.",
    parameters: { type: "object", properties: {} },
  },
];

/** Anthropic Messages API tool shape. */
export function toAnthropicTools() {
  return TOOL_SPECS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as unknown as {
      type: "object";
      properties: Record<string, unknown>;
    },
  }));
}

/** OpenAI chat completions tool shape. */
export function toOpenAITools() {
  return TOOL_SPECS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }));
}
