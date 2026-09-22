import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tool-calling loop. The model drives, so the loop's job is to faithfully relay
 * tool results back and — critically — to bound spend. An unbounded loop is the
 * same class of bug as the uncapped symbol fan-out that once turned one message
 * into hundreds of LLM calls.
 */

const claudeToolTurnMock = vi.fn();
const openaiToolTurnMock = vi.fn();
const executeToolMock = vi.fn();

let claudeAvailable = true;
let openaiAvailable = true;

vi.mock("../src/ai/claude.js", () => ({
  claudeToolTurn: (...a: unknown[]) => claudeToolTurnMock(...a),
}));
vi.mock("../src/ai/openai.js", () => ({
  openaiToolTurn: (...a: unknown[]) => openaiToolTurnMock(...a),
}));
vi.mock("../src/config.js", () => ({
  hasClaude: () => claudeAvailable,
  hasOpenAI: () => openaiAvailable,
}));
vi.mock("../src/ai/tools/executor.js", () => ({
  executeTool: (...a: unknown[]) => executeToolMock(...a),
}));

const { runToolConversation, MAX_TOOL_CALLS, MAX_ANALYSIS_CALLS } = await import(
  "../src/ai/tool-loop.js"
);

// --- Anthropic response builders ---
function textReply(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}
function toolReply(calls: Array<{ id: string; name: string; input?: unknown }>) {
  return {
    stop_reason: "tool_use",
    content: calls.map((c) => ({
      type: "tool_use",
      id: c.id,
      name: c.name,
      input: c.input ?? {},
    })),
  };
}

const baseOpts = { system: "sys", history: [], userMessage: "hi" };

beforeEach(() => {
  claudeToolTurnMock.mockReset();
  openaiToolTurnMock.mockReset();
  executeToolMock.mockReset();
  executeToolMock.mockResolvedValue({ text: "{}" });
  claudeAvailable = true;
  openaiAvailable = true;
});

describe("runToolConversation — basic flow", () => {
  it("returns text directly when the model calls no tools", async () => {
    claudeToolTurnMock.mockResolvedValue(textReply("Just chatting."));

    const result = await runToolConversation(baseOpts);

    expect(result.text).toBe("Just chatting.");
    expect(result.toolsUsed).toEqual([]);
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("executes a tool then returns the follow-up answer", async () => {
    claudeToolTurnMock
      .mockResolvedValueOnce(toolReply([{ id: "t1", name: "get_market_data", input: { symbol: "VVV" } }]))
      .mockResolvedValueOnce(textReply("VVV is $13.26."));
    executeToolMock.mockResolvedValue({ text: '{"price":13.26}' });

    const result = await runToolConversation(baseOpts);

    expect(executeToolMock).toHaveBeenCalledWith("get_market_data", { symbol: "VVV" });
    expect(result.text).toBe("VVV is $13.26.");
    expect(result.toolsUsed).toEqual(["get_market_data"]);
  });

  it("collects artifacts (charts) produced by tools", async () => {
    const chart = Buffer.from("png");
    claudeToolTurnMock
      .mockResolvedValueOnce(toolReply([{ id: "t1", name: "run_analysis", input: { symbol: "BTC" } }]))
      .mockResolvedValueOnce(textReply("Here's the analysis."));
    executeToolMock.mockResolvedValue({ text: "{}", artifacts: { chart, symbol: "BTC" } });

    const result = await runToolConversation(baseOpts);

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].chart).toBe(chart);
    expect(result.artifacts[0].symbol).toBe("BTC");
  });

  it("relays a tool error back to the model instead of throwing", async () => {
    claudeToolTurnMock
      .mockResolvedValueOnce(toolReply([{ id: "t1", name: "get_market_data", input: { symbol: "NOPE" } }]))
      .mockResolvedValueOnce(textReply("I couldn't find that symbol."));
    executeToolMock.mockResolvedValue({ text: "ERROR: No market data found for NOPE." });

    const result = await runToolConversation(baseOpts);

    expect(result.text).toBe("I couldn't find that symbol.");
  });
});

