import { describe, it, expect } from "vitest";
import {
  symbolSchema,
  intervalSchema,
  candlesSchema,
  marketSchema,
  quantitySchema,
  priceSchema,
  thresholdSchema,
  descriptionSchema,
  notesSchema,
} from "../src/validation.js";

describe("symbolSchema", () => {
  it("accepts valid symbols and uppercases them", () => {
    expect(symbolSchema.parse("btc")).toBe("BTC");
    expect(symbolSchema.parse("ETH")).toBe("ETH");
    expect(symbolSchema.parse("Solana")).toBe("SOLANA");
  });

  it("rejects empty string", () => {
    expect(() => symbolSchema.parse("")).toThrow();
  });

  it("rejects symbols longer than 10 chars", () => {
    expect(() => symbolSchema.parse("ABCDEFGHIJK")).toThrow();
  });

  it("rejects symbols with numbers", () => {
    expect(() => symbolSchema.parse("BTC2")).toThrow();
  });

  it("rejects symbols with special characters", () => {
    expect(() => symbolSchema.parse("BTC/USD")).toThrow();
    expect(() => symbolSchema.parse("BTC-PERP")).toThrow();
    expect(() => symbolSchema.parse("BTC USD")).toThrow();
  });

  it("rejects non-string types", () => {
    expect(() => symbolSchema.parse(123)).toThrow();
    expect(() => symbolSchema.parse(null)).toThrow();
    expect(() => symbolSchema.parse(undefined)).toThrow();
  });
});

describe("intervalSchema", () => {
  it("accepts valid intervals", () => {
    expect(intervalSchema.parse("1m")).toBe("1m");
    expect(intervalSchema.parse("5m")).toBe("5m");
    expect(intervalSchema.parse("15m")).toBe("15m");
    expect(intervalSchema.parse("30m")).toBe("30m");
    expect(intervalSchema.parse("1h")).toBe("1h");
    expect(intervalSchema.parse("4h")).toBe("4h");
    expect(intervalSchema.parse("1d")).toBe("1d");
  });

  it("rejects invalid intervals", () => {
    expect(() => intervalSchema.parse("2h")).toThrow();
    expect(() => intervalSchema.parse("1w")).toThrow();
    expect(() => intervalSchema.parse("")).toThrow();
    expect(() => intervalSchema.parse("45m")).toThrow();
  });
});

describe("candlesSchema", () => {
  it("accepts valid candle counts", () => {
    expect(candlesSchema.parse("1")).toBe(1);
    expect(candlesSchema.parse("100")).toBe(100);
    expect(candlesSchema.parse("500")).toBe(500);
    expect(candlesSchema.parse(50)).toBe(50);
  });

  it("rejects 0", () => {
    expect(() => candlesSchema.parse("0")).toThrow();
    expect(() => candlesSchema.parse(0)).toThrow();
  });

  it("rejects values over 500", () => {
    expect(() => candlesSchema.parse("501")).toThrow();
    expect(() => candlesSchema.parse(1000)).toThrow();
  });

  it("rejects non-integers", () => {
    expect(() => candlesSchema.parse("3.5")).toThrow();
    expect(() => candlesSchema.parse(2.7)).toThrow();
  });

  it("rejects NaN-producing strings", () => {
    expect(() => candlesSchema.parse("abc")).toThrow();
    expect(() => candlesSchema.parse("")).toThrow();
  });

  it("rejects negative values", () => {
    expect(() => candlesSchema.parse("-1")).toThrow();
    expect(() => candlesSchema.parse(-5)).toThrow();
  });
});

describe("marketSchema", () => {
  it("accepts valid market types", () => {
    expect(marketSchema.parse("crypto")).toBe("crypto");
    expect(marketSchema.parse("stock")).toBe("stock");
    expect(marketSchema.parse("commodity")).toBe("commodity");
  });

  it("rejects invalid market types", () => {
    expect(() => marketSchema.parse("forex")).toThrow();
    expect(() => marketSchema.parse("Crypto")).toThrow();
    expect(() => marketSchema.parse("")).toThrow();
  });
});

describe("quantitySchema", () => {
  it("accepts valid positive quantities", () => {
    expect(quantitySchema.parse("0.5")).toBe(0.5);
    expect(quantitySchema.parse("100")).toBe(100);
    expect(quantitySchema.parse(1e10)).toBe(1e10);
  });

  it("rejects zero", () => {
    expect(() => quantitySchema.parse("0")).toThrow();
    expect(() => quantitySchema.parse(0)).toThrow();
  });

  it("rejects negative quantities", () => {
    expect(() => quantitySchema.parse("-1")).toThrow();
  });

  it("rejects values exceeding max", () => {
    expect(() => quantitySchema.parse(1e13)).toThrow();
  });
});

describe("priceSchema", () => {
  it("accepts valid prices", () => {
    expect(priceSchema.parse("0.01")).toBe(0.01);
    expect(priceSchema.parse("50000")).toBe(50000);
  });

  it("rejects zero and negative", () => {
    expect(() => priceSchema.parse("0")).toThrow();
    expect(() => priceSchema.parse("-100")).toThrow();
  });

  it("rejects values exceeding max", () => {
    expect(() => priceSchema.parse(2e12)).toThrow();
  });
});

describe("thresholdSchema", () => {
  it("accepts finite numbers including negatives", () => {
    expect(thresholdSchema.parse("-5")).toBe(-5);
    expect(thresholdSchema.parse("0")).toBe(0);
    expect(thresholdSchema.parse("100.5")).toBe(100.5);
  });

  it("rejects Infinity", () => {
    expect(() => thresholdSchema.parse(Infinity)).toThrow();
    expect(() => thresholdSchema.parse(-Infinity)).toThrow();
  });

  it("rejects NaN", () => {
    expect(() => thresholdSchema.parse(NaN)).toThrow();
  });
});

describe("descriptionSchema", () => {
  it("accepts valid descriptions", () => {
    expect(descriptionSchema.parse("Buy BTC at 60k")).toBe("Buy BTC at 60k");
  });

  it("rejects empty string", () => {
    expect(() => descriptionSchema.parse("")).toThrow();
  });

  it("rejects descriptions over 2000 chars", () => {
    const long = "a".repeat(2001);
    expect(() => descriptionSchema.parse(long)).toThrow();
  });

  it("accepts exactly 2000 chars", () => {
    const exact = "a".repeat(2000);
    expect(descriptionSchema.parse(exact)).toBe(exact);
  });
});

describe("notesSchema", () => {
  it("accepts undefined (optional)", () => {
    expect(notesSchema.parse(undefined)).toBeUndefined();
  });

  it("accepts valid notes", () => {
    expect(notesSchema.parse("DCA entry")).toBe("DCA entry");
  });

  it("rejects notes over 500 chars", () => {
    const long = "x".repeat(501);
    expect(() => notesSchema.parse(long)).toThrow();
  });
});
