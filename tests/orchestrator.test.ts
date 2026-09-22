import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { rmSync } from "fs";
import type { SentinelAssessment } from "../src/signals/monitor.js";
import type { ResearchAssessment } from "../src/agents/research/agent.js";
import type { SignalCall } from "../src/signals/scorer.js";

/**
 * The orchestrator end to end: real pipeline, real dialogue clamps, real
 * (temporary) database. Only the agents' inputs — the Sentinel read, the
 * Research assessment, and the dialogue's model replies — are scripted.
 *
 * What must hold: phases run in order and can't be skipped, every run leaves a
 * decision record, failures fail closed, and nothing is ever executed.
 */

const TEST_DB_PATH = vi.hoisted(() => {
  const dir = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return `${dir}/ms-orchestrator-${process.pid}-${Date.now()}.db`;
});

vi.mock("../src/config.js", () => ({
  hasAnyAI: () => true,
  hasClaude: () => true,
  hasOpenAI: () => true,
  DB_PATH: TEST_DB_PATH,
}));

const assessMock = vi.fn();
vi.mock("../src/signals/monitor.js", () => ({
  assessSymbol: (...a: unknown[]) => assessMock(...a),
}));

const researchMock = vi.fn();
vi.mock("../src/agents/research/agent.js", () => ({
  researchSymbol: (...a: unknown[]) => researchMock(...a),
}));

const askMock = vi.fn();
vi.mock("../src/agents/llm.js", () => ({
  askAgentJson: (...a: unknown[]) => askMock(...a),
}));

const { proposeTrade, runPipeline } = await import("../src/agents/orchestrator.js");
const { getDecisionRecord, listDecisionRecords } = await import("../src/state/proposals.js");
const { getDb } = await import("../src/state/db.js");
const { agentVotes, dialogueTranscripts } = await import("../src/state/schema.js");
const { eq } = await import("drizzle-orm");

afterAll(() => {
  try { rmSync(TEST_DB_PATH, { force: true }); } catch { /* best effort */ }
});

function sentinel(call: SignalCall, conviction: number, symbol = "XRP"): SentinelAssessment {
  const now = Date.now();
  return {
    signal: {
      symbol, call, conviction, price: 1.58, entry: 1.58, stop: 1.53, target: 1.66,
      rationale: `${call} @ ${Math.round(conviction * 100)}% conviction.`,
      components: { technical: "bullish", ai: "bullish", agreement: true },
      timestamp: now,
    },
    technical: { symbol, price: 1.58, overallDirection: "bullish", overallStrength: 0.9 } as never,
    council: {
      symbol, timestamp: now, failed: [], majorityDirection: "bullish",
      directionBreakdown: { bullish: 5, bearish: 1, neutral: 1 }, avgConfidence: 0.7,
      disagreements: ["Direction split: DeepSeek says bearish"], consensus: "Majority (5/7): bullish",
      votes: [{ model: "OpenAI" }] as never,
    },
  };
}

function research(direction: "bullish" | "bearish" | "neutral", confidence: number, disqualifiers: string[] = []) {
  return {
    symbol: "XRP", direction, confidence, selfReportedConfidence: confidence, dataQuality: 0.7,
    thesis: `Research thinks ${direction}.`, supportingFacts: [], risks: [], disqualifiers,
    historicalContext: null, sources: [], timestamp: Date.now(),
  } as ResearchAssessment;
}

/** Dialogue where nobody moves. */
function steadyDialogue(researchConfidence: number, conviction: number) {
  for (let round = 0; round < 2; round++) {
    askMock.mockResolvedValueOnce({ message: `challenge ${round + 1}`, direction: "bullish", confidence: researchConfidence });
    askMock.mockResolvedValueOnce({ message: `answer ${round + 1}`, conviction });
  }
}

