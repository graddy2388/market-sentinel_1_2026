import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * handleChatMessage wiring: conversation memory, active-symbol context, and
 * chart delivery. The tool loop itself is covered separately — here it's mocked
 * so we can assert what the chat layer feeds in and hands back.
 *
 * The active-symbol behaviour is the fix for a specific failure: a follow-up
 * like "yes pull current" names no ticker, so symbol detection found nothing
 * and the bot answered that it had no market data access.
 */

const runToolConversationMock = vi.fn();

vi.mock("../src/ai/tool-loop.js", () => ({
  runToolConversation: (...a: unknown[]) => runToolConversationMock(...a),
}));
vi.mock("../src/config.js", () => ({
  hasClaude: () => true,
  hasOpenAI: () => true,
  hasAnyAI: () => true,
}));
let recentSignals: unknown[] = [];
let recentSignalsFail = false;
vi.mock("../src/signals/store.js", () => ({
  getRecentSignals: vi.fn(async () => {
    if (recentSignalsFail) throw new Error("db locked");
    return recentSignals;
  }),
}));
vi.mock("../src/ai/claude.js", () => ({ chatWithClaudeVision: vi.fn() }));
vi.mock("../src/ai/openai.js", () => ({ chatWithOpenAIVision: vi.fn() }));

const { handleChatMessage } = await import("../src/interfaces/discord/chat.js");
const { clearAllSessions, getHistory, getActiveSymbols, setActiveSymbols } = await import(
  "../src/ai/memory.js"
);

function reply(text: string, artifacts: Array<{ chart?: Buffer; symbol?: string }> = []) {
  return { text, artifacts, toolsUsed: [] };
}

beforeEach(() => {
  runToolConversationMock.mockReset();
  runToolConversationMock.mockResolvedValue(reply("ok"));
  clearAllSessions();
  recentSignals = [];
  recentSignalsFail = false;
});

describe("conversation memory", () => {
  it("records both sides of the exchange", async () => {
    runToolConversationMock.mockResolvedValue(reply("VVV is trading at $13.26."));

    await handleChatMessage("what's VVV at?", "chan-1");

    const history = getHistory("chan-1");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: "user", content: "what's VVV at?" });
    expect(history[1]).toMatchObject({ role: "assistant", content: "VVV is trading at $13.26." });
  });

  it("passes prior turns into the next call", async () => {
    runToolConversationMock.mockResolvedValue(reply("first answer"));
    await handleChatMessage("tell me about VVV", "chan-1");

    runToolConversationMock.mockResolvedValue(reply("second answer"));
    await handleChatMessage("why?", "chan-1");

    const secondCall = runToolConversationMock.mock.calls[1][0];
    expect(secondCall.history).toHaveLength(2);
    expect(secondCall.history[0]).toEqual({ role: "user", content: "tell me about VVV" });
  });

  it("keeps channels isolated", async () => {
    await handleChatMessage("question in A", "chan-A");
    await handleChatMessage("question in B", "chan-B");

    expect(getHistory("chan-A")[0].content).toBe("question in A");
    expect(getHistory("chan-B")[0].content).toBe("question in B");
  });

  it("records nothing for stateless callers", async () => {
    await handleChatMessage("no session");
    expect(getHistory("")).toEqual([]);
  });

  it("clears history on an explicit reset without calling the model", async () => {
    await handleChatMessage("first", "chan-1");
    runToolConversationMock.mockClear();

    const responses = await handleChatMessage("reset", "chan-1");

    expect(responses[0].content).toContain("Cleared");
    expect(getHistory("chan-1")).toEqual([]);
    expect(runToolConversationMock).not.toHaveBeenCalled();
  });
});

describe("active symbol context", () => {
  it("records symbols the tools actually touched", async () => {
    runToolConversationMock.mockResolvedValue(reply("VVV is $13.26.", [{ symbol: "VVV" }]));

    await handleChatMessage("what's VVV at?", "chan-1");

    expect(getActiveSymbols("chan-1")).toEqual(["VVV"]);
  });

  it("supplies the active symbol to a bare follow-up (the 'yes pull current' case)", async () => {
    setActiveSymbols("chan-1", ["VVV"]);

    await handleChatMessage("yes pull current", "chan-1");

    const call = runToolConversationMock.mock.calls[0][0];
    expect(call.system).toContain("VVV");
    expect(call.system.toLowerCase()).toContain("active context");
  });

  it("omits the active-context line when nothing is active yet", async () => {
    await handleChatMessage("hello", "chan-fresh");

    const call = runToolConversationMock.mock.calls[0][0];
    expect(call.system.toLowerCase()).not.toContain("active context");
  });

  it("updates the active symbol when the conversation moves on", async () => {
    runToolConversationMock.mockResolvedValue(reply("a", [{ symbol: "VVV" }]));
    await handleChatMessage("VVV?", "chan-1");

    runToolConversationMock.mockResolvedValue(reply("b", [{ symbol: "BTC" }]));
    await handleChatMessage("what about bitcoin?", "chan-1");

    expect(getActiveSymbols("chan-1")).toEqual(["BTC"]);
  });
});

