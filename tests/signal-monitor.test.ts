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

const fetchCandlesCachedMock = vi.fn(async () => candles);
const cryptoSources = new Map<string, "binance" | "coingecko">();
vi.mock("../src/data/providers.js", () => ({
  fetchCandlesCached: (...args: unknown[]) => fetchCandlesCachedMock(...args),
  getCryptoSource: (s: string) => cryptoSources.get(s.toUpperCase()),
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

let watched = true;
const isWatchedMock = vi.fn(async () => watched);
let watchlistEntries: Array<{ symbol: string; market: string; addedAt: string }> = [];
vi.mock("../src/state/watchlist.js", () => ({
  isWatched: (...args: unknown[]) => isWatchedMock(...args),
  listWatchlist: vi.fn(async () => watchlistEntries),
}));

// Import AFTER mocks are registered.
const { evaluateSymbol, isCouncilFresh, COUNCIL_TTL_MS, _resetMonitorState, runSweep, startSignalMonitor, stopSignalMonitor, COINGECKO_SWEEP_INTERVAL_MS } = await import(
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
  watched = true;
  fetchCandlesCachedMock.mockClear();
  watchlistEntries = [];
  cryptoSources.clear();
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

  it("stops evaluating a symbol as soon as it leaves the watchlist — no restart needed", async () => {
    watched = false;
    const emitted: GradedSignal[] = [];
    const off = bus.onSignal((s) => emitted.push(s));

    const result = await evaluateSymbol("XRP");

    off();
    expect(result).toBeNull();
    expect(emitted).toHaveLength(0);
    // Checked before any work: no candle fetch, no council spend.
    expect(fetchCandlesCachedMock).not.toHaveBeenCalled();
    expect(councilAnalyzeMock).not.toHaveBeenCalled();
  });

  it("does not post a HOLD whose conviction merely wobbled (the XRP 26% → 0% spam)", async () => {
    storedPrevious = {
      symbol: "BTC", call: "HOLD", conviction: 0.26, price: 100, entry: 100, stop: 97, target: 103,
      rationale: "x", components: { technical: "neutral", ai: "bullish", agreement: false },
      timestamp: Date.now(),
    };
    mockTechnical = makeTechnical("neutral", 0.15);
    councilAnalyzeMock.mockResolvedValue(makeCouncil("neutral", 0.45)); // → HOLD @ 0%

    const emitted: GradedSignal[] = [];
    const off = bus.onSignal((s) => emitted.push(s));
    const result = await evaluateSymbol("BTC");
    off();

    expect(result).toBeNull();
    expect(emitted).toHaveLength(0);
    expect(insertSignalMock).not.toHaveBeenCalled();
  });

  it("skips when not enough candles", async () => {
    fetchCandlesCachedMock.mockResolvedValueOnce([]);
    const result = await evaluateSymbol("BTC");
    expect(result).toBeNull();
    expect(insertSignalMock).not.toHaveBeenCalled();
  });
});

describe("runSweep — scores whatever is on the watchlist right now", () => {
  const entry = (symbol: string, market = "crypto") => ({ symbol, market, addedAt: "" });
  const sweptSymbols = () => fetchCandlesCachedMock.mock.calls.map((c) => c[0]);

  it("scores every crypto symbol, including ones with no Binance pair (VVV)", async () => {
    watchlistEntries = [entry("XRP"), entry("VVV")];

    await runSweep({ staggerMs: 0 });

    expect(sweptSymbols()).toEqual(["XRP", "VVV"]);
  });

  it("skips stocks — there are no candles to score them from yet", async () => {
    watchlistEntries = [entry("BTC"), entry("SPY", "stock")];

    await runSweep({ staggerMs: 0 });

    expect(sweptSymbols()).toEqual(["BTC"]);
  });

  it("picks up a coin added between sweeps, with no restart", async () => {
    watchlistEntries = [entry("BTC")];
    await runSweep({ staggerMs: 0 });

    watchlistEntries = [entry("BTC"), entry("VVV")];
    fetchCandlesCachedMock.mockClear();
    await runSweep({ staggerMs: 0 });

    expect(sweptSymbols()).toContain("VVV");
  });

  it("paces CoinGecko-backed coins so they don't drain that budget", async () => {
    cryptoSources.set("VVV", "coingecko");
    cryptoSources.set("BTC", "binance");
    watchlistEntries = [entry("BTC"), entry("VVV")];

    await runSweep({ staggerMs: 0 });
    expect(sweptSymbols()).toEqual(["BTC", "VVV"]);

    fetchCandlesCachedMock.mockClear();
    await runSweep({ staggerMs: 0 });
    expect(sweptSymbols()).toEqual(["BTC"]); // VVV waits for its slower cadence

    const later = Date.now() + COINGECKO_SWEEP_INTERVAL_MS;
    vi.spyOn(Date, "now").mockReturnValue(later);
    fetchCandlesCachedMock.mockClear();
    await runSweep({ staggerMs: 0 });
    expect(sweptSymbols()).toContain("VVV");
    vi.restoreAllMocks();
  });

  it("returns the signals it pushed", async () => {
    watchlistEntries = [entry("BTC")];

    const pushed = await runSweep({ staggerMs: 0 });

    expect(pushed).toHaveLength(1);
    expect(pushed[0].call).toBe("STRONG_BUY");
  });

  it("keeps going when one symbol fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    watchlistEntries = [entry("BAD"), entry("BTC")];
    fetchCandlesCachedMock.mockImplementationOnce(async () => {
      throw new Error("provider down");
    });

    const pushed = await runSweep({ staggerMs: 0 });

    expect(sweptSymbols()).toEqual(["BAD", "BTC"]);
    expect(pushed).toHaveLength(1);
  });

  it("won't start a second sweep while one is running", async () => {
    watchlistEntries = [entry("BTC")];
    let release!: (v: unknown) => void;
    councilAnalyzeMock.mockReturnValue(new Promise((r) => { release = r; }));

    const first = runSweep({ staggerMs: 0 });
    const second = await runSweep({ staggerMs: 0 });
    expect(second).toEqual([]);

    release(makeCouncil("bullish", 0.8));
    await first;
    expect(councilAnalyzeMock).toHaveBeenCalledOnce();
  });

  it("no longer scores on stream candles — only ticks are forwarded", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { EventEmitter } = await import("events");
    const fakeStream = new EventEmitter();
    const ticks: unknown[] = [];
    const off = bus.onTick((t) => ticks.push(t));

    startSignalMonitor(fakeStream as never); // empty watchlist: the initial sweep is a no-op
    await vi.waitFor(() => expect(fakeStream.listenerCount("tick")).toBe(1));
    fetchCandlesCachedMock.mockClear();

    fakeStream.emit("candle", { symbol: "BTC" });
    fakeStream.emit("tick", { symbol: "BTC", price: 1 });
    stopSignalMonitor();
    off();

    expect(fakeStream.listenerCount("candle")).toBe(0);
    expect(fetchCandlesCachedMock).not.toHaveBeenCalled();
    expect(ticks).toHaveLength(1);
    // And stopping unsubscribes.
    expect(fakeStream.listenerCount("tick")).toBe(0);
  });
});
