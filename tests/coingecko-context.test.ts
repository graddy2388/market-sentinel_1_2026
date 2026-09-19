import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchCoinContext,
  resolveCoinId,
  _resetDynamicCache,
  CoinGeckoError,
} from "../src/data/coingecko.js";

/**
 * CoinGecko coin context under rate limiting.
 *
 * Keyless CoinGecko allows ~3 calls before answering 429 for a minute. Coins
 * not on Binance route everything through it, so research used to come back
 * empty — and the failure was swallowed, so the bot blamed the coin for being
 * obscure. These pin down: the key is sent, 429s are distinguishable from
 * "not a coin", and a recent good copy is served instead of nothing.
 */

const realFetch = globalThis.fetch;
const originalKey = process.env.COINGECKO_API_KEY;

const coinPayload = {
  name: "Venice Token",
  categories: ["Artificial Intelligence (AI)", "Base Ecosystem"],
  description: { en: "Private AI." },
  market_cap_rank: 69,
  market_data: {
    market_cap: { usd: 1_177_850_182 },
    circulating_supply: 1, total_supply: 2, max_supply: null,
    ath: { usd: 20 }, ath_change_percentage: { usd: -15.9 }, atl: { usd: 1 },
  },
};

function respond(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, statusText: status === 429 ? "Too Many Requests" : "OK", json: async () => body };
}

/** Routes /search and /coins/{id}; returns the mock so calls can be inspected. */
function mockCoinGecko(opts: { coinStatus?: number; searchStatus?: number } = {}) {
  const fn = vi.fn(async (url: string) => {
    if (url.includes("/search")) {
      return respond(opts.searchStatus ?? 200, {
        coins: [{ id: "venice-token", symbol: "VVV", name: "Venice Token", market_cap_rank: 69 }],
      });
    }
    return respond(opts.coinStatus ?? 200, coinPayload);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  _resetDynamicCache();
  delete process.env.COINGECKO_API_KEY;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (originalKey === undefined) delete process.env.COINGECKO_API_KEY;
  else process.env.COINGECKO_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe("API key", () => {
  it("sends the demo key header when COINGECKO_API_KEY is set", async () => {
    process.env.COINGECKO_API_KEY = "CG-test";
    const fetchMock = mockCoinGecko();

    await fetchCoinContext("VVV");

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers["x-cg-demo-api-key"]).toBe("CG-test");
  });

  it("sends no key header when unset", async () => {
    const fetchMock = mockCoinGecko();

    await fetchCoinContext("VVV");

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers["x-cg-demo-api-key"]).toBeUndefined();
  });
});

describe("fetchCoinContext", () => {
  it("returns context for a ranked coin", async () => {
    mockCoinGecko();

    const ctx = await fetchCoinContext("VVV");

    expect(ctx?.name).toBe("Venice Token");
    expect(ctx?.categories).toContain("Base Ecosystem");
  });

  it("returns null — not an error — for a symbol that isn't a ranked coin", async () => {
    globalThis.fetch = vi.fn(async () => respond(200, { coins: [] })) as unknown as typeof fetch;

    expect(await fetchCoinContext("NOTACOIN")).toBeNull();
  });

  it("throws on a rate limit so callers can say 'couldn't look' instead of 'nothing there'", async () => {
    mockCoinGecko({ coinStatus: 429 });

    const err = await fetchCoinContext("VVV").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CoinGeckoError);
    expect((err as CoinGeckoError).status).toBe(429);
    // Keyless: the message names the fix.
    expect((err as Error).message).toContain("COINGECKO_API_KEY");
  });

  it("also throws when the symbol lookup itself is rate limited", async () => {
    mockCoinGecko({ searchStatus: 429 });

    await expect(fetchCoinContext("VVV")).rejects.toBeInstanceOf(CoinGeckoError);
  });

  it("caches, so repeat research doesn't spend the rate budget", async () => {
    const fetchMock = mockCoinGecko();

    await fetchCoinContext("VVV");
    const callsAfterFirst = fetchMock.mock.calls.length;
    await fetchCoinContext("VVV");

    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("serves a recent cached copy when a refresh is rate limited", async () => {
    mockCoinGecko();
    const first = await fetchCoinContext("VVV");

    // Past the fresh TTL, so it tries to refresh — and gets 429.
    const later = Date.now() + 20 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    mockCoinGecko({ coinStatus: 429 });

    const ctx = await fetchCoinContext("VVV");

    expect(ctx?.name).toBe("Venice Token");
    expect(ctx?.fetchedAt).toBe(first?.fetchedAt);
  });

  it("does not serve a copy older than the stale limit", async () => {
    mockCoinGecko();
    await fetchCoinContext("VVV");

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 7 * 3_600_000);
    mockCoinGecko({ coinStatus: 429 });

    await expect(fetchCoinContext("VVV")).rejects.toBeInstanceOf(CoinGeckoError);
  });
});

describe("resolveCoinId keeps its lenient contract", () => {
  it("still returns null on a rate limit rather than throwing", async () => {
    mockCoinGecko({ searchStatus: 429 });

    expect(await resolveCoinId("VVV")).toBeNull();
  });
});