describe("charts and responses", () => {
  it("attaches a chart artifact to the reply", async () => {
    const chart = Buffer.from("png");
    runToolConversationMock.mockResolvedValue(reply("Analysis done.", [{ chart, symbol: "BTC" }]));

    const responses = await handleChatMessage("analyze BTC", "chan-1");

    expect(responses).toHaveLength(1);
    expect(responses[0].chart).toBe(chart);
    expect(responses[0].symbol).toBe("BTC");
  });

  it("sends extra charts as additional responses", async () => {
    const c1 = Buffer.from("one");
    const c2 = Buffer.from("two");
    runToolConversationMock.mockResolvedValue(
      reply("Two charts.", [
        { chart: c1, symbol: "BTC" },
        { chart: c2, symbol: "ETH" },
      ])
    );

    const responses = await handleChatMessage("compare BTC and ETH", "chan-1");

    expect(responses).toHaveLength(2);
    expect(responses[1].chart).toBe(c2);
  });

  it("falls back to a readable message when the model returns nothing", async () => {
    runToolConversationMock.mockResolvedValue(reply("   "));

    const responses = await handleChatMessage("hmm", "chan-1");

    expect(responses[0].content.length).toBeGreaterThan(0);
  });

  it("surfaces a friendly error when the tool loop throws", async () => {
    runToolConversationMock.mockRejectedValue(new Error("provider exploded"));

    const responses = await handleChatMessage("anything", "chan-1");

    expect(responses[0].content).toContain("Something went wrong");
  });
});

describe("depth hint", () => {
  it("nudges toward run_analysis for explicit analysis requests", async () => {
    await handleChatMessage("give me a full breakdown of BTC technicals and indicators", "chan-1");

    const call = runToolConversationMock.mock.calls[0][0];
    expect(call.system).toContain("run_analysis");
  });

  it("nudges toward a quick lookup for short questions", async () => {
    await handleChatMessage("btc?", "chan-1");

    const call = runToolConversationMock.mock.calls[0][0];
    expect(call.system).toContain("get_market_data");
  });
});

describe("the bot can see the signals it posted", () => {
  // Two people asked "why is the entry and target the same?" about a post the
  // bot had just made, and it replied "which signal?" both times.
  const xrpPost = {
    symbol: "XRP", call: "STRONG_BUY", conviction: 0.81, price: 1.5781,
    entry: 1.5781, stop: 1.53, target: 1.5802,
    rationale: "STRONG BUY @ 81% conviction. Technicals bullish (100%) AI council bullish (62% avg conf) — in agreement.",
    components: { technical: "bullish", ai: "bullish", agreement: true },
    timestamp: Date.now() - 17 * 60_000,
  };

  it("puts recent posts, with precise levels, into the system prompt", async () => {
    recentSignals = [xrpPost];

    await handleChatMessage("why is the entry and target the same", "chan-1");

    const { system } = runToolConversationMock.mock.calls[0][0];
    expect(system).toContain("XRP STRONG BUY @ 81%");
    expect(system).toContain("17 min ago");
    // Four decimals: a target $0.002 above entry is visible, not rounded to "same".
    expect(system).toContain("entry $1.5781");
    expect(system).toContain("target $1.5802");
    // And it knows the rule, so it can say that post didn't meet it.
    expect(system).toContain("1.5:1");
  });

  it("omits the section when nothing was posted", async () => {
    await handleChatMessage("hi", "chan-1");

    const { system } = runToolConversationMock.mock.calls[0][0];
    expect(system).not.toContain("recently posted");
  });

  it("still answers when the signal lookup fails", async () => {
    recentSignalsFail = true;
    runToolConversationMock.mockResolvedValue(reply("still here"));

    const [response] = await handleChatMessage("hi", "chan-1");

    expect(response.content).toBe("still here");
  });
});
