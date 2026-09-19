import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Research Agent.
 *
 * The property that matters most for safety: self-reported confidence is capped
 * by how much real evidence was actually gathered. Downstream, confidence gates
 * whether a trade can even be proposed — so a model asserting 95% certainty from
 * nothing must not be able to open that gate.
 */

const chatWithClaudeMock = vi.fn();
const chatWithOpenAIMock = vi.fn();
let claudeAvailable = true;

vi.mock("../src/ai/claude.js", () => ({
  chatWithClaude: (...a: unknown[]) => chatWithClaudeMock(...a),
}));
vi.mock("../src/ai/openai.js", () => ({
  chatWithOpenAI: (...a: unknown[]) => chatWithOpenAIMock(...a),
}));
vi.mock("../src/config.js", () => ({
  hasClaude: () => claudeAvailable,
  hasOpenAI: () => true,
  hasAnyAI: () => true,
}));

let market = "crypto";
vi.mock("../src/data/providers.js", () => ({
  resolveMarket: vi.fn(async () => market),
  fetchCandlesCached: vi.fn(async () => []),
}));

let coinContextAvailable = true;
let coinContextError: Error | null = null;
vi.mock("../src/data/coingecko.js", () => ({
  fetchCoinContext: vi.fn(async () => {
    if (coinContextError) throw coinContextError;
    return coinContextAvailable
      ? {
          symbol: "VVV", name: "Venice Token", marketCapRank: 87,
          marketCapUsd: 500_000_000, circulatingSupply: 1000, totalSupply: 2000,
          maxSupply: 2000, athUsd: 40, percentFromAth: -38, atlUsd: 1,
          categories: ["AI"], description: "An AI token.",
          developer: { stars: 100, forks: 10, commits4Weeks: 20 },
          community: { twitterFollowers: 5000, redditSubscribers: 100 },
        }
      : null;
  }),
}));

let newsCount = 5;
let newsConfigured = true;
vi.mock("../src/data/finnhub-news.js", () => ({
  isNewsAvailable: () => newsConfigured,
  fetchMarketNews: vi.fn(async () =>
    Array.from({ length: newsCount }, (_, i) => ({
      headline: `Story ${i}`, summary: "summary", source: "Reuters",
      url: "http://x", publishedAt: new Date().toISOString(),
    }))
  ),
  fetchCompanyNews: vi.fn(async () => []),
  fetchRecommendations: vi.fn(async () => null),
  fetchFundamentals: vi.fn(async () => null),
  fetchUpcomingEarnings: vi.fn(async () => null),
}));

let gradedCount = 12;
vi.mock("../src/agents/research/backtest.js", () => ({
  backtestSymbol: vi.fn(async () => ({
    symbol: "VVV", totalSignals: gradedCount, graded: gradedCount,
    hitRate: 0.6, avgMovePercent: 1.5,
    byCall: { BUY: { count: gradedCount, graded: gradedCount, hitRate: 0.6 } },
    recent: [], note: `${gradedCount} graded.`,
  })),
}));

const { researchSymbol } = await import("../src/agents/research/agent.js");

function modelReply(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    direction: "bullish",
    confidence: 0.9,
    thesis: "Strong AI narrative.",
    supportingFacts: ["fact one", "fact two"],
    risks: ["thin liquidity"],
    disqualifiers: [],
    ...overrides,
  });
}

beforeEach(() => {
  chatWithClaudeMock.mockReset();
  chatWithOpenAIMock.mockReset();
  chatWithClaudeMock.mockResolvedValue(modelReply());
  claudeAvailable = true;
  market = "crypto";
  coinContextAvailable = true;
  coinContextError = null;
  newsCount = 5;
  newsConfigured = true;
  gradedCount = 12;
});

