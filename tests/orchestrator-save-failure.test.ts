import { describe, it, expect, vi } from "vitest";

/**
 * No audit record, no proposal. If the decision record can't be saved, an
 * otherwise-eligible proposal must come back as an error — in Phase C an
 * eligible record becomes an approval ticket, and a trade must never reach
 * a human without the record that explains it.
 */

vi.mock("../src/config.js", () => ({ hasAnyAI: () => true, hasClaude: () => true, hasOpenAI: () => true }));
vi.mock("../src/state/proposals.js", () => ({
  saveDecisionRecord: vi.fn(async () => {
    throw new Error("disk full");
  }),
}));
vi.mock("../src/signals/monitor.js", () => ({
  assessSymbol: vi.fn(async () => ({
    signal: {
      symbol: "XRP", call: "BUY", conviction: 0.8, price: 1, entry: 1, stop: 0.97, target: 1.05,
      rationale: "x", components: { technical: "bullish", ai: "bullish", agreement: true }, timestamp: Date.now(),
    },
    technical: { overallDirection: "bullish" },
  })),
}));
vi.mock("../src/agents/research/agent.js", () => ({
  researchSymbol: vi.fn(async () => ({
    symbol: "XRP", direction: "bullish", confidence: 0.7, selfReportedConfidence: 0.7, dataQuality: 0.7,
    thesis: "t", supportingFacts: [], risks: [], disqualifiers: [], historicalContext: null, sources: [],
    timestamp: Date.now(),
  })),
}));
const askMock = vi.fn();
vi.mock("../src/agents/llm.js", () => ({ askAgentJson: (...a: unknown[]) => askMock(...a) }));

const { runPipeline } = await import("../src/agents/orchestrator.js");

describe("decision record can't be saved", () => {
  it("turns an eligible proposal into an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    askMock
      .mockResolvedValueOnce({ message: "r1", direction: "bullish", confidence: 0.7 })
      .mockResolvedValueOnce({ message: "s1", conviction: 0.8 })
      .mockResolvedValueOnce({ message: "r2", direction: "bullish", confidence: 0.7 })
      .mockResolvedValueOnce({ message: "s2", conviction: 0.8 });

    const record = await runPipeline("XRP", "signal");

    expect(record.status).toBe("error");
    expect(record.id).toBeUndefined();
    expect(record.errors.join(" ")).toContain("not saved");
  });
});
