import { describe, it, expect } from "vitest";
import { detectQuestionDepth } from "../src/interfaces/discord/chat.js";

describe("detectQuestionDepth", () => {
  // ── Quick questions ──

  it("detects 'one word' requests as quick", () => {
    expect(detectQuestionDepth("one word sell or buy more XRP")).toBe("quick");
  });

  it("detects '1 word' requests as quick", () => {
    expect(detectQuestionDepth("1 word buy or sell BTC")).toBe("quick");
  });

  it("detects 'quick' keyword as quick", () => {
    expect(detectQuestionDepth("quick take on ETH?")).toBe("quick");
  });

  it("detects 'tldr' as quick", () => {
    expect(detectQuestionDepth("tldr on BTC right now")).toBe("quick");
  });

  it("detects 'just tell me' as quick", () => {
    expect(detectQuestionDepth("just tell me if SOL is a buy")).toBe("quick");
  });

  it("detects 'buy or sell' pattern as quick", () => {
    expect(detectQuestionDepth("buy or sell XRP?")).toBe("quick");
  });

  it("detects 'bull or bear' pattern as quick", () => {
    expect(detectQuestionDepth("bull or bear on ETH?")).toBe("quick");
  });

  it("detects 'hold or sell' pattern as quick", () => {
    expect(detectQuestionDepth("hold or sell BTC here?")).toBe("quick");
  });

  it("detects short questions as quick", () => {
    expect(detectQuestionDepth("is BTC a buy?")).toBe("quick");
  });

  it("detects very short questions as quick", () => {
    expect(detectQuestionDepth("XRP thoughts?")).toBe("quick");
  });

  it("detects 'how's ETH?' as quick", () => {
    expect(detectQuestionDepth("how's ETH doing?")).toBe("quick");
  });

  // ── Deep questions ──

  it("detects 'analyze' as deep", () => {
    expect(detectQuestionDepth("analyze BTC with all the technicals and give me a full breakdown of support and resistance levels")).toBe("deep");
  });

  it("detects 'breakdown' as deep", () => {
    expect(detectQuestionDepth("give me a full breakdown of ETH including all indicators and price action analysis")).toBe("deep");
  });

  it("detects 'technicals' as deep", () => {
    expect(detectQuestionDepth("what are the technicals saying about BTC right now, I want RSI, MACD, and Bollinger Bands analysis")).toBe("deep");
  });

  it("detects 'detailed' as deep", () => {
    expect(detectQuestionDepth("I need a detailed analysis of SOL including support levels, resistance zones and volume profile")).toBe("deep");
  });

  it("detects 'deep dive' as deep", () => {
    expect(detectQuestionDepth("deep dive into XRP including on-chain metrics and institutional flows if you can find them")).toBe("deep");
  });

  it("detects 'signals' as deep", () => {
    expect(detectQuestionDepth("what signals are you seeing on ETH right now, give me everything you've got on the current setup")).toBe("deep");
  });

  it("detects 'compare' as deep", () => {
    expect(detectQuestionDepth("compare BTC and ETH right now, which one has better technicals and risk reward for a swing trade")).toBe("deep");
  });

  it("detects long messages as deep", () => {
    const long = "I've been watching BTC all week and the price action looks really interesting near this level. What do you think about the current setup given the macro environment and recent ETF flows?";
    expect(detectQuestionDepth(long)).toBe("deep");
  });

  // ── Trade proposals → deep (even when short) ──

  it("detects short trade proposals as deep", () => {
    expect(detectQuestionDepth("should I sell BTC at 70k?")).toBe("deep");
  });

  it("detects 'thinking about buying' as deep", () => {
    expect(detectQuestionDepth("thinking about buying ETH here")).toBe("deep");
  });

  it("detects 'is this trade a good idea' as deep", () => {
    expect(detectQuestionDepth("planning to long SOL, good idea?")).toBe("deep");
  });

  // ── Edge cases ──

  it("treats moderate-length general questions as quick", () => {
    // 80 chars, no deep keywords
    expect(detectQuestionDepth("what do you think about BTC at these levels right now?")).toBe("quick");
  });

  it("treats 'brief' keyword as quick even with longer text", () => {
    expect(detectQuestionDepth("brief summary of what's happening with BTC and whether I should be worried about the recent pullback")).toBe("quick");
  });
});
