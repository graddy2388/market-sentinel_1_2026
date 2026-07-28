import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveCoinId, _resetDynamicCache, getDiscoveredSymbols } from "../src/data/coingecko.js";

/**
 * Dynamic symbol resolution. The curated map covers ~51 majors; CoinGecko lists
 * ~18,000 coins. Ticker collisions are rampant (many unrelated tokens share a
 * symbol), so resolution must pick the legitimate coin — not whichever copycat
 * happens to come back first.
 */

const realFetch = globalThis.fetch;

function mockSearch(coins: Array<{ id: string; symbol: string; name?: string; market_cap_rank: number | null }>) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ coins }),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  _resetDynamicCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("resolveCoinId", () => {
  it("resolves curated symbols without any network call", async () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error("should not hit the network for curated symbols");
    }) as unknown as typeof fetch;

    expect(await resolveCoinId("BTC")).toBe("bitcoin");
    expect(await resolveCoinId("eth")).toBe("ethereum");
  });

  it("resolves an uncurated symbol via ranked search (the VVV case)", async () => {
    mockSearch([
      { id: "venice-token", symbol: "VVV", name: "Venice Token", market_cap_rank: 87 },
      { id: "iiii-lovvv-youuuu", symbol: "ILY", name: "unrelated", market_cap_rank: 5246 },
    ]);

    expect(await resolveCoinId("VVV")).toBe("venice-token");
  });

  it("picks the highest-ranked coin when tickers collide", async () => {
    mockSearch([
      { id: "scam-copycat", symbol: "PENGU", name: "Fake Pengu", market_cap_rank: 9001 },
      { id: "pudgy-penguins", symbol: "PENGU", name: "Pudgy Penguins", market_cap_rank: 62 },
      { id: "another-fake", symbol: "PENGU", name: "Also Fake", market_cap_rank: 4000 },
    ]);

    expect(await resolveCoinId("PENGU")).toBe("pudgy-penguins");
  });

  it("ignores unranked coins — they are usually copycats squatting a ticker", async () => {
    mockSearch([
      { id: "unranked-squatter", symbol: "BTC2", name: "Squatter", market_cap_rank: null },
    ]);

    expect(await resolveCoinId("BTC2")).toBeNull();
  });

  it("ignores near-miss symbols (must be an exact ticker match)", async () => {
    // Search is fuzzy — a query for "VVV" can return coins whose NAME matches.
    mockSearch([
      { id: "vvv-adjacent", symbol: "VVVX", name: "VVV Adjacent", market_cap_rank: 100 },
    ]);

    expect(await resolveCoinId("VVV")).toBeNull();
  });

  it("caches a hit so repeat lookups make no further requests", async () => {
    mockSearch([{ id: "venice-token", symbol: "VVV", market_cap_rank: 87 }]);

    await resolveCoinId("VVV");
    await resolveCoinId("VVV");
    await resolveCoinId("vvv");

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("caches a miss so junk tickers are not re-queried", async () => {
    mockSearch([]);

    expect(await resolveCoinId("ZZQQXY")).toBeNull();
    expect(await resolveCoinId("ZZQQXY")).toBeNull();

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("does NOT cache transient failures — a rate limit must not blacklist a real coin", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    expect(await resolveCoinId("VVV")).toBeNull();

    // The coin becomes resolvable once the rate limit clears.
    mockSearch([{ id: "venice-token", symbol: "VVV", market_cap_rank: 87 }]);
    expect(await resolveCoinId("VVV")).toBe("venice-token");
  });

  it("tracks dynamically discovered symbols", async () => {
    mockSearch([{ id: "venice-token", symbol: "VVV", market_cap_rank: 87 }]);
    await resolveCoinId("VVV");

    expect(getDiscoveredSymbols()).toContain("VVV");
  });
});
