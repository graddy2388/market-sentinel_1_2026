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
  const HOUR = 3_600_000;
  const T0 = Date.UTC(2026, 8, 22, 13, 0, 0);
  const at = (minutes: number) => T0 + minutes * 60_000;

  it("posts the first actionable signal", () => {
    expect(store.hasSignalChanged(null, makeSignal({ timestamp: at(0) }))).toBe(true);
  });

  it("returns false for an identical signal", () => {
    expect(store.hasSignalChanged(makeSignal({ timestamp: at(0) }), makeSignal({ timestamp: at(90) }))).toBe(false);
  });

  it("returns false for a small conviction wiggle with the same call", () => {
    const prev = makeSignal({ call: "BUY", conviction: 0.5, timestamp: at(0) });
    const next = makeSignal({ call: "BUY", conviction: 0.55, timestamp: at(90) });
    expect(store.hasSignalChanged(prev, next)).toBe(false);
  });

  describe("HOLD is not news", () => {
    it("never reports a first-ever HOLD — there is nothing to act on", () => {
      expect(store.hasSignalChanged(null, makeSignal({ call: "HOLD", conviction: 0.1 }))).toBe(false);
    });

    it("ignores conviction movement within HOLD, however large or late", () => {
      const prev = makeSignal({ call: "HOLD", conviction: 0.26, timestamp: at(0) });
      const next = makeSignal({ call: "HOLD", conviction: 0, timestamp: at(300) });
      expect(store.hasSignalChanged(prev, next)).toBe(false);
    });
  });

  describe("repost cooldown", () => {
    it("holds back a same-side change inside the cooldown (the XRP STRONG BUY -> BUY -> STRONG BUY flap)", () => {
      const strong = makeSignal({ call: "STRONG_BUY", conviction: 0.81, timestamp: at(0) });
      const weaker = makeSignal({ call: "BUY", conviction: 0.61, timestamp: at(5) });
      const strongAgain = makeSignal({ call: "STRONG_BUY", conviction: 0.81, timestamp: at(7) });

      expect(store.hasSignalChanged(strong, weaker)).toBe(false);
      // Suppressed signals aren't persisted, so the next comparison is still
      // against the 9:07 post — and it's unchanged.
      expect(store.hasSignalChanged(strong, strongAgain)).toBe(false);
    });

    it("posts a call change once the cooldown has passed", () => {
      const prev = makeSignal({ call: "BUY", timestamp: at(0) });
      const next = makeSignal({ call: "STRONG_BUY", conviction: 0.75, timestamp: T0 + store.MIN_REPOST_INTERVAL_MS });
      expect(store.hasSignalChanged(prev, next)).toBe(true);
    });

    it("posts a large conviction move once the cooldown has passed", () => {
      const prev = makeSignal({ call: "BUY", conviction: 0.4, timestamp: at(0) });
      const early = makeSignal({ call: "BUY", conviction: 0.6, timestamp: at(30) });
      const late = makeSignal({ call: "BUY", conviction: 0.6, timestamp: T0 + HOUR });
      expect(store.hasSignalChanged(prev, early)).toBe(false);
      expect(store.hasSignalChanged(prev, late)).toBe(true);
    });

    it("reports an actionable call dropping to HOLD, after the cooldown", () => {
      const prev = makeSignal({ call: "BUY", conviction: 0.4, timestamp: at(0) });
      expect(store.hasSignalChanged(prev, makeSignal({ call: "HOLD", conviction: 0.2, timestamp: at(10) }))).toBe(false);
      expect(store.hasSignalChanged(prev, makeSignal({ call: "HOLD", conviction: 0.2, timestamp: T0 + HOUR }))).toBe(true);
    });

    it("reports HOLD becoming actionable, after the cooldown", () => {
      const prev = makeSignal({ call: "HOLD", conviction: 0.2, timestamp: at(0) });
      const next = makeSignal({ call: "BUY", conviction: 0.35, timestamp: T0 + HOUR });
      expect(store.hasSignalChanged(prev, next)).toBe(true);
    });
  });

  describe("direction flips bypass the cooldown", () => {
    it("posts BUY -> SELL immediately", () => {
      const prev = makeSignal({ call: "BUY", conviction: 0.5, timestamp: at(0) });
      const next = makeSignal({ call: "SELL", conviction: 0.4, timestamp: at(3) });
      expect(store.hasSignalChanged(prev, next)).toBe(true);
    });

    it("posts STRONG_SELL -> STRONG_BUY immediately", () => {
      const prev = makeSignal({ call: "STRONG_SELL", conviction: 0.8, timestamp: at(0) });
      const next = makeSignal({ call: "STRONG_BUY", conviction: 0.8, timestamp: at(1) });
      expect(store.hasSignalChanged(prev, next)).toBe(true);
    });
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
