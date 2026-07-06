import { appConfig } from "../config.js";
import type { MarketOverview, Candle, CandleInterval } from "./types.js";

// ---------------------------------------------------------------------------
// Finnhub REST API client — stocks + commodity ETFs
// Free tier: 60 API calls/minute
// ---------------------------------------------------------------------------

const BASE_URL = "https://finnhub.io/api/v1";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Well-known stock & ETF symbols for the "supported symbols" list.
 * Finnhub supports any valid US ticker, so this list is just for
 * discoverability — unlisted tickers are still tried on demand.
 */
const KNOWN_STOCK_SYMBOLS: string[] = [
  // Mega-cap tech
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA",
  // Broad ETFs
  "SPY", "QQQ", "IWM", "DIA", "VOO", "VTI",
  // Commodity ETFs
  "GLD", "SLV", "USO", "GDX",
  // Crypto-adjacent
  "COIN", "MSTR", "MARA", "RIOT", "IBIT", "ETHE",
  // Popular large-caps
  "AMD", "INTC", "NFLX", "CRM", "ORCL", "PLTR", "UBER",
  "JPM", "BAC", "GS", "V", "MA",
];

function getApiKey(): string | undefined {
  return appConfig.FINNHUB_API_KEY;
}

async function fhFetch(path: string): Promise<unknown> {
  const key = getApiKey();
  if (!key) throw new Error("FINNHUB_API_KEY not configured");

  const url = `${BASE_URL}${path}${path.includes("?") ? "&" : "?"}token=${key}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Finnhub API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isFinnhubAvailable(): boolean {
  return !!getApiKey();
}

/** Returns the curated list of well-known stock/ETF symbols. */
export function getKnownStockSymbols(): string[] {
  return [...KNOWN_STOCK_SYMBOLS];
}

/**
 * Fetch a stock/ETF quote and return it as a MarketOverview.
 * Works for ANY valid US ticker, not just the known list.
 */
export async function fetchStockQuote(symbol: string): Promise<MarketOverview | null> {
  try {
    const data = (await fhFetch(`/quote?symbol=${encodeURIComponent(symbol.toUpperCase())}`)) as {
      c: number;  // current price
      d: number;  // change
      dp: number; // percent change
      h: number;  // high of the day
      l: number;  // low of the day
      o: number;  // open
      pc: number; // previous close
    };

    // Finnhub returns c=0 for invalid tickers
    if (!data.c || data.c === 0) return null;

    return {
      symbol: symbol.toUpperCase(),
      market: "stock",
      price: data.c,
      change24h: data.d,
      changePercent24h: data.dp,
      volume24h: 0, // Quote endpoint doesn't include volume
      high24h: data.h,
      low24h: data.l,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch OHLCV candles for a stock/ETF.
 */
export async function fetchStockCandles(
  symbol: string,
  interval: CandleInterval = "1h",
  limit = 100
): Promise<Candle[]> {
  const resolution = intervalToFinnhubResolution(interval);
  const { from, to } = getTimeRange(interval, limit);

  try {
    const data = (await fhFetch(
      `/stock/candle?symbol=${encodeURIComponent(symbol.toUpperCase())}&resolution=${resolution}&from=${from}&to=${to}`
    )) as {
      s: string;      // status: "ok" or "no_data"
      o?: number[];    // open
      h?: number[];    // high
      l?: number[];    // low
      c?: number[];    // close
      v?: number[];    // volume
      t?: number[];    // timestamps (unix seconds)
    };

    if (data.s !== "ok" || !data.t || !data.o || !data.h || !data.l || !data.c) return [];

    const candles: Candle[] = [];
    const count = Math.min(data.t.length, limit);
    const startIdx = Math.max(0, data.t.length - count);

    for (let i = startIdx; i < data.t.length; i++) {
      candles.push({
        symbol: symbol.toUpperCase(),
        market: "stock",
        timestamp: data.t[i] * 1000, // Convert to ms
        open: data.o[i],
        high: data.h![i],
        low: data.l![i],
        close: data.c[i],
        volume: data.v?.[i] ?? 0,
        interval,
      });
    }

    return candles;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function intervalToFinnhubResolution(interval: CandleInterval): string {
  switch (interval) {
    case "1m": return "1";
    case "5m": return "5";
    case "15m": return "15";
    case "30m": return "30";
    case "1h": return "60";
    case "4h": return "60"; // No 4h resolution — use 1h candles
    case "1d": return "D";
    default: return "60";
  }
}

function getTimeRange(interval: CandleInterval, limit: number): { from: number; to: number } {
  const now = Math.floor(Date.now() / 1000);
  // Estimate how far back we need to go based on interval + limit
  const intervalSeconds: Record<CandleInterval, number> = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 3600, // Using 1h resolution
    "1d": 86400,
  };
  const lookback = (intervalSeconds[interval] ?? 3600) * limit * 1.5; // 1.5x for market hours gaps
  return { from: Math.floor(now - lookback), to: now };
}