describe("confidence is capped by evidence quality", () => {
  it("keeps confidence near the model's own number when data is rich", async () => {
    const result = await researchSymbol("VVV");

    expect(result.selfReportedConfidence).toBe(0.9);
    expect(result.dataQuality).toBeGreaterThan(0.6);
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.confidence).toBeLessThanOrEqual(0.9);
  });

  it("hard-caps a confident model when NO evidence was gathered", async () => {
    coinContextAvailable = false;
    newsCount = 0;
    newsConfigured = false;
    gradedCount = 0;

    const result = await researchSymbol("VVV");

    // Claimed 0.9 on nothing; the floor multiplier is 0.4, so ~0.36.
    expect(result.selfReportedConfidence).toBe(0.9);
    expect(result.confidence).toBeLessThan(0.4);
    // Below the 0.65 trade gate — this is the property that matters.
    expect(result.confidence).toBeLessThan(0.65);
  });

  it("scales confidence down as sources drop out", async () => {
    const rich = await researchSymbol("VVV");

    coinContextAvailable = false;
    newsCount = 0;
    gradedCount = 0;
    const thin = await researchSymbol("VVV");

    expect(thin.confidence).toBeLessThan(rich.confidence);
    expect(thin.dataQuality).toBeLessThan(rich.dataQuality);
  });

  it("never lets confidence exceed what the model claimed", async () => {
    chatWithClaudeMock.mockResolvedValue(modelReply({ confidence: 0.5 }));
    const result = await researchSymbol("VVV");
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe("veto channel and transparency", () => {
  it("surfaces disqualifiers verbatim", async () => {
    chatWithClaudeMock.mockResolvedValue(
      modelReply({ disqualifiers: ["Earnings in 18 hours", "Trading halted"] })
    );

    const result = await researchSymbol("VVV");

    expect(result.disqualifiers).toEqual(["Earnings in 18 hours", "Trading halted"]);
  });

  it("reports which sources were unavailable rather than implying coverage", async () => {
    newsConfigured = false;
    newsCount = 0;

    const result = await researchSymbol("VVV");
    const unavailable = result.sources.filter((s) => !s.available).map((s) => s.label);

    expect(unavailable.length).toBeGreaterThan(0);
    // Web research is never silently claimed as a source.
    expect(unavailable).toContain("LLM web research");
  });

  it("says WHY coin context is missing when CoinGecko rate-limited us", async () => {
    coinContextError = new Error("CoinGecko rate limit hit (no COINGECKO_API_KEY set)");

    const result = await researchSymbol("VVV");
    const source = result.sources.find((s) => s.label === "CoinGecko coin context");

    expect(source?.available).toBe(false);
    expect(source?.note).toContain("rate limit");
    // And it degrades gracefully rather than failing the whole assessment.
    expect(result.direction).toBe("bullish");
  });

  it("distinguishes a coin CoinGecko doesn't rank from a failed lookup", async () => {
    coinContextAvailable = false;

    const result = await researchSymbol("VVV");
    const source = result.sources.find((s) => s.label === "CoinGecko coin context");

    expect(source?.note).toBe("Not a ranked coin on CoinGecko");
  });

  it("tells the model a data gap is ours, not the asset's", async () => {
    newsConfigured = false;
    newsCount = 0;

    await researchSymbol("VVV");
    const prompt = chatWithClaudeMock.mock.calls[0][1] as string;

    expect(prompt).toContain("FINNHUB_API_KEY not configured");
    expect(prompt).toContain("not evidence about the asset");
  });

  it("carries the direction and thesis through", async () => {
    chatWithClaudeMock.mockResolvedValue(
      modelReply({ direction: "bearish", thesis: "Unlock cliff next week." })
    );

    const result = await researchSymbol("VVV");

    expect(result.direction).toBe("bearish");
    expect(result.thesis).toBe("Unlock cliff next week.");
  });
});

describe("provider resilience", () => {
  it("falls back to OpenAI when Claude fails", async () => {
    chatWithClaudeMock.mockRejectedValue(new Error("401 invalid"));
    chatWithOpenAIMock.mockResolvedValue(modelReply({ direction: "neutral" }));

    const result = await researchSymbol("VVV");

    expect(result.direction).toBe("neutral");
    expect(chatWithOpenAIMock).toHaveBeenCalled();
  });

  it("recovers when the model wraps its JSON in prose", async () => {
    chatWithClaudeMock.mockResolvedValue(
      `Here's my research:\n\`\`\`json\n${modelReply()}\n\`\`\`\nHope that helps.`
    );

    const result = await researchSymbol("VVV");

    expect(result.direction).toBe("bullish");
  });
});
