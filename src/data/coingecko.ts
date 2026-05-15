import type { Tick, Candle, CandleInterval, MarketOverview } from "./types.js";

const BASE_URL = "https://api.coingecko.com/api/v3";

const SYMBOL_TO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  ADA: "cardano",
  DOT: "polkadot",
  AVAX: "avalanche-2",
  MATIC: "matic-network",
  LINK: "chainlink",
  DOGE: "dogecoin",
  XRP: "ripple",
  BNB: "binancecoin",
  LTC: "litecoin",
  ATOM: "cosmos",
  UNI: "uniswap",
  SHIB: "shiba-inu",
};

function getCoingeckoId(symbol: string): string | null {
  return SYMBOL_TO_ID[symbol.toUpperCase()] ?? null;
}

async function cgFetch(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Accept: "application/json" },
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
  "1h": 7,
  "4h": 30,
  "1d": 90,
};

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

    return data.slice(-limit).map((k) => ({
      symbol: symbol.toUpperCase(),
      market: "crypto" as const,
      timestamp: k[0],
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      volume: 0,
      interval,
    }));
  } catch {
    return [];
  }
}

export function getSupportedSymbols(): string[] {
  return Object.keys(SYMBOL_TO_ID);
}
