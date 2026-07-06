import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Candle } from "../src/data/types.js";

// ---------------------------------------------------------------------------
// Mocks — isolate routing logic from the network.
// ---------------------------------------------------------------------------

const binance24hrMock = vi.fn();
const binanceKlinesMock = vi.fn();
const binancePriceMock = vi.fn();
vi.mock("../src/data/binance.js", () => ({
  fetchBinance24hr: (...a: unknown[]) => binance24hrMock(...a),
  fetchBinanceKlines: (...a: unknown[]) => binanceKlinesMock(...a),
  fetchBinancePrice: (...a: unknown[]) => binancePriceMock(...a),
}));

const cg24hrMock = vi.fn();
const cgCandlesMock = vi.fn();
const cgPriceMock = vi.fn();
vi.mock("../src/data/coingecko.js", () => ({
  fetch24hr: (...a: unknown[]) => cg24hrMock(...a),
  fetchCandles: (...a: unknown[]) => cgCandlesMock(...a),
  fetchPrice: (...a: unknown[]) => cgPriceMock(...a),
  getSupportedSymbols: () => ["BTC", "LEO"],
}));

vi.mock("../src/data/finnhub.js", () => ({
  isFinnhubAvailable: () => false,
  getKnownStockSymbols: () => [],
  fetchStockQuote: vi.fn(),
  fetchStockCandles: vi.fn(),
}));

// Real in-memory cache class, but a fresh instance per test via clear().
import { cache } from "../src/data/cache.js";
const { fetch24hr, fetch24hrCached, fetchCandles, fetchCandlesCached, fetchPrice } = await import(
  "../src/data/providers.js"
);

function makeCandles(n: number, symbol = "BTC"): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol,
    market: "crypto" as const,
    timestamp: i,
    open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
    interval: "1h" as const,
  }));
}

beforeEach(() => {
  cache.clear();
  binance24hrMock.mockReset();
  binanceKlinesMock.mockReset();
  binancePriceMock.mockReset();
  cg24hrMock.mockReset();
  cgCandlesMock.mockReset();
  cgPriceMock.mockReset();
});

describe("fetch24hr routing", () => {
  it("uses Binance first for crypto, mapping quoteVolume to USD volume", async () => {
    binance24hrMock.mockResolvedValue({
      price: 64000, change: 1000, changePercent: 1.59,
      volume: 15000, quoteVolume: 960_000_000, high: 65000, low: 62500,
    });

    const data = await fetch24hr("BTC");

    expect(data).not.toBeNull();
    expect(data!.price).toBe(64000);
    expect(data!.volume24h).toBe(960_000_000); // quoteVolume, NOT base volume
    expect(data!.high24h).toBe(65000);
    expect(cg24hrMock).not.toHaveBeenCalled();
  });

  it("falls back to CoinGecko when the symbol has no Binance pair", async () => {
    binance24hrMock.mockResolvedValue(null); // e.g. LEO has no USDT pair
    cg24hrMock.mockResolvedValue({
      symbol: "LEO", market: "crypto", price: 9.4, change24h: 0.1,
      changePercent24h: 1.07, volume24h: 2_000_000, high24h: 9.5, low24h: 9.2,
    });

    const data = await fetch24hr("LEO");

    expect(data!.price).toBe(9.4);
    expect(binance24hrMock).toHaveBeenCalled();
    expect(cg24hrMock).toHaveBeenCalledWith("LEO");
  });

  it("returns null for unknown symbols with no stock provider", async () => {
    expect(await fetch24hr("NOTREAL")).toBeNull();
    expect(binance24hrMock).not.toHaveBeenCalled();
  });
});

describe("fetchCandles routing", () => {
  it("uses Binance klines first", async () => {
    binanceKlinesMock.mockResolvedValue(makeCandles(250));
    const candles = await fetchCandles("BTC", "1h", 250);
    expect(candles).toHaveLength(250);
    expect(cgCandlesMock).not.toHaveBeenCalled();
  });

  it("falls back to CoinGecko when Binance has no data", async () => {
    binanceKlinesMock.mockResolvedValue([]);
    cgCandlesMock.mockResolvedValue(makeCandles(42, "LEO"));
    const candles = await fetchCandles("LEO", "1h", 100);
    expect(candles).toHaveLength(42);
    expect(cgCandlesMock).toHaveBeenCalled();
  });
});

describe("fetchCandlesCached", () => {
  it("refetches when the cache cannot satisfy the requested limit", async () => {
    cache.setCandles("BTC", "1h", makeCandles(100)); // cached, but too small
    binanceKlinesMock.mockResolvedValue(makeCandles(250));

    const candles = await fetchCandlesCached("BTC", "1h", 250);

    expect(candles).toHaveLength(250);
    expect(binanceKlinesMock).toHaveBeenCalled();
  });

  it("serves from cache when it can satisfy the limit", async () => {
    cache.setCandles("BTC", "1h", makeCandles(250));
    const candles = await fetchCandlesCached("BTC", "1h", 100);
    expect(candles).toHaveLength(100); // sliced
    expect(binanceKlinesMock).not.toHaveBeenCalled();
  });

  it("falls back to the stale cache when a refetch fails", async () => {
    cache.setCandles("BTC", "1h", makeCandles(100));
    binanceKlinesMock.mockResolvedValue([]);
    cgCandlesMock.mockResolvedValue([]);

    const candles = await fetchCandlesCached("BTC", "1h", 250);

    // Better to answer with 100 slightly-short candles than nothing.
    expect(candles).toHaveLength(100);
  });
});

describe("fetchPrice routing", () => {
  it("uses Binance ticker first for crypto", async () => {
    binancePriceMock.mockResolvedValue({
      symbol: "BTC", market: "crypto", price: 64123, volume: 0, timestamp: 1,
    });
    const tick = await fetchPrice("BTC");
    expect(tick!.price).toBe(64123);
    expect(cgPriceMock).not.toHaveBeenCalled();
  });

  it("falls back to CoinGecko for crypto without a Binance pair", async () => {
    binancePriceMock.mockResolvedValue(null);
    cgPriceMock.mockResolvedValue({
      symbol: "LEO", market: "crypto", price: 9.4, volume: 1, timestamp: 1,
    });
    const tick = await fetchPrice("LEO");
    expect(tick!.price).toBe(9.4);
  });
});

describe("fetch24hrCached", () => {
  it("caches the Binance result", async () => {
    binance24hrMock.mockResolvedValue({
      price: 64000, change: 1000, changePercent: 1.59,
      volume: 15000, quoteVolume: 960_000_000, high: 65000, low: 62500,
    });

    const first = await fetch24hrCached("BTC");
    const second = await fetch24hrCached("BTC");

    expect(first!.price).toBe(64000);
    expect(second!.price).toBe(64000);
    expect(binance24hrMock).toHaveBeenCalledTimes(1); // second hit came from cache
  });
});
