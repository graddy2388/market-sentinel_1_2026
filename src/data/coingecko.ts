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

// ---------------------------------------------------------------------------
// Dynamic symbol resolution
//
// The curated map above covers the majors, but CoinGecko lists ~18,000 coins.
// Anything outside the map (e.g. VVV / Venice Token, mcap rank ~87) would
// otherwise be unreachable. For unknown symbols we query CoinGecko's /search,
// which returns candidates with a market_cap_rank.
//
// Ticker collisions are rampant — many unrelated tokens share a symbol — so we
// only accept an EXACT symbol match that carries a market_cap_rank, and pick
// the highest-ranked one. Requiring a rank filters out the long tail of
// unranked copycat tokens that would otherwise hijack a well-known ticker.
// ---------------------------------------------------------------------------

/** Cached resolutions. `null` = confirmed not a coin (negative cache). */
const dynamicIdCache = new Map<string, string | null>();

/** Symbols resolved dynamically this process, for symbol-detection purposes. */
const discoveredSymbols = new Set<string>();

interface SearchCoin {
  id: string;
  symbol: string;
  name: string;
  market_cap_rank: number | null;
}

/**
 * Resolve a ticker to a CoinGecko id: curated map first (no network call),
 * then a ranked /search lookup. Results are cached, including misses.
 */
export async function resolveCoinId(symbol: string): Promise<string | null> {
  try {
    return await lookupCoinId(symbol);
  } catch {
    // Don't cache transient failures — a rate limit shouldn't permanently
    // blacklist a real coin.
    return null;
  }
}

/**
 * Like resolveCoinId, but throws on transient failure instead of returning
 * null, so callers can tell "not a coin" apart from "couldn't look".
 */
async function lookupCoinId(symbol: string): Promise<string | null> {
  const upper = symbol.toUpperCase();

  const curated = SYMBOL_TO_ID[upper];
  if (curated) return curated;

  if (dynamicIdCache.has(upper)) return dynamicIdCache.get(upper)!;

  const data = (await cgFetch(`/search?query=${encodeURIComponent(upper)}`)) as {
    coins?: SearchCoin[];
  };
  const ranked = (data.coins ?? [])
    .filter((c) => c.symbol?.toUpperCase() === upper && c.market_cap_rank != null)
    .sort((a, b) => (a.market_cap_rank ?? Infinity) - (b.market_cap_rank ?? Infinity));

  const id = ranked[0]?.id ?? null;
  dynamicIdCache.set(upper, id);
  if (id) discoveredSymbols.add(upper);
  return id;
}

/** Symbols resolved dynamically so far (used to widen symbol detection). */
export function getDiscoveredSymbols(): string[] {
  return [...discoveredSymbols];
}

/** Test helper: clear dynamic resolution state. */
export function _resetDynamicCache(): void {
  dynamicIdCache.clear();
  discoveredSymbols.clear();
  coinContextCache.clear();
  // Pacing state too: a test that fakes the clock would otherwise leave a
  // pause set hours ahead for everything after it.
  lastRequestAt = 0;
  pausedUntil = 0;
  usage.month = "";
  usage.calls = 0;
  usage.warned = false;
}

// ---------------------------------------------------------------------------
// Transport
//
// Coins without a Binance pair (VVV and most small caps) get their price,
// candles, and research context here, so this is the scarcest budget we have:
//
//   - Keyless: no monthly cap, but only a few calls per minute before a 429
//     with Retry-After: 60. Bursts are what kill it, not volume.
//   - Free Demo key: 100 calls/min but only 10,000 per MONTH, which continuous
//     polling of even one coin would exhaust. Paid plans start at $29/mo.
//
// Both are burst-sensitive and one is volume-sensitive, so every request goes
// through a single queue with a minimum gap between calls, and a 429 pauses the
// queue for everyone. Callers with a cached copy serve that instead.
// ---------------------------------------------------------------------------

/** Read at call time so dotenv has already populated the environment. */
function apiKey(): string | undefined {
  return process.env.COINGECKO_API_KEY || undefined;
}

/**
 * Minimum gap between requests, adapted at runtime.
 *
 * CoinGecko's keyless limit is dynamic and undocumented: measured live, even
 * 10 requests/min drew a 429 on the 5th. So the gap starts here, grows by half
 * after every rate limit, and eases back while requests succeed.
 */
const DEFAULT_GAP_MS = 8_000;
const MAX_GAP_MS = 60_000;
let baseGapMs = DEFAULT_GAP_MS;
let minRequestGapMs = DEFAULT_GAP_MS;
/** How long a 429 stops all CoinGecko traffic (their Retry-After is 60s). */
let rateLimitPauseMs = 60_000;
/** A queued request that has waited longer than this fails instead of piling up. */
let maxQueueWaitMs = 30_000;

