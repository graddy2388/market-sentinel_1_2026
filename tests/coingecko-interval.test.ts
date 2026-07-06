import { describe, it, expect } from "vitest";
import { snapIntervalFromSpacing } from "../src/data/coingecko.js";

const MIN = 60_000;

describe("snapIntervalFromSpacing", () => {
  it("labels CoinGecko's 30-minute granularity honestly", () => {
    expect(snapIntervalFromSpacing(30 * MIN)).toBe("30m");
  });

  it("labels CoinGecko's 4-hour granularity honestly", () => {
    expect(snapIntervalFromSpacing(240 * MIN)).toBe("4h");
  });

  it("labels 4-day granularity as the nearest known interval (1d)", () => {
    expect(snapIntervalFromSpacing(4 * 1440 * MIN)).toBe("1d");
  });

  it("labels exact standard intervals", () => {
    expect(snapIntervalFromSpacing(1 * MIN)).toBe("1m");
    expect(snapIntervalFromSpacing(5 * MIN)).toBe("5m");
    expect(snapIntervalFromSpacing(15 * MIN)).toBe("15m");
    expect(snapIntervalFromSpacing(60 * MIN)).toBe("1h");
    expect(snapIntervalFromSpacing(1440 * MIN)).toBe("1d");
  });

  it("snaps slightly-irregular spacing to the nearest interval", () => {
    expect(snapIntervalFromSpacing(58 * MIN)).toBe("1h");
    expect(snapIntervalFromSpacing(33 * MIN)).toBe("30m");
  });
});
