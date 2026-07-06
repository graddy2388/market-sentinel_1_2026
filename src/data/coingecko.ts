import type { Tick, Candle, CandleInterval, MarketOverview } from "./types.js";
import { cache } from "./cache.js";

const BASE_URL = "https://api.coingecko.com/api/v3";

const SYMBOL_TO_ID: Record<string, string> = {
  // Top-tier
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  BNB: "binancecoin",
  ADA: "cardano",
  DOGE: "dogecoin",
  DOT: "polkadot",
  AVAX: "avalanche-2",
  LINK: "chainlink",
  MATIC: "matic-network",
  LTC: "litecoin",
  ATOM: "cosmos",
  UNI: "uniswap",
  SHIB: "shiba-inu",

  // Layer 1s / Layer 2s
  HBAR: "hedera-hashgraph",
  NEAR: "near",
  APT: "aptos",
  SUI: "sui",
  SEI: "sei-network",
  FTM: "fantom",
  ARB: "arbitrum",
  OP: "optimism",
  INJ: "injective-protocol",
  TIA: "celestia",
  ALGO: "algorand",
  ICP: "internet-computer",
  FIL: "filecoin",
  VET: "vechain",
  HYPE: "hyperliquid",
  XLM: "stellar",
  TRX: "tron",
  TON: "the-open-network",

  // DeFi / Infrastructure
  AAVE: "aave",
  MKR: "maker",
  CRV: "curve-dao-token",
  RENDER: "render-token",
  FET: "fetch-ai",
  GRT: "the-graph",
  IMX: "immutable-x",
  STX: "blockstack",
  RUNE: "thorchain",

  // Memecoins
  PEPE: "pepe",
  WIF: "dogwifcoin",
  BONK: "bonk",
  FLOKI: "floki",

  // Exchange tokens
  CRO: "crypto-com-chain",
  OKB: "okb",
  LEO: "leo-token",

  // Stablecoins (for reference / portfolio tracking)
  USDT: "tether",
  USDC: "usd-coin",
};

function getCoingeckoId(symbol: string): string | null {
  return SYMBOL_TO_ID[symbol.toUpperCase()] ?? null;
}

async function cgFetch(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(`CoinGecko API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchPrice(symbol: string): Promise<Tick | null> {
  const id = getCoingeckoId(symbol);
  if (!id) return null;
  try {
    const data = (await cgFetch(
      `/simple/price?ids=${id}&vs_currencies=usd&include_24hr_vol=true`
    )) as Record<string, { usd: number; usd_24h_vol: number }>;
    const info = data[id];
    if (!info) return null;
    return {
      symbol: symbol.toUpperCase(),
      market: "crypto",
      price: info.usd,
      volume: info.usd_24h_vol,
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function fetch24hr(symbol: string): Promise<MarketOverview | null> {
  const id = getCoingeckoId(symbol);
  if (!id) return null;
  try {
    const data = (await cgFetch(`/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`)) as {
      market_data: {
        current_price: { usd: number };
        price_change_24h: number;
        price_change_percentage_24h: number;
        total_volume: { usd: number };
        high_24h: { usd: number };
        low_24h: { usd: number };
      };
    };
    const md = data.market_data;
    return {
      symbol: symbol.toUpperCase(),
      market: "crypto",
      price: md.current_price.usd,
      change24h: md.price_change_24h,
      changePercent24h: md.price_change_percentage_24h,
      volume24h: md.total_volume.usd,
      high24h: md.high_24h.usd,
      low24h: md.low_24h.usd,
    };
  } catch {
    return null;
  }
}

const INTERVAL_TO_DAYS: Record<CandleInterval, number> = {
  "1m": 1,
  "5m": 1,
  "15m": 1,
  "30m": 2,
  "1h": 7,
  "4h": 30,
  "1d": 90,
};

/**
 * Snap a candle spacing (ms) to the nearest known interval label.
 * CoinGecko's /ohlc endpoint IGNORES the requested interval and picks
 * granularity by day range (1-2d → 30m, 3-30d → 4h, 31d+ → 4d), so candles
 * must be labeled by what they actually are, not what was asked for —
 * otherwise indicator math and chart headers silently lie.
 */
export function snapIntervalFromSpacing(spacingMs: number): CandleInterval {
  const minutes = spacingMs / 60_000;
  const options: Array<[CandleInterval, number]> = [
    ["1m", 1], ["5m", 5], ["15m", 15], ["30m", 30], ["1h", 60], ["4h", 240], ["1d", 1440],
  ];
  let best: CandleInterval = "1h";
  let bestDiff = Infinity;
  for (const [label, mins] of options) {
    const diff = Math.abs(Math.log(minutes / mins)); // ratio distance
    if (diff < bestDiff) {
      bestDiff = diff;
      best = label;
    }
  }
  return best;
}

export async function fetchCandles(
  symbol: string,
  interval: CandleInterval = "1h",
  limit = 100
): Promise<Candle[]> {
  const id = getCoingeckoId(symbol);
  if (!id) return [];

  const days = INTERVAL_TO_DAYS[interval] ?? 2;
  try {
    const data = (await cgFetch(
      `/coins/${id}/ohlc?vs_currency=usd&days=${days}`
    )) as number[][];

    // Label candles by their ACTUAL granularity (see snapIntervalFromSpacing).
    const actualInterval =
      data.length >= 2 ? snapIntervalFromSpacing(data[1][0] - data[0][0]) : interval;

    return data.slice(-limit).map((k) => ({
      symbol: symbol.toUpperCase(),
      market: "crypto" as const,
      timestamp: k[0],
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      volume: 0,
      interval: actualInterval,
    }));
  } catch {
    return [];
  }
}

export function getSupportedSymbols(): string[] {
  return Object.keys(SYMBOL_TO_ID);
}

// --- Cached wrappers ---

/**
 * Returns 24h market data for a symbol, serving from the in-memory
 * cache when available (TTL 15 s) and falling back to a fresh fetch.
 */
export async function fetch24hrCached(
  symbol: string
): Promise<MarketOverview | null> {
  const cached = cache.getPrice(symbol);
  if (cached) return cached;

  const data = await fetch24hr(symbol);
  if (data) {
    cache.setPrice(symbol, data);
  }
  return data;
}

/**
 * Returns OHLC candle data for a symbol, serving from the in-memory
 * cache when available (TTL 60 s) and falling back to a fresh fetch.
 */
export async function fetchCandlesCached(
  symbol: string,
  interval: CandleInterval = "1h",
  limit = 100
): Promise<Candle[]> {
  const cached = cache.getCandles(symbol, interval);
  if (cached) {
    // Respect the caller's limit even when serving from cache
    return cached.slice(-limit);
  }

  const data = await fetchCandles(symbol, interval, limit);
  if (data.length > 0) {
    cache.setCandles(symbol, interval, data);
  }
  return data;
}
