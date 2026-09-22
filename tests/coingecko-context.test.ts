import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchCoinContext,
  resolveCoinId,
  getCoinGeckoUsage,
  _resetDynamicCache,
  _setCoinGeckoPacing,
  getCoinGeckoGapMs,
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

function respond(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 429 ? "Too Many Requests" : "OK",
    headers: new Headers(headers),
    json: async () => body,
  };
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
  _setCoinGeckoPacing({ gapMs: 0, pauseMs: 0, maxWaitMs: 60_000 });
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
    // The message names the cause and what the system did — both reach the user.
    // Keyless, so it points at the missing key rather than the monthly cap.
    expect((err as Error).message).toContain("COINGECKO_API_KEY");
    expect((err as Error).message).toMatch(/pausing/);
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

describe("request queue — the real protection for a tiny free budget", () => {
  // Keyless CoinGecko 429s after a few calls in quick succession, and the free
  // Demo key allows only 10k calls a MONTH. Every request goes through one
  // paced queue so a burst can't happen.
  it("spaces requests out instead of firing them together", async () => {
    _setCoinGeckoPacing({ gapMs: 40, pauseMs: 0, maxWaitMs: 60_000 });
    const at: number[] = [];
    globalThis.fetch = vi.fn(async () => {
      at.push(Date.now());
      return respond(200, { coins: [] });
    }) as unknown as typeof fetch;

    await Promise.all(["AAA", "BBB", "CCC"].map((s) => resolveCoinId(s)));

    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(35);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(35);
  });

  it("a 429 pauses every caller, not just the one that hit it", async () => {
    _setCoinGeckoPacing({ gapMs: 0, pauseMs: 120, maxWaitMs: 60_000 });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return calls === 1
        ? { ok: false, status: 429, statusText: "Too Many Requests", headers: new Headers(), json: async () => ({}) }
        : respond(200, { coins: [] });
    }) as unknown as typeof fetch;

    await resolveCoinId("AAA"); // eats the 429
    const start = Date.now();
    await resolveCoinId("BBB"); // queued behind the pause

    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  it("honours Retry-After in preference to its own default", async () => {
    _setCoinGeckoPacing({ gapMs: 0, pauseMs: 5_000, maxWaitMs: 60_000 });
    globalThis.fetch = vi.fn(async () => respond(429, {}, { "retry-after": "1" })) as unknown as typeof fetch;

    await resolveCoinId("AAA"); // eats the 429, pauses for the server's 1s
    const start = Date.now();
    await resolveCoinId("BBB");
    const waited = Date.now() - start;

    expect(waited).toBeGreaterThanOrEqual(500); // it did wait
    expect(waited).toBeLessThan(3_000); // but 1s from the header, not the 5s default
  });

  it("drops a request that has been queued too long rather than piling on", async () => {
    _setCoinGeckoPacing({ gapMs: 60, pauseMs: 0, maxWaitMs: 1 });
    globalThis.fetch = vi.fn(async () => respond(200, { coins: [] })) as unknown as typeof fetch;

    const results = await Promise.allSettled(
      ["AAA", "BBB", "CCC", "DDD"].map((s) => fetchCoinContext(s))
    );

    expect(results.some((r) => r.status === "rejected")).toBe(true);
  });
});

describe("monthly usage counter", () => {
  // The Demo plan's cap is monthly and silent — hitting it stops every
  // CoinGecko request until the month rolls over, so the count must be visible.
  it("counts every request against the Demo-plan budget", async () => {
    globalThis.fetch = vi.fn(async () => respond(200, { coins: [] })) as unknown as typeof fetch;

    await resolveCoinId("AAA");
    await resolveCoinId("BBB");

    const usage = getCoinGeckoUsage();
    expect(usage.calls).toBe(2);
    expect(usage.budget).toBe(10_000);
    expect(usage.month).toBe(new Date().toISOString().slice(0, 7));
  });

  it("counts a rate-limited call too — it still spends budget", async () => {
    globalThis.fetch = vi.fn(async () => respond(429, {})) as unknown as typeof fetch;

    await resolveCoinId("AAA");

    expect(getCoinGeckoUsage().calls).toBe(1);
  });
});

describe("adaptive pacing", () => {
  // Live measurement: CoinGecko 429'd on the 5th request even at 10/min, so a
  // fixed gap can't be right. The pace backs off on a 429 and recovers after.
  it("slows down after a rate limit and eases back on success", async () => {
    _setCoinGeckoPacing({ gapMs: 20, pauseMs: 0, maxWaitMs: 60_000 });
    let limitNext = true;
    globalThis.fetch = vi.fn(async () => {
      const res = limitNext ? respond(429) : respond(200, { coins: [] });
      limitNext = false;
      return res;
    }) as unknown as typeof fetch;

    await resolveCoinId("AAA"); // eats the 429
    const afterLimit = getCoinGeckoGapMs();
    expect(afterLimit).toBeGreaterThan(20);

    for (let i = 0; i < 5; i++) await resolveCoinId(`OK${i}`);
    expect(getCoinGeckoGapMs()).toBeLessThan(afterLimit);
    expect(getCoinGeckoGapMs()).toBeGreaterThanOrEqual(20); // never faster than the base
  });
});

describe("a Demo key changes what the limit even is", () => {
  it("paces keyless requests slowly and keyed requests quickly", () => {
    // Keyless: a few calls/min, so go slow. Keyed: 100/min, and the real limit
    // becomes the 10k monthly cap, which call volume controls — not pacing.
    _setCoinGeckoPacing({ gapMs: null, pauseMs: 0, maxWaitMs: 60_000 });
    delete process.env.COINGECKO_API_KEY;
    const keyless = getCoinGeckoGapMs();

    process.env.COINGECKO_API_KEY = "CG-test";
    const keyed = getCoinGeckoGapMs();

    expect(keyless).toBeGreaterThan(keyed * 2);
    expect(keyed).toBeGreaterThan(0);
  });
});
