import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TechnicalSummary } from "../src/analysis/types.js";
import type { CouncilAnalysisResult } from "../src/ai/types.js";
import type { GradedSignal } from "../src/signals/scorer.js";
import type { Candle } from "../src/data/types.js";

// ---------------------------------------------------------------------------
// Mocks — isolate the monitor from network, AI, and the database.
// hasSignalChanged stays REAL (we want to exercise the real spam policy).
// ---------------------------------------------------------------------------

const candles: Candle[] = Array.from({ length: 20 }, (_, i) => ({
  symbol: "BTC",
  market: "crypto" as const,
  timestamp: Date.now() - (20 - i) * 3600_000,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 10,
  interval: "1h" as const,
}));

vi.mock("../src/data/binance.js", () => ({
  fetchBinanceKlines: vi.fn(async () => candles),
}));

vi.mock("../src/data/cache.js", () => ({
  cache: {
    getCandles: vi.fn(() => null),
    setCandles: vi.fn(),
  },
}));

let mockTechnical: TechnicalSummary;
vi.mock("../src/analysis/signals.js", () => ({
  analyzeTechnicals: vi.fn(() => mockTechnical),
}));

const councilAnalyzeMock = vi.fn();
vi.mock("../src/ai/council.js", () => ({
  councilAnalyze: (...args: unknown[]) => councilAnalyzeMock(...args),
}));

vi.mock("../src/config.js", () => ({
  hasAnyAI: () => true,
}));

let storedPrevious: GradedSignal | null = null;
const insertSignalMock = vi.fn(async () => {});
vi.mock("../src/signals/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/signals/store.js")>();
  return {
    ...actual, // keep the real hasSignalChanged
    getLatestSignal: vi.fn(async () => storedPrevious),
    insertSignal: (...args: unknown[]) => insertSignalMock(...args),
  };
});

// Import AFTER mocks are registered.
const { evaluateSymbol, isCouncilFresh, COUNCIL_TTL_MS, _resetMonitorState } = await import(
  "../src/signals/monitor.js"
);
const { bus } = await import("../src/events/bus.js");

function makeTechnical(direction: "bullish" | "bearish" | "neutral", strength: number): TechnicalSummary {
  return {
    symbol: "BTC",
    price: 100,
    indicators: {
      rsi: 50, macd: null, sma20: 100, sma50: 100, sma200: 100,
      ema12: 100, ema26: 100, bollingerBands: null, atr: 2,
    },
    signals: [],
    overallDirection: direction,
    overallStrength: strength,
    timestamp: Date.now(),
  };
}

function makeCouncil(direction: "bullish" | "bearish" | "neutral", conf: number): CouncilAnalysisResult {
  return {
    symbol: "BTC", timestamp: Date.now(),
    votes: [{ model: "OpenAI", analysis: { direction, confidence: conf, reasoning: "x", risks: [], keyLevels: {}, timeframe: "s", actionSuggestion: "x" } }],
    failed: [],
    majorityDirection: direction,
    directionBreakdown: { bullish: 0, bearish: 0, neutral: 0 },
    avgConfidence: conf,
    disagreements: [], consensus: null,
  };
}

beforeEach(() => {
  _resetMonitorState();
  storedPrevious = null;
  mockTechnical = makeTechnical("bullish", 0.8);
  councilAnalyzeMock.mockReset();
  councilAnalyzeMock.mockResolvedValue(makeCouncil("bullish", 0.8));
  insertSignalMock.mockClear();
});

describe("isCouncilFresh", () => {
  it("is fresh within the TTL", () => {
    expect(isCouncilFresh(Date.now())).toBe(true);
  });
  it("is stale beyond the TTL", () => {
    expect(isCouncilFresh(Date.now() - COUNCIL_TTL_MS - 1000)).toBe(false);
  });
});

describe("evaluateSymbol", () => {
  it("pushes and persists a new signal on first evaluation", async () => {
    const emitted: GradedSignal[] = [];
    const off = bus.onSignal((s) => emitted.push(s));

    const result = await evaluateSymbol("BTC");

    off();
    expect(result).not.toBeNull();
    expect(result!.call).toBe("STRONG_BUY");
    expect(insertSignalMock).toHaveBeenCalledOnce();
    expect(emitted).toHaveLength(1);
    expect(councilAnalyzeMock).toHaveBeenCalledOnce();
  });

  it("reuses a cached council within the TTL (no second AI call)", async () => {
    await evaluateSymbol("BTC");
    expect(councilAnalyzeMock).toHaveBeenCalledOnce();

    // Change technical slightly so the second eval still runs, but council is cached.
    mockTechnical = makeTechnical("bullish", 0.5);
    await evaluateSymbol("BTC");

    // Still only one council call — the second reused the cache.
    expect(councilAnalyzeMock).toHaveBeenCalledOnce();
  });

  it("does NOT push when the signal hasn't meaningfully changed", async () => {
    // Run once to compute the signal, capture it as the stored previous.
    const first = await evaluateSymbol("BTC");
    storedPrevious = first;
    insertSignalMock.mockClear();

    const emitted: GradedSignal[] = [];
    const off = bus.onSignal((s) => emitted.push(s));
    // Same inputs → same signal → no change.
    const second = await evaluateSymbol("BTC");
    off();

    expect(second).toBeNull();
    expect(insertSignalMock).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it("guards against concurrent evaluation of the same symbol (mutex)", async () => {
    // Make the council call hang until we release it.
    let release!: (v: CouncilAnalysisResult) => void;
    councilAnalyzeMock.mockReturnValue(new Promise((r) => { release = r; }));

    const p1 = evaluateSymbol("BTC");      // enters in-flight, awaits council
    const p2 = await evaluateSymbol("BTC"); // should bail immediately

    expect(p2).toBeNull();

    release(makeCouncil("bullish", 0.8));
    await p1;

    // Only the first call reached councilAnalyze.
    expect(councilAnalyzeMock).toHaveBeenCalledOnce();
  });

  it("skips when not enough candles", async () => {
    const { fetchBinanceKlines } = await import("../src/data/binance.js");
    (fetchBinanceKlines as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const result = await evaluateSymbol("BTC");
    expect(result).toBeNull();
    expect(insertSignalMock).not.toHaveBeenCalled();
  });
});