/** Current gap between requests, in ms. Grows while CoinGecko is rate-limiting us. */
export function getCoinGeckoGapMs(): number {
  return minRequestGapMs;
}

/** Test hook for pacing constants; also clears queue state. */
export function _setCoinGeckoPacing(opts: { gapMs?: number; pauseMs?: number; maxWaitMs?: number }): void {
  if (opts.gapMs !== undefined) {
    baseGapMs = opts.gapMs;
    minRequestGapMs = opts.gapMs;
  }
  if (opts.pauseMs !== undefined) rateLimitPauseMs = opts.pauseMs;
  if (opts.maxWaitMs !== undefined) maxQueueWaitMs = opts.maxWaitMs;
  lastRequestAt = 0;
  pausedUntil = 0;
}

let requestChain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
let pausedUntil = 0;

/**
 * The Demo plan's 10,000 calls/month is a cliff: go past it and every request
 * fails until the month rolls over. Counting in-process (so it resets with the
 * container) is enough to see the trend in logs and warn before the cliff.
 */
const MONTHLY_CALL_BUDGET = 10_000;
const usage = { month: "", calls: 0, warned: false };

/** Calls made this calendar month, counted since the process started. */
export function getCoinGeckoUsage(): { month: string; calls: number; budget: number } {
  return { month: usage.month, calls: usage.calls, budget: MONTHLY_CALL_BUDGET };
}

