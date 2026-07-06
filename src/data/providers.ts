import {
  fetchPrice as cgFetchPrice,
  fetch24hr as cgFetch24hr,
  fetchCandles as cgFetchCandles,
  getSupportedSymbols as cgGetSupportedSymbols,
} from "./coingecko.js";
import {
  fetchBinance24hr,
  fetchBinanceKlines,
  fetchBinancePrice,
} from "./binance.js";
import {
  isFinnhubAvailable,
  getKnownStockSymbols,
  fetchStockQuote,
  fetchStockCandles,
} from "./finnhub.js";
import { cache } from "./cache.js";
import type { Tick, MarketOverview, Candle, CandleInterval, MarketType } from "./types.js";

// ---------------------------------------------------------------------------
// Crypto data sourcing — Binance first, CoinGecko fallback.
//
// Binance public REST is preferred because it is faster, keyless, generous on
// rate limits, and — critically — serves EXACT candle intervals with real
// volume. CoinGecko's /ohlc endpoint auto-picks granularity by day range
// (e.g. days=7 returns 4-HOUR candles regardless of the requested interval),
// which silently mislabels candles and breaks indicator math. CoinGecko
// remains the fallback for symbols without a Binance USDT pair (e.g. LEO,
// stablecoins).
// ---------------------------------------------------------------------------

async function cryptoFetch24hr(symbol: string): Promise<MarketOverview | null> {
  const b = await fetchBinance24hr(symbol);
  if (b) {
    return {
      symbol,
      market: "crypto",
      price: b.price,
      change24h: b.change,
      changePercent24h: b.changePercent,
      volume24h: b.quoteVolume, // USD-denominated, matches CoinGecko semantics
      high24h: b.high,
      low24h: b.low,
    };
  }
  return cgFetch24hr(symbol);
}

async function cryptoFetchCandles(
  symbol: string,
  interval: CandleInterval,
  limit: number
): Promise<Candle[]> {
  const klines = await fetchBinanceKlines(symbol, interval, limit);
  if (klines.length > 0) return klines;
  return cgFetchCandles(symbol, interval, limit);
}

// ---------------------------------------------------------------------------
// Symbol classification
// ---------------------------------------------------------------------------

/**
 * Determine which market a symbol belongs to.
 * - Known CoinGecko symbols → "crypto"
 * - Everything else when Finnhub is available → "stock" (includes commodity ETFs)
 * - If nothing matches → null
 */
export function classifySymbol(symbol: string): MarketType | null {
  const upper = symbol.toUpperCase();
  if (cgGetSupportedSymbols().includes(upper)) return "crypto";
  if (isFinnhubAvailable()) return "stock";
  return null;
}

/**
 * Returns all symbols the system knows about, grouped by market.
 * Crypto symbols are always listed. Stock symbols only appear
 * when FINNHUB_API_KEY is configured.
 */
export function getSupportedSymbols(): string[] {
  const symbols = [...cgGetSupportedSymbols()];
  if (isFinnhubAvailable()) {
    symbols.push(...getKnownStockSymbols());
  }
  return symbols;
}

/** Returns only the known crypto symbols. */
export function getCryptoSymbols(): string[] {
  return cgGetSupportedSymbols();
}

/** Returns only the known stock/ETF symbols (empty if Finnhub not configured). */
export function getStockSymbols(): string[] {
  return isFinnhubAvailable() ? getKnownStockSymbols() : [];
}

// ---------------------------------------------------------------------------
// Unified fetch — routes to the right provider
// ---------------------------------------------------------------------------

/**
 * Fetch 24h market overview for any supported symbol.
 * Crypto → Binance (CoinGecko fallback), stocks/ETFs → Finnhub.
 */
export async function fetch24hr(symbol: string): Promise<MarketOverview | null> {
  const upper = symbol.toUpperCase();

  if (cgGetSupportedSymbols().includes(upper)) {
    return cryptoFetch24hr(upper);
  }

  // Try stock/ETF via Finnhub
  if (isFinnhubAvailable()) {
    return fetchStockQuote(upper);
  }

  return null;
}

/**
 * Fetch 24h market data with caching (TTL 15s via the shared PriceCache).
 */
export async function fetch24hrCached(symbol: string): Promise<MarketOverview | null> {
  const upper = symbol.toUpperCase();

  const cached = cache.getPrice(upper);
  if (cached) return cached;

  const data = await fetch24hr(upper);
  if (data) {
    cache.setPrice(upper, data);
  }
  return data;
}

/**
 * Fetch OHLCV candles for any supported symbol.
 */
export async function fetchCandles(
  symbol: string,
  interval: CandleInterval = "1h",
  limit = 100
): Promise<Candle[]> {
  const upper = symbol.toUpperCase();

  if (cgGetSupportedSymbols().includes(upper)) {
    return cryptoFetchCandles(upper, interval, limit);
  }

  if (isFinnhubAvailable()) {
    return fetchStockCandles(upper, interval, limit);
  }

  return [];
}

/**
 * Fetch candles with caching (TTL 60s).
 * Only serves from cache when the cached set can satisfy the requested limit;
 * otherwise refetches (and falls back to the stale cache if the fetch fails).
 */
export async function fetchCandlesCached(
  symbol: string,
  interval: CandleInterval = "1h",
  limit = 100
): Promise<Candle[]> {
  const upper = symbol.toUpperCase();

  const cached = cache.getCandles(upper, interval);
  if (cached && cached.length >= limit) {
    return cached.slice(-limit);
  }

  const data = await fetchCandles(upper, interval, limit);
  if (data.length > 0) {
    cache.setCandles(upper, interval, data);
    return data;
  }
  // Fetch failed — serve whatever the cache still holds rather than nothing.
  return cached ? cached.slice(-limit) : [];
}

/**
 * Fetch current price tick for any symbol.
 */
export async function fetchPrice(symbol: string): Promise<Tick | null> {
  const upper = symbol.toUpperCase();

  if (cgGetSupportedSymbols().includes(upper)) {
    const tick = await fetchBinancePrice(upper);
    if (tick) return tick;
    return cgFetchPrice(upper);
  }

  // For stocks, derive a Tick from the quote
  if (isFinnhubAvailable()) {
    const quote = await fetchStockQuote(upper);
    if (!quote) return null;
    return {
      symbol: upper,
      market: "stock",
      price: quote.price,
      volume: quote.volume24h,
      timestamp: Date.now(),
    };
  }

  return null;
}

/**
 * Check if a symbol can be resolved to any data source.
 * For unknown tickers, tries Finnhub if available.
 */
export async function isSymbolAvailable(symbol: string): Promise<boolean> {
  const upper = symbol.toUpperCase();
  if (cgGetSupportedSymbols().includes(upper)) return true;
  if (getKnownStockSymbols().includes(upper)) return true;

  // Unknown ticker — try a live lookup via Finnhub
  if (isFinnhubAvailable()) {
    const quote = await fetchStockQuote(upper);
    return quote !== null;
  }

  return false;
}