beforeEach(() => {
  assessMock.mockReset();
  researchMock.mockReset();
  askMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("happy path", () => {
  it("aligned agents clear the gate: eligible, logged, never executed", async () => {
    assessMock.mockResolvedValue(sentinel("STRONG_BUY", 0.8));
    researchMock.mockResolvedValue(research("bullish", 0.7));
    steadyDialogue(0.7, 0.8);

    const record = await runPipeline("XRP", "signal");

    expect(record.status).toBe("eligible");
    expect(record.action).toBe("BUY");
    expect(record.proposedCall).toBe("STRONG_BUY");
    expect(record.confidence?.confidence).toBeCloseTo(0.75, 3);
    expect(record.dialogue.turns).toHaveLength(4);
    expect(record.summary).toContain("Unanimous");
    expect(record.summary).toContain("no order placed");
  });

  it("records all three votes — Execution explicitly not evaluated until Phase D", async () => {
    assessMock.mockResolvedValue(sentinel("BUY", 0.8));
    researchMock.mockResolvedValue(research("bullish", 0.7));
    steadyDialogue(0.7, 0.8);

    const record = await runPipeline("XRP", "signal");

    expect(record.votes.map((v) => v.agent)).toEqual(["sentinel", "research", "execution"]);
    const execution = record.votes[2];
    expect(execution.evaluated).toBe(false);
    expect(execution.direction).toBeNull(); // never a directional view
  });

  it("persists the record, every vote, and every dialogue turn", async () => {
    assessMock.mockResolvedValue(sentinel("BUY", 0.8));
    researchMock.mockResolvedValue(research("bullish", 0.7));
    steadyDialogue(0.7, 0.8);

    const record = await runPipeline("XRP", "chat");

    expect(record.id).toBeGreaterThan(0);
    const stored = await getDecisionRecord(record.id!);
    expect(stored?.status).toBe("eligible");
    expect(stored?.id).toBe(record.id);

    const db = await getDb();
    expect(db.select().from(agentVotes).where(eq(agentVotes.proposalId, record.id!)).all()).toHaveLength(3);
    expect(db.select().from(dialogueTranscripts).where(eq(dialogueTranscripts.proposalId, record.id!)).all()).toHaveLength(4);
  });
});

describe("early exits — each still leaves a record", () => {
  it("HOLD: no proposal, and Research is never consulted", async () => {
    assessMock.mockResolvedValue(sentinel("HOLD", 0.1));

    const record = await runPipeline("XRP", "chat");

    expect(record.status).toBe("no_action");
    expect(researchMock).not.toHaveBeenCalled();
    expect(record.id).toBeGreaterThan(0);
  });

  it("Research disqualifier: vetoed before dialogue, whatever the confidence", async () => {
    assessMock.mockResolvedValue(sentinel("STRONG_BUY", 1));
    researchMock.mockResolvedValue(research("bullish", 1, ["Earnings in 18 hours"]));

    const record = await runPipeline("XRP", "signal");

    expect(record.status).toBe("vetoed");
    expect(record.vetoReason).toContain("Earnings in 18 hours");
    expect(askMock).not.toHaveBeenCalled();
    expect(record.votes.find((v) => v.agent === "research")?.veto).toContain("Earnings");
  });

  it("opposed Research: rejected with visible dissent, dialogue skipped to save cost", async () => {
    assessMock.mockResolvedValue(sentinel("STRONG_BUY", 0.9));
    researchMock.mockResolvedValue(research("bearish", 0.8));

    const record = await runPipeline("XRP", "signal");

    expect(record.status).toBe("below_threshold");
    expect(askMock).not.toHaveBeenCalled();
    expect(record.dialogue.skippedReason).toContain("can only lower");
    const researchVote = record.votes.find((v) => v.agent === "research");
    expect(researchVote?.isDissent).toBe(true);
    expect(record.summary).toContain("Dissent");
    expect(record.summary).toContain("Research thinks bearish");
    // STRONG never survives disagreement.
    expect(record.proposedCall).toBe("BUY");
  });

  it("confidently neutral Research can't carry the trade", async () => {
    assessMock.mockResolvedValue(sentinel("STRONG_BUY", 0.9));
    researchMock.mockResolvedValue(research("neutral", 0.9));

    const record = await runPipeline("XRP", "signal");

    expect(record.status).toBe("below_threshold");
  });
});

describe("dialogue can only lower confidence", () => {
  it("a proposal talked below the gate is rejected, with both numbers recorded", async () => {
    assessMock.mockResolvedValue(sentinel("BUY", 0.8));
    researchMock.mockResolvedValue(research("bullish", 0.7));
    askMock
      .mockResolvedValueOnce({ message: "token unlock Friday", direction: "bullish", confidence: 0.4 })
      .mockResolvedValueOnce({ message: "conceded", conviction: 0.6 })
      .mockResolvedValueOnce({ message: "r2", direction: "bullish", confidence: 0.4 })
      .mockResolvedValueOnce({ message: "s2", conviction: 0.6 });

    const record = await runPipeline("XRP", "signal");

    expect(record.status).toBe("below_threshold");
    expect(record.preDialogueConfidence).toBeCloseTo(0.75, 3);
    expect(record.confidence?.confidence).toBeCloseTo(0.5, 3);
  });

  it("models trying to talk confidence UP change nothing", async () => {
    assessMock.mockResolvedValue(sentinel("BUY", 0.7));
    researchMock.mockResolvedValue(research("bullish", 0.62));
    askMock
      .mockResolvedValueOnce({ message: "actually great", direction: "bullish", confidence: 1 })
      .mockResolvedValueOnce({ message: "agreed, very sure", conviction: 1 })
      .mockResolvedValueOnce({ message: "r2", direction: "bullish", confidence: 1 })
      .mockResolvedValueOnce({ message: "s2", conviction: 1 });

    const record = await runPipeline("XRP", "signal");

    expect(record.confidence!.confidence).toBeLessThanOrEqual(record.preDialogueConfidence!);
    expect(record.dialogue.turns.filter((t) => t.clampNote)).toHaveLength(4);
  });
});

describe("fail closed", () => {
  it("no market data → error", async () => {
    assessMock.mockResolvedValue(null);
    const record = await runPipeline("XRP", "signal");
    expect(record.status).toBe("error");
    expect(record.id).toBeGreaterThan(0);
  });

  it("Research failure → error, never eligible", async () => {
    assessMock.mockResolvedValue(sentinel("STRONG_BUY", 1));
    researchMock.mockRejectedValue(new Error("all providers down"));

    const record = await runPipeline("XRP", "signal");

    expect(record.status).toBe("error");
    expect(record.summary).toContain("fail closed");
  });

  it("dialogue failure partway → error, with the partial transcript kept", async () => {
    assessMock.mockResolvedValue(sentinel("BUY", 0.8));
    researchMock.mockResolvedValue(research("bullish", 0.7));
    askMock
      .mockResolvedValueOnce({ message: "r1", direction: "bullish", confidence: 0.7 })
      .mockResolvedValueOnce({ message: "s1", conviction: 0.8 })
      .mockRejectedValueOnce(new Error("timeout"));

    const record = await runPipeline("XRP", "signal");

    expect(record.status).toBe("error");
    expect(record.dialogue.turns.map((t) => t.message)).toEqual(["r1", "s1"]);
    const stored = await getDecisionRecord(record.id!);
    expect(stored?.dialogue.turns).toHaveLength(2);
  });
});

describe("scheduling", () => {
  it("dedupes concurrent requests for the same symbol into one run", async () => {
    assessMock.mockResolvedValue(sentinel("HOLD", 0.1, "BTC"));

    const [a, b] = await Promise.all([proposeTrade("BTC", "signal"), proposeTrade("btc", "chat")]);

    expect(a).toBe(b);
    expect(assessMock).toHaveBeenCalledTimes(1);
  });

  it("runs different symbols one at a time, not in parallel", async () => {
    let releaseFirst!: () => void;
    const order: string[] = [];
    assessMock.mockImplementation(async (sym: string) => {
      order.push(`start ${sym}`);
      if (sym === "ETH") await new Promise<void>((r) => { releaseFirst = r; });
      order.push(`end ${sym}`);
      return sentinel("HOLD", 0.1, sym);
    });

    const first = proposeTrade("ETH", "signal");
    const second = proposeTrade("SOL", "signal");
    await vi.waitFor(() => expect(order).toContain("start ETH"));
    expect(order).not.toContain("start SOL");

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["start ETH", "end ETH", "start SOL", "end SOL"]);
  });
});

describe("listDecisionRecords", () => {
  it("filters by symbol and status, newest first", async () => {
    assessMock.mockResolvedValue(sentinel("HOLD", 0.1, "DOGE"));
    await runPipeline("DOGE", "chat");

    const doge = await listDecisionRecords({ symbol: "doge" });
    expect(doge.length).toBeGreaterThan(0);
    expect(doge.every((r) => r.symbol === "DOGE")).toBe(true);

    const eligible = await listDecisionRecords({ status: "eligible", limit: 50 });
    expect(eligible.every((r) => r.status === "eligible")).toBe(true);
  });
});
