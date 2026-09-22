import { describe, it, expect } from "vitest";
import { scoreSignal, deriveLevels, MIN_REWARD_RISK } from "../src/signals/scorer.js";
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
    // Technical-only: conviction 0.8 is NOT diluted toward neutral, but with
    // no council to confirm, the call is capped below STRONG.
    expect(signal.conviction).toBeCloseTo(0.8, 5);
    expect(signal.call).toBe("BUY");
    expect(signal.components.ai).toBeUndefined();
    expect(signal.rationale).toContain("technical-only");
    expect(signal.rationale).toContain("no AI council to confirm");
  });

  it("technical-only bullish (no council arg) is not diluted, but is capped below STRONG", () => {
    const tech = makeTechnical("bullish", 0.8);
    const signal = scoreSignal(tech);
    expect(signal.call).toBe("BUY");
    expect(signal.conviction).toBeCloseTo(0.8, 5);
  });

  it("the monitor's all-AI-down case no longer posts STRONG BUY @ 100%", () => {
    const signal = scoreSignal(makeTechnical("bullish", 1), makeFailedCouncil());
    expect(signal.call).toBe("BUY");
    expect(signal.conviction).toBe(1);
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
    // Technical-only, so capped below STRONG.
    expect(signal.call).toBe("SELL");
  });

  it("conviction is capped at 1", () => {
    const tech = makeTechnical("bullish", 1);
    const council = makeCouncil([makeVote("OpenAI", "bullish", 1)], "bullish", 1);
    const signal = scoreSignal(tech, council);
    expect(signal.conviction).toBeLessThanOrEqual(1);
  });
});

describe("deriveLevels — a target must be worth the risk", () => {
  // The 9:14 AM XRP post: price $1.5781, council support ~$1.53, council
  // resistance ~$1.5802. It printed entry $1.58, target $1.58.
  const XRP = { price: 1.5781, atr: 0.012, support: 1.53, resistance: 1.5802 };

  it("rejects a resistance sitting right on price instead of targeting it", () => {
    const { entry, stop, target, notes } = deriveLevels(XRP.price, true, XRP.atr, {
      support: XRP.support,
      resistance: XRP.resistance,
    });

    const risk = entry - stop;
    expect(stop).toBe(XRP.support);
    expect(target).not.toBe(XRP.resistance);
    expect(target - entry).toBeGreaterThanOrEqual(MIN_REWARD_RISK * risk - 1e-9);
    // The rejected level is surfaced, not silently swapped.
    expect(notes.join(" ")).toContain("resistance at $1.5802");
  });

  it("uses a resistance level that pays enough", () => {
    const { target, notes } = deriveLevels(100, true, 2, { support: 97, resistance: 110 });
    expect(target).toBe(110);
    expect(notes).toHaveLength(0);
  });

  it("mirrors for shorts: support too close to target is rejected", () => {
    const { entry, stop, target, notes } = deriveLevels(100, false, 2, { support: 99.9, resistance: 103 });
    expect(stop).toBe(103);
    expect(entry - target).toBeGreaterThanOrEqual(MIN_REWARD_RISK * (stop - entry) - 1e-9);
    expect(notes.join(" ")).toContain("support at $99.90");
  });

  it("rejects a noise-tight support stop and falls back to ATR", () => {
    // Default stop distance is 1.5 * ATR = 3; support 0.5 below price is too tight.
    const { stop, notes } = deriveLevels(100, true, 2, { support: 99.5, resistance: null });
    expect(stop).toBe(97);
    expect(notes.join(" ")).toContain("too close for a stop");
  });

  it("keeps the minimum reward:risk even when a distant support widens the stop", () => {
    // Stop at support 5 below price; plain 3x ATR target (6) would be only 1.2:1.
    const { entry, stop, target } = deriveLevels(100, true, 2, { support: 95, resistance: null });
    expect((target - entry) / (entry - stop)).toBeGreaterThanOrEqual(MIN_REWARD_RISK);
  });

  it("never produces a target on or behind entry, across many inputs", () => {
    for (let i = 0; i < 500; i++) {
      const price = 0.01 + Math.random() * 1000;
      const isLong = Math.random() < 0.5;
      const atr = Math.random() < 0.2 ? null : Math.random() * price * 0.05;
      const jitter = () => price * (1 + (Math.random() - 0.5) * 0.2);
      const { entry, stop, target } = deriveLevels(price, isLong, atr, {
        support: Math.random() < 0.3 ? null : jitter(),
        resistance: Math.random() < 0.3 ? null : jitter(),
      });
      const dir = isLong ? 1 : -1;
      const risk = (entry - stop) * dir;
      const reward = (target - entry) * dir;
      expect(risk).toBeGreaterThan(0);
      expect(reward).toBeGreaterThanOrEqual(MIN_REWARD_RISK * risk - 1e-9);
    }
  });

  it("puts the rejected-level note in the signal rationale", () => {
    // Technicals bullish 100% + council bullish 62% = 81% STRONG BUY, as posted.
    const signal = scoreSignal(
      makeTechnical("bullish", 1, { price: XRP.price, atr: XRP.atr }),
      makeCouncil(
        [makeVote("OpenAI", "bullish", 0.62, { support: XRP.support, resistance: XRP.resistance })],
        "bullish",
        0.62
      )
    );
    expect(signal.call).toBe("STRONG_BUY");
    expect(signal.rationale).toContain("too close to price");
    expect(signal.target).toBeGreaterThan(signal.entry);
  });
});
