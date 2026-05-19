import { describe, it, expect } from "vitest";
import { renderChart } from "../src/charts/renderer.js";
import type { Candle } from "../src/data/types.js";

function makeCandle(i: number, base = 100): Candle {
  const price = base + Math.sin(i * 0.5) * 10;
  return {
    symbol: "TEST",
    market: "crypto",
    timestamp: Date.now() - (100 - i) * 3600_000,
    open: price - 1,
    high: price + 2,
    low: price - 3,
    close: price + 0.5,
    volume: 1000 + i * 100,
    interval: "1h",
  };
}

describe("renderChart", () => {
  it("throws with fewer than 5 candles", async () => {
    const candles = [makeCandle(0), makeCandle(1), makeCandle(2), makeCandle(3)];
    await expect(renderChart(candles, "TEST")).rejects.toThrow("Need at least 5 candles");
  });

  it("renders with exactly 5 candles", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const buffer = await renderChart(candles, "TEST");
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    // PNG magic bytes
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50); // P
    expect(buffer[2]).toBe(0x4e); // N
    expect(buffer[3]).toBe(0x47); // G
  });

  it("renders with 100 candles and optional params", async () => {
    const candles = Array.from({ length: 100 }, (_, i) => makeCandle(i));
    const buffer = await renderChart(candles, "BTC", 105.5, 3.14);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(100); // Non-trivial PNG
  });

  it("renders with negative 24h change", async () => {
    const candles = Array.from({ length: 20 }, (_, i) => makeCandle(i, 50000));
    const buffer = await renderChart(candles, "BTC", 48000, -4.2);
    expect(buffer).toBeInstanceOf(Buffer);
  });

  it("handles very small prices (sub-penny tokens)", async () => {
    const candles = Array.from({ length: 10 }, (_, i) => ({
      ...makeCandle(i),
      open: 0.000012 + i * 0.000001,
      high: 0.000015 + i * 0.000001,
      low: 0.000010 + i * 0.000001,
      close: 0.000013 + i * 0.000001,
    }));
    const buffer = await renderChart(candles, "SHIB");
    expect(buffer).toBeInstanceOf(Buffer);
  });

  it("handles flat price (no range)", async () => {
    const candles = Array.from({ length: 10 }, (_, i) => ({
      ...makeCandle(i),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
    }));
    const buffer = await renderChart(candles, "FLAT");
    expect(buffer).toBeInstanceOf(Buffer);
  });
});
