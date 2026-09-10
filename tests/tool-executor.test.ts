import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { rmSync } from "fs";

// Hoisted so the mock factories below (which are hoisted above normal module
// scope) can reference the throwaway DB path.
const TEST_DB_PATH = vi.hoisted(() => {
  const dir = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return `${dir}/ms-tool-exec-${process.pid}-${Date.now()}.db`;
});

/**
 * Tool execution against a real (temporary) database.
 *
 * The headline case is manage_watchlist: before tools existed, the Discord
 * surface had no write path at all, so "add VVV to my daily briefing" produced
 * a confident confirmation backed by nothing. These tests assert the write
 * actually lands, and that model-supplied arguments are validated.
 */

// Network + AI are mocked; the DB is real.
vi.mock("../src/data/providers.js", () => ({
  fetch24hrCached: vi.fn(async (s: string) => ({
    symbol: s.toUpperCase(),
    market: "crypto",
    price: 13.26,
    change24h: 0.2,
    changePercent24h: 1.75,
    volume24h: 5_000_000,
    high24h: 13.5,
    low24h: 12.9,
  })),
  fetchCandlesCached: vi.fn(async () =>
    Array.from({ length: 60 }, (_, i) => ({
      symbol: "VVV",
      market: "crypto" as const,
      timestamp: i * 3600_000,
      open: 13, high: 13.5, low: 12.8, close: 13.2, volume: 1000,
      interval: "1h" as const,
    }))
  ),
  resolveMarket: vi.fn(async () => "crypto"),
}));
vi.mock("../src/ai/council.js", () => ({
  councilAnalyze: vi.fn(async () => ({
    symbol: "VVV", timestamp: Date.now(), votes: [], failed: [],
    majorityDirection: "neutral" as const,
    directionBreakdown: { bullish: 0, bearish: 0, neutral: 0 },
    avgConfidence: 0, disagreements: [], consensus: null,
  })),
}));
vi.mock("../src/charts/renderer.js", () => ({
  renderChart: vi.fn(async () => Buffer.from("png")),
}));
vi.mock("../src/config.js", () => ({
  hasAnyAI: () => true,
  // db.ts reads DB_PATH from config; point it at the throwaway database so
  // these tests never touch the real ~/.market-sentinel data.
  DB_PATH: TEST_DB_PATH,
}));

let executor: typeof import("../src/ai/tools/executor.js");
let watchlistSvc: typeof import("../src/state/watchlist.js");

beforeAll(async () => {
  executor = await import("../src/ai/tools/executor.js");
  watchlistSvc = await import("../src/state/watchlist.js");
});

afterAll(() => {
  try { rmSync(TEST_DB_PATH, { force: true }); } catch { /* best effort */ }
});

beforeEach(async () => {
  // Clear the watchlist between tests.
  for (const entry of await watchlistSvc.listWatchlist()) {
    await watchlistSvc.removeFromWatchlist(entry.symbol);
  }
});

describe("manage_watchlist", () => {
  it("actually persists an add — the bot cannot confirm without a write", async () => {
    const result = await executor.executeTool("manage_watchlist", {
      action: "add",
      symbol: "VVV",
    });

    expect(result.text).toContain('"added":true');

    // The real proof: the row exists in the database.
    const rows = await watchlistSvc.listWatchlist();
    expect(rows.map((r) => r.symbol)).toContain("VVV");
  });

  it("is idempotent — re-adding does not duplicate the row", async () => {
    await executor.executeTool("manage_watchlist", { action: "add", symbol: "VVV" });
    const second = await executor.executeTool("manage_watchlist", { action: "add", symbol: "VVV" });

    expect(second.text).toContain('"added":false');
    const rows = await watchlistSvc.listWatchlist();
    expect(rows.filter((r) => r.symbol === "VVV")).toHaveLength(1);
  });

  it("lists what is actually stored", async () => {
    await executor.executeTool("manage_watchlist", { action: "add", symbol: "BTC" });
    await executor.executeTool("manage_watchlist", { action: "add", symbol: "ETH" });

    const result = await executor.executeTool("manage_watchlist", { action: "list" });

    expect(result.text).toContain("BTC");
    expect(result.text).toContain("ETH");
    expect(result.text).toContain('"count":2');
  });

  it("removes a symbol", async () => {
    await executor.executeTool("manage_watchlist", { action: "add", symbol: "VVV" });
    const result = await executor.executeTool("manage_watchlist", { action: "remove", symbol: "VVV" });

    expect(result.text).toContain('"removed":true');
    expect(await watchlistSvc.listWatchlist()).toHaveLength(0);
  });

  it("reports honestly when removing something not on the list", async () => {
    const result = await executor.executeTool("manage_watchlist", { action: "remove", symbol: "DOGE" });
    expect(result.text).toContain('"removed":false');
  });

  it("rejects an invalid symbol from the model", async () => {
    const result = await executor.executeTool("manage_watchlist", {
      action: "add",
      symbol: "not a ticker!!",
    });

    expect(result.text).toContain("ERROR");
    expect(await watchlistSvc.listWatchlist()).toHaveLength(0);
  });

  it("rejects an unknown action", async () => {
    const result = await executor.executeTool("manage_watchlist", { action: "drop_table" });
    expect(result.text).toContain("ERROR");
  });
});

describe("get_market_data", () => {
  it("returns price and technicals", async () => {
    const result = await executor.executeTool("get_market_data", { symbol: "VVV" });
    const payload = JSON.parse(result.text);

    expect(payload.symbol).toBe("VVV");
    expect(payload.price).toBe(13.26);
    expect(payload.technicals).not.toBeNull();
  });

  it("rejects a missing symbol", async () => {
    const result = await executor.executeTool("get_market_data", {});
    expect(result.text).toContain("ERROR");
  });
});

describe("run_analysis", () => {
  it("returns council output and attaches a chart artifact", async () => {
    const result = await executor.executeTool("run_analysis", { symbol: "VVV" });

    expect(result.artifacts?.chart).toBeInstanceOf(Buffer);
    expect(result.artifacts?.symbol).toBe("VVV");
    const payload = JSON.parse(result.text);
    expect(payload.council).toBeDefined();
  });
});

describe("manage_alerts", () => {
  it("creates an alert", async () => {
    const result = await executor.executeTool("manage_alerts", {
      action: "set",
      symbol: "BTC",
      condition: "price_above",
      threshold: 70000,
    });

    expect(result.text).toContain('"created":true');

    const list = await executor.executeTool("manage_alerts", { action: "list" });
    expect(list.text).toContain("BTC");
  });

  it("rejects an invalid condition", async () => {
    const result = await executor.executeTool("manage_alerts", {
      action: "set",
      symbol: "BTC",
      condition: "price_sideways",
      threshold: 1,
    });
    expect(result.text).toContain("ERROR");
  });

  it("rejects a non-numeric threshold", async () => {
    const result = await executor.executeTool("manage_alerts", {
      action: "set",
      symbol: "BTC",
      condition: "price_above",
      threshold: "not a number",
    });
    expect(result.text).toContain("ERROR");
  });
});

describe("executeTool dispatch", () => {
  it("reports an unknown tool rather than throwing", async () => {
    const result = await executor.executeTool("delete_everything", {});
    expect(result.text).toContain("ERROR");
    expect(result.text).toContain("Unknown tool");
  });
});
