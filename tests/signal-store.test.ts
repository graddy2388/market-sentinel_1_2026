import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import type { GradedSignal } from "../src/signals/scorer.js";

// Use a throwaway DB so tests never touch the real ~/.market-sentinel data.
// DB_PATH is read from process.env at config-import time, so set it BEFORE
// dynamically importing the store (which transitively imports config/db).
const TEST_DB = join(tmpdir(), `ms-signal-store-${process.pid}-${Date.now()}.db`);

// Loaded dynamically in beforeAll once the env is set.
let store: typeof import("../src/signals/store.js");

function makeSignal(overrides: Partial<GradedSignal> = {}): GradedSignal {
  return {
    symbol: "BTC",
    call: "BUY",
    conviction: 0.5,
    price: 100,
    entry: 100,
    stop: 97,
    target: 106,
    rationale: "test",
    components: { technical: "bullish", ai: "bullish", agreement: true },
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeAll(async () => {
  process.env.DB_PATH = TEST_DB;
  store = await import("../src/signals/store.js");
});

afterAll(() => {
  try {
    rmSync(TEST_DB, { force: true });
  } catch {
    // best effort
  }
});

describe("hasSignalChanged", () => {
  it("returns true for the first signal (no prior)", () => {
    expect(store.hasSignalChanged(null, makeSignal())).toBe(true);
  });

  it("returns true when the call changes", () => {
    const prev = makeSignal({ call: "BUY" });
    const next = makeSignal({ call: "STRONG_BUY" });
    expect(store.hasSignalChanged(prev, next)).toBe(true);
  });

  it("returns true when conviction moves more than the threshold", () => {
    const prev = makeSignal({ call: "BUY", conviction: 0.4 });
    const next = makeSignal({ call: "BUY", conviction: 0.6 });
    expect(store.hasSignalChanged(prev, next)).toBe(true);
  });

  it("returns false for a small conviction wiggle with the same call", () => {
    const prev = makeSignal({ call: "BUY", conviction: 0.5 });
    const next = makeSignal({ call: "BUY", conviction: 0.55 });
    expect(store.hasSignalChanged(prev, next)).toBe(false);
  });

  it("returns false for an identical signal", () => {
    const prev = makeSignal();
    const next = makeSignal();
    expect(store.hasSignalChanged(prev, next)).toBe(false);
  });
});

describe("insertSignal / getLatestSignal (DB round-trip)", () => {
  it("returns null when there is no signal for a symbol", async () => {
    expect(await store.getLatestSignal("NOSUCH")).toBeNull();
  });

  it("persists and reads back the latest signal", async () => {
    const sig = makeSignal({ symbol: "ETH", call: "STRONG_BUY", conviction: 0.82 });
    await store.insertSignal(sig);
    const latest = await store.getLatestSignal("ETH");
    expect(latest).not.toBeNull();
    expect(latest!.call).toBe("STRONG_BUY");
    expect(latest!.conviction).toBeCloseTo(0.82, 5);
    expect(latest!.components.technical).toBe("bullish");
  });

  it("returns the most recent signal when several exist", async () => {
    await store.insertSignal(makeSignal({ symbol: "SOL", call: "BUY", timestamp: Date.now() }));
    // Ensure a strictly later ISO timestamp for ordering.
    await new Promise((r) => setTimeout(r, 5));
    await store.insertSignal(makeSignal({ symbol: "SOL", call: "SELL", timestamp: Date.now() + 1000 }));
    const latest = await store.getLatestSignal("SOL");
    expect(latest!.call).toBe("SELL");
  });

  it("is case-insensitive on symbol lookup", async () => {
    await store.insertSignal(makeSignal({ symbol: "ADA", call: "HOLD" }));
    const latest = await store.getLatestSignal("ada");
    expect(latest).not.toBeNull();
    expect(latest!.call).toBe("HOLD");
  });

  it("getAllLatestSignals returns one row per symbol", async () => {
    const all = await store.getAllLatestSignals();
    const symbols = all.map((s) => s.symbol).sort();
    // ETH, SOL, ADA were inserted above (BTC only used in pure-fn tests).
    expect(symbols).toContain("ETH");
    expect(symbols).toContain("SOL");
    expect(symbols).toContain("ADA");
    // No duplicates
    expect(new Set(symbols).size).toBe(symbols.length);
  });
});