describe("runToolConversation — spend caps", () => {
  it("stops calling tools past MAX_TOOL_CALLS", async () => {
    // Always ask for one more tool; the loop must refuse rather than comply forever.
    claudeToolTurnMock.mockResolvedValue(
      toolReply([{ id: "t", name: "get_market_data", input: { symbol: "BTC" } }])
    );

    const result = await runToolConversation(baseOpts);

    expect(executeToolMock.mock.calls.length).toBeLessThanOrEqual(MAX_TOOL_CALLS);
    expect(result).toBeDefined();
  });

  it("rations run_analysis to MAX_ANALYSIS_CALLS per message", async () => {
    claudeToolTurnMock
      .mockResolvedValueOnce(
        toolReply([
          { id: "a", name: "run_analysis", input: { symbol: "BTC" } },
          { id: "b", name: "run_analysis", input: { symbol: "ETH" } },
          { id: "c", name: "run_analysis", input: { symbol: "SOL" } },
        ])
      )
      .mockResolvedValueOnce(textReply("done"));

    await runToolConversation(baseOpts);

    const analysisCalls = executeToolMock.mock.calls.filter((c) => c[0] === "run_analysis");
    expect(analysisCalls.length).toBe(MAX_ANALYSIS_CALLS);
  });

  it("terminates even when the model never stops requesting tools", async () => {
    claudeToolTurnMock.mockResolvedValue(
      toolReply([{ id: "t", name: "get_market_data", input: { symbol: "BTC" } }])
    );

    // Resolving at all proves the round cap broke the cycle.
    await expect(runToolConversation(baseOpts)).resolves.toBeDefined();
  });
});

describe("runToolConversation — provider fallback", () => {
  it("falls back to OpenAI when Claude fails before any tool runs", async () => {
    claudeToolTurnMock.mockRejectedValue(new Error("401 invalid key"));
    openaiToolTurnMock.mockResolvedValue({ content: "OpenAI answer", tool_calls: [] });

    const result = await runToolConversation(baseOpts);

    expect(result.text).toBe("OpenAI answer");
  });

  it("does NOT fall back after a tool already ran — rerunning could double-write", async () => {
    // A watchlist add or alert creation is not safely repeatable, so a mid-loop
    // failure must surface rather than silently replaying the conversation.
    claudeToolTurnMock
      .mockResolvedValueOnce(toolReply([{ id: "t1", name: "manage_watchlist", input: { action: "add", symbol: "VVV" } }]))
      .mockRejectedValueOnce(new Error("connection reset"));
    executeToolMock.mockResolvedValue({ text: '{"added":true}' });

    await expect(runToolConversation(baseOpts)).rejects.toThrow("connection reset");
    expect(openaiToolTurnMock).not.toHaveBeenCalled();
  });

  it("uses OpenAI directly when Claude is not configured", async () => {
    claudeAvailable = false;
    openaiToolTurnMock.mockResolvedValue({ content: "from openai", tool_calls: [] });

    const result = await runToolConversation(baseOpts);

    expect(result.text).toBe("from openai");
    expect(claudeToolTurnMock).not.toHaveBeenCalled();
  });

  it("reports when no provider is configured", async () => {
    claudeAvailable = false;
    openaiAvailable = false;

    const result = await runToolConversation(baseOpts);

    expect(result.text).toContain("No AI models are configured");
  });
});

describe("runToolConversation — OpenAI tool flow", () => {
  beforeEach(() => {
    claudeAvailable = false;
  });

  it("executes tools and returns the follow-up answer", async () => {
    openaiToolTurnMock
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "manage_watchlist", arguments: '{"action":"add","symbol":"VVV"}' },
          },
        ],
      })
      .mockResolvedValueOnce({ content: "Added VVV.", tool_calls: [] });
    executeToolMock.mockResolvedValue({ text: '{"added":true}' });

    const result = await runToolConversation(baseOpts);

    expect(executeToolMock).toHaveBeenCalledWith("manage_watchlist", {
      action: "add",
      symbol: "VVV",
    });
    expect(result.text).toBe("Added VVV.");
  });

  it("survives malformed tool arguments", async () => {
    openaiToolTurnMock
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "get_market_data", arguments: "{not json" } },
        ],
      })
      .mockResolvedValueOnce({ content: "recovered", tool_calls: [] });

    const result = await runToolConversation(baseOpts);

    // Bad JSON degrades to empty args; the executor validates and reports.
    expect(executeToolMock).toHaveBeenCalledWith("get_market_data", {});
    expect(result.text).toBe("recovered");
  });
});

describe("evaluate_trade shares the expensive-call budget", () => {
  it("allows only one of run_analysis / evaluate_trade per message", async () => {
    claudeToolTurnMock
      .mockResolvedValueOnce(
        toolReply([
          { id: "a", name: "run_analysis", input: { symbol: "BTC" } },
          { id: "b", name: "evaluate_trade", input: { symbol: "BTC" } },
          { id: "c", name: "evaluate_trade", input: { symbol: "ETH" } },
        ])
      )
      .mockResolvedValueOnce(textReply("done"));

    await runToolConversation(baseOpts);

    const expensive = executeToolMock.mock.calls.filter(
      (c) => c[0] === "run_analysis" || c[0] === "evaluate_trade"
    );
    expect(expensive.length).toBe(MAX_ANALYSIS_CALLS);
  });
});
