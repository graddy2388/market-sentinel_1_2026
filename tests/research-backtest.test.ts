import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { rmSync } from "fs";
import type { Candle } from "../src/data/types.js";
import type { GradedSignal, SignalCall } from "../src/signals/scorer.js";

/**
 * Historical base rates. This grades the system's own past calls against what
 * price actually did, so the Research Agent can argue from measured hit rate
 * rather than vibes. The grading rules are what matter here: a bearish call is
 * "correct" when price FELL, and small moves count as neither win nor loss.
 */

const TEST_DB_PATH = vi.hoisted(() => {
  const dir = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return `${dir}/ms-backtest-${process.pid}-${Date.now()}.db`;
});

// Fixed clock so signal ages and the candle window line up deterministically.
const NOW = vi.hoisted(() => Date.UTC(2026, 0, 15, 12, 0, 0));
const HOUR = 3_600_000;

// Hourly candles covering NOW-72h .. NOW. Price is flat at 100 unless a test
// overrides a specific hour.
const candleOverrides = vi.hoisted(() => new Map<number, number>());

vi.mock("../src/data/providers.js", () => ({
  fetchCandlesCached: vi.fn(async (): Promise<Candle[]> => {
    const out: Candle[] = [];
    for (let h = 72; h >= 0; h--) {
      const ts = NOW - h * HOUR;
      out.push({
        symbol: "TEST", market: "crypto", timestamp: ts,
        open: 100, high: 100, low: 100,
        close: candleOverrides.get(ts) ?? 100,
        volume: 1, interval: "1h",
      });
    }
    return out;
  }),
  resolveMarket: vi.fn(async () => "crypto"),
}));

vi.mock("../src/config.js", () => ({
  hasAnyAI: () => true,
  DB_PATH: TEST_DB_PATH,
}));

let backtest: typeof import("../src/agents/research/backtest.js");
let store: typeof import("../src/signals/store.js");

beforeAll(async () => {
  backtest = await import("../src/agents/research/backtest.js");
  store = await import("../src/signals/store.js");
});

afterAll(() => {
  try { rmSync(TEST_DB_PATH, { force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  candleOverrides.clear();
});

function signal(call: SignalCall, hoursAgo: number, price = 100): GradedSignal {
  return {
    symbol: "TEST",
    call,
    conviction: 0.8,
    price,
    entry: price, stop: price * 0.97, target: price * 1.06,
    rationale: "test",
    components: { technical: "bullish", ai: "bullish", agreement: true },
    timestamp: NOW - hoursAgo * HOUR,
  };
}

/** Set the close 24h after a signal placed `hoursAgo`. */
function outcomeAfter(hoursAgo: number, close: number): void {
  candleOverrides.set(NOW - hoursAgo * HOUR + 24 * HOUR, close);
}

describe("backtestSymbol", () => {
  it("reports cleanly when there is no history", async () => {
    const result = await backtest.backtestSymbol("NOHIST");
    expect(result.totalSignals).toBe(0);
    expect(result.hitRate).toBeNull();
    expect(result.note).toContain("No prior signals");
  });

  it("grades a BUY correct when price rose", async () => {
    await store.insertSignal(signal("BUY", 48));
    outcomeAfter(48, 110); // +10%

    const result = await backtest.backtestSymbol("TEST");

    expect(result.graded).toBe(1);
    expect(result.hitRate).toBe(1);
    expect(result.recent[0].correct).toBe(true);
    expect(result.recent[0].changePercent).toBe(10);
  });

  it("grades a BUY incorrect when price fell", async () => {
    await store.insertSignal(signal("BUY", 47));
    outcomeAfter(47, 90); // -10%

    const result = await backtest.backtestSymbol("TEST");
    const graded = result.recent.find((r) => r.changePercent === -10);

    expect(graded?.correct).toBe(false);
  });

  it("grades a SELL correct when price FELL — direction is relative to the call", async () => {
    await store.insertSignal(signal("SELL", 46));
    outcomeAfter(46, 90);

    const result = await backtest.backtestSymbol("TEST");
    const graded = result.recent.find((r) => r.call === "SELL");

    expect(graded?.correct).toBe(true);
  });

  it("treats a small move as neither win nor loss", async () => {
    await store.insertSignal(signal("BUY", 45));
    outcomeAfter(45, 100.2); // +0.2%, under the 0.5% flat threshold

    const result = await backtest.backtestSymbol("TEST");
    const graded = result.recent.find((r) => r.changePercent === 0.2);

    expect(graded?.correct).toBeNull();
  });

  it("never grades HOLD — there is no directional claim to judge", async () => {
    await store.insertSignal(signal("HOLD", 44));
    outcomeAfter(44, 130);

    const result = await backtest.backtestSymbol("TEST");
    const held = result.recent.find((r) => r.call === "HOLD");

    expect(held?.correct).toBeNull();
  });

  it("leaves a signal ungraded when candles don't cover its outcome window", async () => {
    // 2h old: the +24h mark is in the future, past the end of the candle series.
    await store.insertSignal(signal("BUY", 2));

    const result = await backtest.backtestSymbol("TEST");
    const recent = result.recent.find((r) => Date.parse(r.at) === NOW - 2 * HOUR);

    expect(recent?.correct).toBeNull();
    expect(recent?.priceAfter).toBeNull();
  });

  it("reports the average move in the direction the call was betting on", async () => {
    // A correct SELL should contribute a POSITIVE result, not a negative one.
    await store.insertSignal(signal("SELL", 40));
    outcomeAfter(40, 90); // -10% price, +10% for the call

    const result = await backtest.backtestSymbol("TEST");

    expect(result.avgMovePercent).toBeGreaterThan(0);
  });

  it("breaks the hit rate down by call type", async () => {
    await store.insertSignal(signal("BUY", 36));
    outcomeAfter(36, 110);
    await store.insertSignal(signal("STRONG_BUY", 35));
    outcomeAfter(35, 90);

    const result = await backtest.backtestSymbol("TEST");

    expect(result.byCall.BUY).toBeDefined();
    expect(result.byCall.STRONG_BUY).toBeDefined();
    expect(result.byCall.STRONG_BUY.hitRate).toBe(0);
  });
});
