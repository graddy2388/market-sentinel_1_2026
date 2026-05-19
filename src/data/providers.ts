import {
  fetchPrice as cgFetchPrice,
  fetch24hr as cgFetch24hr,
  fetch24hrCached as cgFetch24hrCached,
  fetchCandles as cgFetchCandles,
  fetchCandlesCached as cgFetchCandlesCached,
  getSupportedSymbols as cgGetSupportedSymbols,
} from "./coingecko.js";
import {
  isFinnhubAvailable,
  getKnownStockSymbols,
  fetchStockQuote,
  fetchStockCandles,
} from "./finnhub.js";
import { cache } from "./cache.js";
import type { Tick, MarketOverview, Candle, CandleInterval, MarketType } from "./types.js";

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
 * Crypto → CoinGecko, stocks/ETFs → Finnhub.
 */
export async function fetch24hr(symbol: string): Promise<MarketOverview | null> {
  const upper = symbol.toUpperCase();

  // Try crypto first (known symbols)
  if (cgGetSupportedSymbols().includes(upper)) {
    return cgFetch24hr(upper);
  }

  // Try stock/ETF via Finnhub
  if (isFinnhubAvailable()) {
    return fetchStockQuote(upper);
  }

  return null;
}

/**
 * Fetch 24h market data with caching.
 * Uses the shared PriceCache for both crypto and stock data.
 */
export async function fetch24hrCached(symbol: string): Promise<MarketOverview | null> {
  const upper = symbol.toUpperCase();

  // Check cache first (works for all market types)
  const cached = cache.getPrice(upper);
  if (cached) return cached;

  // Route to the right provider
  if (cgGetSupportedSymbols().includes(upper)) {
    return cgFetch24hrCached(upper);
  }

  // Stock/ETF path
  if (isFinnhubAvailable()) {
    const data = await fetchStockQuote(upper);
    if (data) {
      cache.setPrice(upper, data);
    }
    return data;
  }

  return null;
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
    return cgFetchCandles(upper, interval, limit);
  }

  if (isFinnhubAvailable()) {
    return fetchStockCandles(upper, interval, limit);
  }

  return [];
}

/**
 * Fetch candles with caching.
 */
export async function fetchCandlesCached(
  symbol: string,
  interval: CandleInterval = "1h",
  limit = 100
): Promise<Candle[]> {
  const upper = symbol.toUpperCase();

  // Check cache first
  const cached = cache.getCandles(upper, interval);
  if (cached) return cached.slice(-limit);

  // Route to the right provider
  if (cgGetSupportedSymbols().includes(upper)) {
    return cgFetchCandlesCached(upper, interval, limit);
  }

  // Stock/ETF path
  if (isFinnhubAvailable()) {
    const data = await fetchStockCandles(upper, interval, limit);
    if (data.length > 0) {
      cache.setCandles(upper, interval, data);
    }
    return data;
  }

  return [];
}

/**
 * Fetch current price tick for any symbol.
 */
export async function fetchPrice(symbol: string): Promise<Tick | null> {
  const upper = symbol.toUpperCase();

  if (cgGetSupportedSymbols().includes(upper)) {
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
