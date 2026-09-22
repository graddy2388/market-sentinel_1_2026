import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Reading Claude's reply.
 *
 * Current Claude models think by default, which puts a thinking block first in
 * the content array. Code that read content[0] and demanded type "text" threw
 * "Unexpected response type" on a perfectly good answer — so the model upgrade
 * would have broken every Claude call. Thinking is also disabled at the call
 * sites, but this stays robust if that ever changes.
 */

vi.mock("../src/config.js", () => ({
  appConfig: { ANTHROPIC_API_KEY: "test" },
  hasClaude: () => true,
  hasOpenAI: () => true,
}));

const { firstText } = await import("../src/ai/claude.js");

const block = (b: unknown) => b as Anthropic.ContentBlock;

describe("firstText", () => {
  it("reads a plain text reply", () => {
    expect(firstText([block({ type: "text", text: "hello" })])).toBe("hello");
  });

  it("skips a leading thinking block", () => {
    const content = [
      block({ type: "thinking", thinking: "let me consider..." }),
      block({ type: "text", text: '{"direction":"bullish"}' }),
    ];

    expect(firstText(content)).toBe('{"direction":"bullish"}');
  });

  it("throws only when there is genuinely no text", () => {
    expect(() => firstText([block({ type: "thinking", thinking: "..." })])).toThrow("No text block");
    expect(() => firstText([])).toThrow("No text block");
  });
});