function countCall(): void {
  const month = new Date().toISOString().slice(0, 7);
  if (usage.month !== month) {
    usage.month = month;
    usage.calls = 0;
    usage.warned = false;
  }
  usage.calls++;
  if (!usage.warned && usage.calls >= MONTHLY_CALL_BUDGET * 0.8) {
    usage.warned = true;
    console.warn(
      `[CoinGecko] ${usage.calls} calls this month, against a ${MONTHLY_CALL_BUDGET} Demo-plan cap. ` +
        "Drop a coin that isn't on Binance from the watchlist, or CoinGecko data will stop until next month."
    );
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run a request in the shared queue, spaced out and paused after a 429. */
function schedule<T>(run: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  const result = requestChain.then(async () => {
    const now = Date.now();
    if (now - queuedAt > maxQueueWaitMs) {
      throw new CoinGeckoError(429, "CoinGecko request queue is backed up — skipped rather than pile on");
    }
    // Clamped: a clock jump (or a system clock change) must not park the queue
    // for hours on a stale lastRequestAt.
    const wait = Math.min(
      Math.max(pausedUntil - now, lastRequestAt + minRequestGapMs - now, 0),
      Math.max(minRequestGapMs, rateLimitPauseMs)
    );
    if (wait > 0) await delay(wait);
    lastRequestAt = Date.now();
    countCall();
    const result = await run();
    // It went through: ease back toward the base pace.
    minRequestGapMs = Math.max(baseGapMs, Math.round(minRequestGapMs * 0.9));
    return result;
  });
  // Keep the chain alive regardless of outcome.
  requestChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** A failed CoinGecko request. The message is written to be shown to a user. */
export class CoinGeckoError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "CoinGeckoError";
  }
}

/** Throttles the rate-limit warning so a polling loop can't flood the logs. */
let lastRateLimitWarning = 0;

function cgFetch(path: string): Promise<unknown> {
  return schedule(async () => {
    const key = apiKey();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (key) headers["x-cg-demo-api-key"] = key;

    const res = await fetch(`${BASE_URL}${path}`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      if (res.status === 429) {
        // Stop everyone, not just this caller: the limit is per IP.
        const retryAfter = Number(res.headers.get("retry-after"));
        const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : rateLimitPauseMs;
        pausedUntil = Date.now() + pause;
        // And go slower from here: their limit is lower than we assumed.
        minRequestGapMs = Math.min(MAX_GAP_MS, Math.max(baseGapMs, Math.round(minRequestGapMs * 1.5)));

        const message = key
          ? `CoinGecko rate limit hit — the per-minute limit, or the Demo plan's 10,000/month cap (${usage.calls} calls counted since startup); pausing ${Math.round(pause / 1000)}s`
          : `CoinGecko rate limit hit (no COINGECKO_API_KEY set — keyless allows only a few calls per minute); pausing ${Math.round(pause / 1000)}s`;
        if (Date.now() - lastRateLimitWarning > 60_000) {
          lastRateLimitWarning = Date.now();
          console.warn(`[CoinGecko] ${message}`);
        }
        throw new CoinGeckoError(429, message);
      }
      throw new CoinGeckoError(res.status, `CoinGecko API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  });
}

export async function fetchPrice(symbol: string): Promise<Tick | null> {
  const id = await resolveCoinId(symbol);
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
  const id = await resolveCoinId(symbol);
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

// CoinGecko's /ohlc picks granularity from the day range: 1-2d → 30m,
// 3-30d → 4h, 31d+ → 4d. Request the widest range that still yields the
// granularity we want, so indicators have enough history — days=7 returned
// only ~42 candles, too few for even SMA(50). days=30 yields ~180.
const INTERVAL_TO_DAYS: Record<CandleInterval, number> = {
  "1m": 1,
  "5m": 1,
  "15m": 1,
  "30m": 2,
  "1h": 30,
  "4h": 30,
  "1d": 180,
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
  const id = await resolveCoinId(symbol);
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

// ---------------------------------------------------------------------------
// Crypto-native research context
//
// fetch24hr() deliberately suppresses community/developer data to keep the hot
// path small. The Research Agent wants exactly that suppressed material —
// supply structure, distance from all-time high, developer activity, and
// category — which Finnhub does not cover for crypto at all.
// ---------------------------------------------------------------------------

export interface CoinContext {
  symbol: string;
  name: string;
  marketCapRank: number | null;
  marketCapUsd: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  athUsd: number | null;
  percentFromAth: number | null;
  atlUsd: number | null;
  categories: string[];
  description: string | null;
  developer: { stars: number | null; forks: number | null; commits4Weeks: number | null } | null;
  community: { twitterFollowers: number | null; redditSubscribers: number | null } | null;
  /** When this was fetched. Older than a few minutes means it was served stale. */
  fetchedAt?: number;
}

/** Rank, supply, and categories barely move minute to minute. */
const COIN_CONTEXT_TTL_MS = 10 * 60_000;
/** On a failed refresh, a copy this recent still beats reporting nothing. */
const COIN_CONTEXT_STALE_LIMIT_MS = 6 * 3_600_000;

const coinContextCache = new Map<string, CoinContext>();

/**
 * Crypto-native context for a coin.
 *
 * Returns null when the symbol isn't a ranked CoinGecko coin. Throws a
 * CoinGeckoError when CoinGecko can't be reached (rate limit, outage) and no
 * usable cached copy exists — so callers can tell "nothing to find" apart
 * from "couldn't look".
 */
export async function fetchCoinContext(symbol: string): Promise<CoinContext | null> {
  const upper = symbol.toUpperCase();
  const cached = coinContextCache.get(upper);
  const cachedAge = cached?.fetchedAt != null ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && cachedAge < COIN_CONTEXT_TTL_MS) return cached;

  try {
    const id = await lookupCoinId(upper);
    if (!id) return null;

    const context = await fetchCoinContextById(upper, id);
    coinContextCache.set(upper, context);
    return context;
  } catch (err) {
    if (cached && cachedAge < COIN_CONTEXT_STALE_LIMIT_MS) return cached;
    throw err;
  }
}

async function fetchCoinContextById(symbol: string, id: string): Promise<CoinContext> {
  const data = (await cgFetch(
    `/coins/${id}?localization=false&tickers=false&market_data=true` +
      `&community_data=true&developer_data=true&sparkline=false`
  )) as {
    name?: string;
    categories?: (string | null)[];
    description?: { en?: string };
    market_cap_rank?: number;
    market_data?: {
      market_cap?: { usd?: number };
      circulating_supply?: number;
      total_supply?: number;
      max_supply?: number;
      ath?: { usd?: number };
      ath_change_percentage?: { usd?: number };
      atl?: { usd?: number };
    };
    developer_data?: { stars?: number; forks?: number; commit_count_4_weeks?: number };
    community_data?: { twitter_followers?: number; reddit_subscribers?: number };
  };

  const md = data.market_data;
  const dev = data.developer_data;
  const com = data.community_data;

  return {
    symbol: symbol.toUpperCase(),
    name: data.name ?? symbol.toUpperCase(),
    marketCapRank: data.market_cap_rank ?? null,
    marketCapUsd: md?.market_cap?.usd ?? null,
    circulatingSupply: md?.circulating_supply ?? null,
    totalSupply: md?.total_supply ?? null,
    maxSupply: md?.max_supply ?? null,
    athUsd: md?.ath?.usd ?? null,
    percentFromAth: md?.ath_change_percentage?.usd ?? null,
    atlUsd: md?.atl?.usd ?? null,
    categories: (data.categories ?? []).filter((c): c is string => !!c).slice(0, 6),
    // Descriptions can run to many paragraphs of marketing copy.
    description: data.description?.en ? data.description.en.slice(0, 600) : null,
    developer: dev
      ? {
          stars: dev.stars ?? null,
          forks: dev.forks ?? null,
          commits4Weeks: dev.commit_count_4_weeks ?? null,
        }
      : null,
    community: com
      ? {
          twitterFollowers: com.twitter_followers ?? null,
          redditSubscribers: com.reddit_subscribers ?? null,
        }
      : null,
    fetchedAt: Date.now(),
  };
}
