import type { MarketOverview, Candle, CandleInterval } from "./types.js";

/** Default TTLs in milliseconds */
const PRICE_TTL_MS = 15_000; // 15 seconds
const CANDLE_TTL_MS = 60_000; // 60 seconds

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class PriceCache {
  private prices = new Map<string, CacheEntry<MarketOverview>>();
  private candles = new Map<string, CacheEntry<Candle[]>>();

  private readonly priceTtl: number;
  private readonly candleTtl: number;

  constructor(priceTtlMs = PRICE_TTL_MS, candleTtlMs = CANDLE_TTL_MS) {
    this.priceTtl = priceTtlMs;
    this.candleTtl = candleTtlMs;
  }

  // --- Price (MarketOverview) cache ---

  getPrice(symbol: string): MarketOverview | null {
    const key = symbol.toUpperCase();
    const entry = this.prices.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.priceTtl) {
      this.prices.delete(key);
      return null;
    }
    return entry.data;
  }

  setPrice(symbol: string, data: MarketOverview): void {
    this.prices.set(symbol.toUpperCase(), {
      data,
      timestamp: Date.now(),
    });
  }

  // --- Candle cache ---

  private candleKey(symbol: string, interval: CandleInterval): string {
    return `${symbol.toUpperCase()}:${interval}`;
  }

  getCandles(symbol: string, interval: CandleInterval): Candle[] | null {
    const key = this.candleKey(symbol, interval);
    const entry = this.candles.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.candleTtl) {
      this.candles.delete(key);
      return null;
    }
    return entry.data;
  }

  setCandles(symbol: string, interval: CandleInterval, data: Candle[]): void {
    const key = this.candleKey(symbol, interval);
    this.candles.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  // --- Utilities ---

  clear(): void {
    this.prices.clear();
    this.candles.clear();
  }

  /** Number of cached entries (prices + candle sets) */
  get size(): number {
    return this.prices.size + this.candles.size;
  }
}

/** Singleton cache instance used across the application */
export const cache = new PriceCache();
