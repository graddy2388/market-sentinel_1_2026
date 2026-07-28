import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — exercise handleChatMessage's general path with a dead Claude key.
// ---------------------------------------------------------------------------

const chatWithClaudeMock = vi.fn();
const chatWithOpenAIMock = vi.fn();

vi.mock("../src/ai/claude.js", () => ({
  chatWithClaude: (...a: unknown[]) => chatWithClaudeMock(...a),
  chatWithClaudeVision: vi.fn(),
}));
vi.mock("../src/ai/openai.js", () => ({
  chatWithOpenAI: (...a: unknown[]) => chatWithOpenAIMock(...a),
  chatWithOpenAIVision: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  hasClaude: () => true,
  hasOpenAI: () => true,
  hasAnyAI: () => true,
}));
vi.mock("../src/data/providers.js", () => ({
  fetch24hrCached: vi.fn(async () => null),
  fetchCandlesCached: vi.fn(async () => []),
  getSupportedSymbols: () => ["BTC"],
  isSymbolAvailable: vi.fn(async () => false),
}));
vi.mock("../src/data/finnhub.js", () => ({
  isFinnhubAvailable: () => false,
}));
vi.mock("../src/analysis/signals.js", () => ({
  analyzeTechnicals: vi.fn(() => null),
}));
vi.mock("../src/ai/council.js", () => ({
  councilAnalyze: vi.fn(),
  councilCritique: vi.fn(),
}));
vi.mock("../src/charts/renderer.js", () => ({
  renderChart: vi.fn(),
}));

const { handleChatMessage } = await import("../src/interfaces/discord/chat.js");
const { clearAllSessions, getHistory } = await import("../src/ai/memory.js");

beforeEach(() => {
  chatWithClaudeMock.mockReset();
  chatWithOpenAIMock.mockReset();
  clearAllSessions();
});

describe("singleAIChat provider fallback", () => {
  it("falls back to OpenAI when Claude fails (e.g. invalid key)", async () => {
    chatWithClaudeMock.mockRejectedValue(new Error("401 API key is invalid"));
    chatWithOpenAIMock.mockResolvedValue("OpenAI fallback answer");

    const responses = await handleChatMessage("hello there");

    expect(responses).toHaveLength(1);
    expect(responses[0].content).toBe("OpenAI fallback answer");
    expect(chatWithClaudeMock).toHaveBeenCalledOnce();
    expect(chatWithOpenAIMock).toHaveBeenCalledOnce();
  });

  it("uses Claude when it works — no fallback call", async () => {
    chatWithClaudeMock.mockResolvedValue("Claude answer");

    const responses = await handleChatMessage("hello there");

    expect(responses[0].content).toBe("Claude answer");
    expect(chatWithOpenAIMock).not.toHaveBeenCalled();
  });

  it("returns the friendly error only when BOTH providers fail", async () => {
    chatWithClaudeMock.mockRejectedValue(new Error("401 invalid"));
    chatWithOpenAIMock.mockRejectedValue(new Error("429 rate limited"));

    const responses = await handleChatMessage("hello there");

    // handleChatMessage catches and returns its generic error message.
    expect(responses[0].content).toContain("Something went wrong");
  });
});

describe("conversation memory in handleChatMessage", () => {
  it("records the exchange when a sessionId is supplied", async () => {
    chatWithClaudeMock.mockResolvedValue("VVV is a small-cap play.");

    await handleChatMessage("tell me about VVV", "chan-1");

    const history = getHistory("chan-1");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: "user", content: "tell me about VVV" });
    expect(history[1]).toMatchObject({ role: "assistant", content: "VVV is a small-cap play." });
  });

  it("passes prior turns to the model on a follow-up", async () => {
    chatWithClaudeMock.mockResolvedValue("first answer");
    await handleChatMessage("tell me about VVV", "chan-1");

    chatWithClaudeMock.mockResolvedValue("second answer");
    await handleChatMessage("why did you say that?", "chan-1");

    // 4th arg of chatWithClaude is the history array.
    const secondCallHistory = chatWithClaudeMock.mock.calls[1][3];
    expect(secondCallHistory).toHaveLength(2);
    expect(secondCallHistory[0]).toEqual({ role: "user", content: "tell me about VVV" });
    expect(secondCallHistory[1]).toEqual({ role: "assistant", content: "first answer" });
  });

  it("keeps separate channels isolated", async () => {
    chatWithClaudeMock.mockResolvedValue("answer");
    await handleChatMessage("question in A", "chan-A");
    await handleChatMessage("question in B", "chan-B");

    expect(getHistory("chan-A")).toHaveLength(2);
    expect(getHistory("chan-A")[0].content).toBe("question in A");
    expect(getHistory("chan-B")[0].content).toBe("question in B");
  });

  it("records nothing when no sessionId is given (stateless callers)", async () => {
    chatWithClaudeMock.mockResolvedValue("answer");
    await handleChatMessage("no session here");
    expect(getHistory("")).toEqual([]);
  });

  it("clears history on an explicit reset command", async () => {
    chatWithClaudeMock.mockResolvedValue("answer");
    await handleChatMessage("first question", "chan-1");
    expect(getHistory("chan-1")).toHaveLength(2);

    const responses = await handleChatMessage("reset", "chan-1");

    expect(responses[0].content).toContain("Cleared");
    expect(getHistory("chan-1")).toEqual([]);
    // The reset itself shouldn't hit the model.
    expect(chatWithClaudeMock).toHaveBeenCalledTimes(1);
  });
});
