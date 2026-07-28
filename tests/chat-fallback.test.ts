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

beforeEach(() => {
  chatWithClaudeMock.mockReset();
  chatWithOpenAIMock.mockReset();
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
