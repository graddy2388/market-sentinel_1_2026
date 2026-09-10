/**
 * Finnhub news, fundamentals, and analyst data — the Research Agent's
 * primary source for stocks/ETFs.
 *
 * Several of these endpoints are premium on Finnhub's free tier. Each call
 * degrades independently (returns null/[] and records why) rather than failing
 * the whole research pass, so a partial answer is still useful and the agent
 * can say which sources were unavailable.
 */
import { appConfig } from "../config.js";

const BASE_URL = "https://finnhub.io/api/v1";
const REQUEST_TIMEOUT_MS = 10_000;

/** Cap on articles returned per lookup — keeps prompts bounded. */
const MAX_ARTICLES = 8;

function getApiKey(): string | undefined {
  return appConfig.FINNHUB_API_KEY;
}

export function isNewsAvailable(): boolean {
  return !!getApiKey();
}

export interface NewsArticle {
  headline: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
}

export interface AnalystRecommendation {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export interface CompanyFundamentals {
  peRatio: number | null;
  marketCap: number | null;
  week52High: number | null;
  week52Low: number | null;
  revenueGrowth: number | null;
  profitMargin: number | null;
}

/**
 * Fetch a Finnhub endpoint. Returns null on any failure (including premium
 * gating) so callers can degrade rather than throw.
 */
async function fhFetch<T>(path: string): Promise<T | null> {
  const key = getApiKey();
  if (!key) return null;

  const url = `${BASE_URL}${path}${path.includes("?") ? "&" : "?"}token=${key}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 403 typically means the endpoint is premium-only on this plan.
      console.warn(`[FinnhubNews] ${path.split("?")[0]} -> ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(
      `[FinnhubNews] ${path.split("?")[0]} failed:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function isoDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

interface RawArticle {
  headline?: string;
  summary?: string;
  source?: string;
  url?: string;
  datetime?: number;
}

function normalizeArticles(raw: RawArticle[] | null): NewsArticle[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a.headline)
    .slice(0, MAX_ARTICLES)
    .map((a) => ({
      headline: a.headline ?? "",
      // Long summaries blow up the research prompt for little added signal.
      summary: (a.summary ?? "").slice(0, 400),
      source: a.source ?? "unknown",
      url: a.url ?? "",
      publishedAt: a.datetime
        ? new Date(a.datetime * 1000).toISOString()
        : new Date().toISOString(),
    }));
}

/** Recent company news for a stock/ETF ticker. */
export async function fetchCompanyNews(symbol: string, lookbackDays = 7): Promise<NewsArticle[]> {
  const raw = await fhFetch<RawArticle[]>(
    `/company-news?symbol=${encodeURIComponent(symbol.toUpperCase())}` +
      `&from=${isoDate(lookbackDays)}&to=${isoDate(0)}`
  );
  return normalizeArticles(raw);
}

/**
 * General market news by category. "crypto" is the useful one here — Finnhub's
 * per-symbol news does not cover crypto tickers.
 */
export async function fetchMarketNews(
  category: "general" | "crypto" | "forex" | "merger" = "general"
): Promise<NewsArticle[]> {
  const raw = await fhFetch<RawArticle[]>(`/news?category=${category}`);
  return normalizeArticles(raw);
}

/** Analyst recommendation distribution (most recent period first). */
export async function fetchRecommendations(symbol: string): Promise<AnalystRecommendation | null> {
  const raw = await fhFetch<
    Array<{
      period?: string;
      strongBuy?: number;
      buy?: number;
      hold?: number;
      sell?: number;
      strongSell?: number;
    }>
  >(`/stock/recommendation?symbol=${encodeURIComponent(symbol.toUpperCase())}`);

  const latest = Array.isArray(raw) ? raw[0] : null;
  if (!latest) return null;

  return {
    period: latest.period ?? "unknown",
    strongBuy: latest.strongBuy ?? 0,
    buy: latest.buy ?? 0,
    hold: latest.hold ?? 0,
    sell: latest.sell ?? 0,
    strongSell: latest.strongSell ?? 0,
  };
}

/** Core fundamental metrics. Premium on some plans — returns null if gated. */
export async function fetchFundamentals(symbol: string): Promise<CompanyFundamentals | null> {
  const raw = await fhFetch<{ metric?: Record<string, number | null> }>(
    `/stock/metric?symbol=${encodeURIComponent(symbol.toUpperCase())}&metric=all`
  );
  const m = raw?.metric;
  if (!m) return null;

  return {
    peRatio: m.peTTM ?? null,
    marketCap: m.marketCapitalization ?? null,
    week52High: m["52WeekHigh"] ?? null,
    week52Low: m["52WeekLow"] ?? null,
    revenueGrowth: m.revenueGrowthTTMYoy ?? null,
    profitMargin: m.netProfitMarginTTM ?? null,
  };
}

/**
 * Upcoming earnings within the lookahead window.
 *
 * This one matters for safety, not just context: an imminent earnings event is
 * grounds for the Research Agent to veto a trade outright, since technicals
 * carry little predictive weight across an earnings gap.
 */
export async function fetchUpcomingEarnings(
  symbol: string,
  lookaheadDays = 7
): Promise<{ date: string; hour: string } | null> {
  const raw = await fhFetch<{ earningsCalendar?: Array<{ date?: string; hour?: string }> }>(
    `/calendar/earnings?from=${isoDate(0)}&to=${isoDate(-lookaheadDays)}` +
      `&symbol=${encodeURIComponent(symbol.toUpperCase())}`
  );
  const next = raw?.earningsCalendar?.[0];
  if (!next?.date) return null;
  return { date: next.date, hour: next.hour ?? "unknown" };
}
