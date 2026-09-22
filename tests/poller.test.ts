import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Background price poller.
 *
 * Two past failures: the symbol list was captured at startup (adds and
 * removals ignored until a restart), and a CoinGecko-only coin polled every
 * 15s burned the whole keyless CoinGecko budget by itself.
 */

const fetch24hrMock = vi.fn(async (symbol: string) => ({
  symbol, market: "crypto", price: 1, change24h: 0, changePercent24h: 0,
  volume24h: 1, high24h: 1, low24h: 1,
}));
const sources = new Map<string, "binance" | "coingecko">();

vi.mock("../src/data/providers.js", () => ({
  fetch24hr: (s: string) => fetch24hrMock(s),
  getCryptoSource: (s: string) => sources.get(s.toUpperCase()),
}));

const { startPoller, stopPoller, pollOnce, isDueForPoll } = await import("../src/data/poller.js");

let symbols: string[] = [];

function polledSymbols(): string[] {
  return fetch24hrMock.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  fetch24hrMock.mockClear();
  sources.clear();
  symbols = [];
});

afterEach(() => {
  stopPoller();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Start the poller, then wait out its immediate first cycle. */
async function start(): Promise<void> {
  startPoller(async () => symbols);
  await vi.waitFor(() => expect(fetch24hrMock).toHaveBeenCalled());
  fetch24hrMock.mockClear();
}

describe("dynamic watchlist", () => {
  it("picks up a symbol added after startup", async () => {
    symbols = ["BTC"];
    await start();

    symbols = ["BTC", "SOL"];
    await pollOnce();

    expect(polledSymbols()).toEqual(["BTC", "SOL"]);
  });

  it("stops polling a symbol once it's removed", async () => {
    symbols = ["BTC", "XRP"];
    await start();

    symbols = ["BTC"];
    await pollOnce();

    expect(polledSymbols()).toEqual(["BTC"]);
  });

  it("survives a failure reading the symbol list", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    startPoller(async () => {
      throw new Error("db locked");
    });

    await expect(pollOnce()).resolves.toBeUndefined();
    expect(fetch24hrMock).not.toHaveBeenCalled();
  });
});

describe("CoinGecko budget", () => {
  it("polls Binance-backed symbols every cycle", async () => {
    sources.set("BTC", "binance");
    symbols = ["BTC"];
    await start();

    await pollOnce();
    await pollOnce();

    expect(polledSymbols()).toEqual(["BTC", "BTC"]);
  });

  it("stops polling a coin once it's known to come from CoinGecko (the VVV case)", async () => {
    // A 15s poll of one CoinGecko coin would spend ~86k calls/month against a
    // 10k free budget. They're fetched on demand instead.
    sources.set("VVV", "coingecko");
    symbols = ["VVV", "BTC"];
    sources.set("BTC", "binance");
    await start();

    await pollOnce();
    await pollOnce();

    expect(polledSymbols()).toEqual(["BTC", "BTC"]);
  });

  it("polls a never-fetched symbol once, which is how its source is learned", () => {
    expect(isDueForPoll("NEW")).toBe(true);
    sources.set("NEW", "coingecko");
    expect(isDueForPoll("NEW")).toBe(false);
  });
});
