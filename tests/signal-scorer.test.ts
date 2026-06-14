import { describe, it, expect } from "vitest";
import { scoreSignal } from "../src/signals/scorer.js";
import type { TechnicalSummary, SignalDirection } from "../src/analysis/types.js";
import type { CouncilAnalysisResult, ModelVote } from "../src/ai/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTechnical(
  direction: SignalDirection,
  strength: number,
  opts: { price?: number; atr?: number | null } = {}
): TechnicalSummary {
  const price = opts.price ?? 100;
  return {
    symbol: "BTC",
    price,
    indicators: {
      rsi: 50,
      macd: { macd: 0, signal: 0, histogram: 0 },
      sma20: price,
      sma50: price,
      sma200: price,
      ema12: price,
      ema26: price,
      bollingerBands: { upper: price * 1.02, middle: price, lower: price * 0.98 },
      atr: opts.atr === undefined ? 2 : opts.atr,
    },
    signals: [],
    overallDirection: direction,
    overallStrength: strength,
    timestamp: Date.now(),
  };
}

function makeVote(
  model: string,
  direction: SignalDirection,
  confidence: number,
  levels: { support?: number; resistance?: number } = {}
): ModelVote {
  return {
    model,
    analysis: {
      direction,
      confidence,
      reasoning: "test",
      risks: [],
      keyLevels: levels,
      timeframe: "short-term",
      actionSuggestion: "test",
    },
  };
}

function makeCouncil(
  votes: ModelVote[],
  majorityDirection: SignalDirection,
  avgConfidence: number
): CouncilAnalysisResult {
  const breakdown = { bullish: 0, bearish: 0, neutral: 0 };
  for (const v of votes) breakdown[v.analysis.direction]++;
  return {
    symbol: "BTC",
    timestamp: Date.now(),
    votes,
    failed: [],
    majorityDirection,
    directionBreakdown: breakdown,
    avgConfidence,
    disagreements: [],
    consensus: null,
  };
}

/** A council where every provider failed — zero votes. */
function makeFailedCouncil(): CouncilAnalysisResult {
  return {
    symbol: "BTC",
    timestamp: Date.now(),
    votes: [],
    failed: [
      { model: "OpenAI", error: "request failed" },
      { model: "Claude", error: "request failed" },
    ],
    majorityDirection: "neutral",
    directionBreakdown: { bullish: 0, bearish: 0, neutral: 0 },
    avgConfidence: 0,
    disagreements: [],
    consensus: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scoreSignal", () => {
  it("strong bullish agreement → STRONG_BUY", () => {
    const tech = makeTechnical("bullish", 0.9);
    const council = makeCouncil(
      [makeVote("OpenAI", "bullish", 0.9), makeVote("Claude", "bullish", 0.85)],
      "bullish",
      0.875
    );
    const signal = scoreSignal(tech, council);
    expect(signal.call).toBe("STRONG_BUY");
    expect(signal.components.agreement).toBe(true);
    expect(signal.components.ai).toBe("bullish");
    expect(signal.conviction).toBeGreaterThan(0.7);
  });

  it("moderate bullish → BUY", () => {
    const tech = makeTechnical("bullish", 0.5);
    const council = makeCouncil([makeVote("OpenAI", "bullish", 0.5)], "bullish", 0.5);
    const signal = scoreSignal(tech, council);
    expect(signal.call).toBe("BUY");
  });

  it("strong bearish agreement → STRONG_SELL", () => {
    const tech = makeTechnical("bearish", 0.9);
    const council = makeCouncil(
      [makeVote("OpenAI", "bearish", 0.9), makeVote("Claude", "bearish", 0.8)],
      "bearish",
      0.85
    );
    const signal = scoreSignal(tech, council);
    expect(signal.call).toBe("STRONG_SELL");
    expect(signal.components.agreement).toBe(true);
  });

  it("split between technical and AI → HOLD (low net)", () => {
    const tech = makeTechnical("bullish", 0.8);
    const council = makeCouncil([makeVote("OpenAI", "bearish", 0.8)], "bearish", 0.8);
    const signal = scoreSignal(tech, council);
    // 0.5 * 0.8 + 0.5 * (-0.8) = 0 → HOLD
    expect(signal.call).toBe("HOLD");
    expect(signal.components.agreement).toBe(false);
  });

  it("neutral technical + no council → HOLD", () => {
    const tech = makeTechnical("neutral", 0);
    const signal = scoreSignal(tech);
    expect(signal.call).toBe("HOLD");
    expect(signal.components.ai).toBeUndefined();
  });

  it("treats a zero-vote (all-failed) council as absent, not neutral", () => {
    const tech = makeTechnical("bullish", 0.8);
    const failed = makeFailedCouncil();
    const signal = scoreSignal(tech, failed);
    // Should be technical-only: net = 0.8 → STRONG_BUY, NOT diluted toward neutral
    expect(signal.call).toBe("STRONG_BUY");
    expect(signal.components.ai).toBeUndefined();
    expect(signal.rationale).toContain("technical-only");
  });

  it("technical-only bullish (no council arg) is not diluted", () => {
    const tech = makeTechnical("bullish", 0.8);
    const signal = scoreSignal(tech);
    expect(signal.call).toBe("STRONG_BUY");
    expect(signal.conviction).toBeCloseTo(0.8, 5);
  });

  it("uses ATR for stop/target on a long signal", () => {
    const tech = makeTechnical("bullish", 0.8, { price: 100, atr: 2 });
    const signal = scoreSignal(tech);
    // long: stop = 100 - 1.5*2 = 97, target = 100 + 3*2 = 106
    expect(signal.entry).toBe(100);
    expect(signal.stop).toBeCloseTo(97, 5);
    expect(signal.target).toBeCloseTo(106, 5);
  });

  it("falls back to percentage stop/target when ATR is null", () => {
    const tech = makeTechnical("bullish", 0.8, { price: 100, atr: null });
    const signal = scoreSignal(tech);
    // long: stop = 100 - 2.5% = 97.5, target = 100 + 5% = 105
    expect(signal.stop).toBeCloseTo(97.5, 5);
    expect(signal.target).toBeCloseTo(105, 5);
  });

  it("prefers council support/resistance levels when available", () => {
    const tech = makeTechnical("bullish", 0.8, { price: 100, atr: 2 });
    const council = makeCouncil(
      [
        makeVote("OpenAI", "bullish", 0.8, { support: 95, resistance: 110 }),
        makeVote("Claude", "bullish", 0.8, { support: 93, resistance: 112 }),
      ],
      "bullish",
      0.8
    );
    const signal = scoreSignal(tech, council);
    // avg support = 94, avg resistance = 111 (both better than ATR-derived levels)
    expect(signal.stop).toBeCloseTo(94, 5);
    expect(signal.target).toBeCloseTo(111, 5);
  });

  it("inverts stop/target geometry for a short (sell) signal", () => {
    const tech = makeTechnical("bearish", 0.8, { price: 100, atr: 2 });
    const signal = scoreSignal(tech);
    // short: stop above (100 + 1.5*2 = 103), target below (100 - 3*2 = 94)
    expect(signal.stop).toBeCloseTo(103, 5);
    expect(signal.target).toBeCloseTo(94, 5);
    expect(signal.call).toBe("STRONG_SELL");
  });

  it("conviction is capped at 1", () => {
    const tech = makeTechnical("bullish", 1);
    const council = makeCouncil([makeVote("OpenAI", "bullish", 1)], "bullish", 1);
    const signal = scoreSignal(tech, council);
    expect(signal.conviction).toBeLessThanOrEqual(1);
  });
});
