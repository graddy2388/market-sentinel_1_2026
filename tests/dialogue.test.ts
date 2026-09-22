import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResearchAssessment } from "../src/agents/research/agent.js";
import type { DialogueTurn, SentinelSnapshot } from "../src/agents/types.js";

/**
 * Bounded dialogue. The invariant: talking can only LOWER confidence. Models
 * are easily argued into agreement, and dialogue adds no evidence — so code,
 * not the prompt, refuses any attempt to raise confidence or move toward the
 * proposal, and records that it did.
 */

const askMock = vi.fn();
vi.mock("../src/agents/llm.js", () => ({
  askAgentJson: (...a: unknown[]) => askMock(...a),
}));

const { runDialogue, DIALOGUE_ROUNDS } = await import("../src/agents/dialogue.js");

const sentinel: SentinelSnapshot = {
  call: "STRONG_BUY", conviction: 0.8, rationale: "Technicals bullish (100%) AI council bullish.",
  price: 1.58, entry: 1.58, stop: 1.53, target: 1.66,
  technicalDirection: "bullish", councilDirection: "bullish",
  councilConsensus: "Majority (5/7): bullish", councilDisagreements: [], timestamp: Date.now(),
};

const research = {
  symbol: "XRP", direction: "bullish", confidence: 0.7, selfReportedConfidence: 0.8,
  dataQuality: 0.7, thesis: "ETF inflows.", supportingFacts: ["inflows"], risks: ["unlock"],
  disqualifiers: [], historicalContext: null, sources: [], timestamp: Date.now(),
} as ResearchAssessment;

const input = { symbol: "XRP", action: "BUY" as const, sentinel, research };

/** Script the four turns: R1, S1, R2, S2. */
function script(...replies: unknown[]) {
  for (const r of replies) askMock.mockResolvedValueOnce(r);
}

beforeEach(() => {
  askMock.mockReset();
});

describe("runDialogue", () => {
  it("runs exactly two rounds: Research challenges, Sentinel answers", async () => {
    script(
      { message: "r1", direction: "bullish", confidence: 0.7 },
      { message: "s1", conviction: 0.8 },
      { message: "r2", direction: "bullish", confidence: 0.7 },
      { message: "s2", conviction: 0.8 },
    );

    const result = await runDialogue(input);

    expect(DIALOGUE_ROUNDS).toBe(2);
    expect(result.turns.map((t) => `${t.round}:${t.agent}`)).toEqual([
      "1:research", "1:sentinel", "2:research", "2:sentinel",
    ]);
    expect(askMock).toHaveBeenCalledTimes(4);
  });

  it("lets agents LOWER confidence", async () => {
    script(
      { message: "unlock next week", direction: "bullish", confidence: 0.5 },
      { message: "fair point", conviction: 0.6 },
      { message: "still", direction: "bullish", confidence: 0.45 },
      { message: "ok", conviction: 0.55 },
    );

    const result = await runDialogue(input);

    expect(result.researchConfidence).toBe(0.45);
    expect(result.sentinelConviction).toBe(0.55);
  });

  it("refuses to let Research RAISE its confidence, and records the attempt", async () => {
    script(
      { message: "convinced!", direction: "bullish", confidence: 0.95 },
      { message: "s1", conviction: 0.8 },
      { message: "r2", direction: "bullish", confidence: 0.99 },
      { message: "s2", conviction: 0.8 },
    );

    const result = await runDialogue(input);

    expect(result.researchConfidence).toBe(0.7);
    expect(result.turns[0].clampNote).toContain("tried to raise confidence");
  });

  it("refuses to let Sentinel RAISE its conviction", async () => {
    script(
      { message: "r1", direction: "bullish", confidence: 0.7 },
      { message: "even more sure", conviction: 1 },
      { message: "r2", direction: "bullish", confidence: 0.7 },
      { message: "s2", conviction: 0.9 },
    );

    const result = await runDialogue(input);

    expect(result.sentinelConviction).toBe(0.8);
    expect(result.turns[1].clampNote).toContain("tried to raise conviction");
  });

  it("lets Research move AWAY from the proposal", async () => {
    script(
      { message: "wash trading", direction: "neutral", confidence: 0.6 },
      { message: "s1", conviction: 0.8 },
      { message: "worse", direction: "bearish", confidence: 0.6 },
      { message: "s2", conviction: 0.8 },
    );

    const result = await runDialogue(input);

    expect(result.researchDirection).toBe("bearish");
  });

  it("refuses to let Research be talked TOWARD the proposal", async () => {
    const neutralStart = { ...input, research: { ...research, direction: "neutral" as const } };
    script(
      { message: "you've persuaded me", direction: "bullish", confidence: 0.7 },
      { message: "s1", conviction: 0.8 },
      { message: "r2", direction: "bullish", confidence: 0.7 },
      { message: "s2", conviction: 0.8 },
    );

    const result = await runDialogue(neutralStart);

    expect(result.researchDirection).toBe("neutral");
    expect(result.turns[0].clampNote).toContain("toward the proposal");
  });

  it("keeps the turns spoken before a failure, for the audit trail", async () => {
    script(
      { message: "r1", direction: "bullish", confidence: 0.7 },
      { message: "s1", conviction: 0.8 },
    );
    askMock.mockRejectedValueOnce(new Error("provider down"));
    const turns: DialogueTurn[] = [];

    await expect(runDialogue(input, turns)).rejects.toThrow("provider down");
    expect(turns.map((t) => t.message)).toEqual(["r1", "s1"]);
  });

  it("shows each agent the other's view and the transcript so far", async () => {
    script(
      { message: "opening challenge", direction: "bullish", confidence: 0.7 },
      { message: "s1", conviction: 0.8 },
      { message: "r2", direction: "bullish", confidence: 0.7 },
      { message: "s2", conviction: 0.8 },
    );

    await runDialogue(input);

    const [sentinelSystem, sentinelPrompt] = askMock.mock.calls[1];
    expect(sentinelSystem).toContain("STRONG BUY");
    expect(sentinelPrompt).toContain("ETF inflows."); // Research's thesis
    expect(sentinelPrompt).toContain("opening challenge"); // the transcript
    const [researchSystem] = askMock.mock.calls[0];
    expect(researchSystem).toContain("Never compute or cite technical indicators");
  });
});
