import { describe, it, expect, vi } from "vitest";
import type { GradedSignal } from "../src/signals/scorer.js";

/**
 * What the channel actually sees. Two past failures live here: HOLD posts
 * printed fictional (even inverted) levels, and $1-$10 prices rounded to two
 * decimals made distinct levels print identically.
 */

vi.mock("../src/ai/council.js", () => ({ getActiveModelNames: () => [] }));
vi.mock("../src/data/providers.js", () => ({
  getCryptoSymbols: () => [],
  getStockSymbols: () => [],
}));
vi.mock("../src/data/finnhub.js", () => ({ isFinnhubAvailable: () => false }));

const { signalEmbed } = await import("../src/interfaces/discord/embeds.js");

function signal(overrides: Partial<GradedSignal> = {}): GradedSignal {
  return {
    symbol: "XRP", call: "STRONG_BUY", conviction: 0.81, price: 1.5781,
    entry: 1.5781, stop: 1.53, target: 1.6504,
    rationale: "test",
    components: { technical: "bullish", ai: "bullish", agreement: true },
    timestamp: Date.now(),
    ...overrides,
  };
}

function fields(s: GradedSignal): Record<string, string> {
  const json = signalEmbed(s).toJSON();
  return Object.fromEntries((json.fields ?? []).map((f) => [f.name, f.value]));
}

describe("signalEmbed", () => {
  it("prints $1-$10 levels to four decimals, with the dollar sign", () => {
    const f = fields(signal());
    expect(f.Entry).toBe("$1.5781");
    expect(f.Stop).toBe("$1.5300");
    expect(f.Target).toBe("$1.6504");
  });

  it("keeps levels a fraction of a cent apart distinguishable", () => {
    const f = fields(signal({ entry: 1.5849, stop: 1.5759 }));
    expect(f.Entry).not.toBe(f.Stop);
  });

  it("formats large prices with separators and two decimals", () => {
    const f = fields(signal({ symbol: "BTC", price: 65432.1, entry: 65432.1, stop: 64000, target: 68000 }));
    expect(f.Entry).toBe("$65,432.10");
  });

  it("formats sub-dollar prices to four significant figures", () => {
    const f = fields(signal({ symbol: "DOGE", price: 0.123456, entry: 0.123456, stop: 0.12, target: 0.13 }));
    expect(f.Entry).toBe("$0.1235");
  });

  it("shows no entry/stop/target for a HOLD", () => {
    const f = fields(signal({ call: "HOLD", conviction: 0.1, stop: 1.6, target: 1.5 }));
    expect(f.Entry).toBeUndefined();
    expect(f.Stop).toBeUndefined();
    expect(f.Target).toBeUndefined();
    expect(f.Levels).toContain("no trade");
  });
});
