import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Fan-out bounds. Each symbol in a message triggers a full council (one call
 * per configured model), a chart render, and its own Discord reply — so an
 * uncapped symbol list turns one message into hundreds of LLM calls. Likewise,
 * the unknown-ticker regex matches any 2-6 char uppercase run, so probing every
 * candidate against Finnhub can blow its 60 req/min free tier.
 */

const councilAnalyzeMock = vi.fn();
const isSymbolAvailableMock = vi.fn();

vi.mock("../src/ai/claude.js", () => ({
  chatWithClaude: vi.fn(async () => "answer"),
  chatWithClaudeVision: vi.fn(),
}));
vi.mock("../src/ai/openai.js", () => ({
  chatWithOpenAI: vi.fn(async () => "answer"),
  chatWithOpenAIVision: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  hasClaude: () => true,
  hasOpenAI: () => true,
  hasAnyAI: () => true,
}));
vi.mock("../src/data/providers.js", () => ({
  fetch24hrCached: vi.fn(async (s: string) => ({
    symbol: s, market: "crypto", price: 100, change24h: 1,
    changePercent24h: 1, volume24h: 1000, high24h: 101, low24h: 99,
  })),
  fetchCandlesCached: vi.fn(async () => []),
  // A large known-symbol universe, mirroring the real ~51 crypto symbols.
  getSupportedSymbols: () => ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LINK", "AVAX"],
  isSymbolAvailable: (...a: unknown[]) => isSymbolAvailableMock(...a),
}));
vi.mock("../src/data/finnhub.js", () => ({
  isFinnhubAvailable: () => true,
}));
vi.mock("../src/analysis/signals.js", () => ({
  analyzeTechnicals: vi.fn(() => null),
}));
vi.mock("../src/ai/council.js", () => ({
  councilAnalyze: (...a: unknown[]) => councilAnalyzeMock(...a),
  councilCritique: vi.fn(),
}));
vi.mock("../src/charts/renderer.js", () => ({
  renderChart: vi.fn(async () => Buffer.from("png")),
}));

const { handleChatMessage } = await import("../src/interfaces/discord/chat.js");
const { clearAllSessions, getHistory } = await import("../src/ai/memory.js");

beforeEach(() => {
  councilAnalyzeMock.mockReset();
  isSymbolAvailableMock.mockReset();
  isSymbolAvailableMock.mockResolvedValue(false);
  clearAllSessions();
});

describe("symbol fan-out cap", () => {
  it("analyzes at most 3 symbols from one message", async () => {
    const responses = await handleChatMessage(
      "compare BTC ETH SOL XRP ADA DOGE and give me full technicals for each"
    );

    const analyzed = responses.filter((r) => r.symbol);
    expect(analyzed.length).toBeLessThanOrEqual(3);
  });

  it("tells the user which symbols it skipped instead of dropping them silently", async () => {
    const responses = await handleChatMessage(
      "compare BTC ETH SOL XRP ADA DOGE and give me full technicals for each"
    );

    const notice = responses.find((r) => r.content.includes("Only analyzed the first"));
    expect(notice).toBeDefined();
    // The skipped ones are named so the user can follow up.
    expect(notice!.content).toMatch(/XRP|ADA|DOGE/);
  });

  it("handles a single symbol without any skip notice", async () => {
    const responses = await handleChatMessage("quick take on BTC");
    expect(responses.some((r) => r.content.includes("Only analyzed"))).toBe(false);
  });
});

describe("unknown-ticker probe cap", () => {
  it("probes at most 5 unknown tickers per message", async () => {
    // Ordinary prose full of uppercase acronyms — none are real tickers.
    await handleChatMessage("DCA ATH FOMO YOLO REKT HODL WAGMI NGMI LFG IMO TLDR");

    expect(isSymbolAvailableMock.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("answers normally when nothing resolves (prose acronyms, not tickers)", async () => {
    // "DCA"/"ATH"/"FOMO" are ordinary trading slang. With no symbol recognized
    // the message falls through to a general answer rather than a wall of
    // "not found" noise.
    const responses = await handleChatMessage("DCA ATH FOMO YOLO REKT HODL WAGMI NGMI");

    expect(responses).toHaveLength(1);
    expect(responses[0].symbol).toBeUndefined();
    expect(responses[0].content).toBe("answer");
  });

  it("names unresolved tickers when at least one real symbol is present", async () => {
    const responses = await handleChatMessage("BTC vs NVDA and TSLA");
    const notFound = responses.find((r) => r.content.includes("Couldn't find data for"));
    expect(notFound).toBeDefined();
    expect(notFound!.content).toMatch(/NVDA|TSLA/);
  });
});

describe("multi-symbol memory", () => {
  it("keeps every analyzed symbol represented in the stored turn", async () => {
    await handleChatMessage("BTC ETH SOL analysis", "chan-1");

    const history = getHistory("chan-1");
    const assistantTurn = history.find((t) => t.role === "assistant");
    expect(assistantTurn).toBeDefined();

    // All three symbols survive condensing — the first must not crowd out the rest.
    for (const sym of ["BTC", "ETH", "SOL"]) {
      expect(assistantTurn!.content).toContain(sym);
    }
  });
});
