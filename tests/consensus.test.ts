import { describe, it, expect } from "vitest";
import {
  CONSENSUS,
  actionFor,
  computeConfidence,
  freshnessFactor,
  proposedCallFor,
  researchVeto,
  stanceOf,
} from "../src/agents/consensus.js";
import type { ResearchAssessment } from "../src/agents/research/agent.js";
import type { Direction, ProposalAction } from "../src/agents/types.js";

/**
 * The confidence gate decides whether a proposal can ever reach a human. These
 * pin down the properties the architecture relies on: conflict can't clear
 * the gate, a neutral Research agent can't carry a trade, and STRONG needs
 * agreement.
 */

function confidence(
  action: ProposalAction,
  sentinel: number,
  researchDirection: Direction,
  research: number,
  ages = { sentinelAgeMs: 0, researchAgeMs: 0 }
) {
  return computeConfidence({
    action,
    sentinelConviction: sentinel,
    researchDirection,
    researchConfidence: research,
    ...ages,
  });
}

describe("computeConfidence", () => {
  it("aligned agents average their confidence", () => {
    const c = confidence("BUY", 0.8, "bullish", 0.7);
    expect(c.researchStance).toBe("aligned");
    expect(c.confidence).toBeCloseTo(0.75, 3);
    expect(c.confidence).toBeGreaterThanOrEqual(CONSENSUS.threshold);
  });

  it("two maximally confident OPPOSED agents can't clear the gate", () => {
    const c = confidence("BUY", 1, "bearish", 1);
    expect(c.researchStance).toBe("opposed");
    expect(c.confidence).toBeLessThan(CONSENSUS.threshold);
  });

  it("a confidently NEUTRAL Research agent can't carry a trade over the gate", () => {
    // The plan's original formula gave 0.9 × 0.75 = 0.675 here — a pass.
    const c = confidence("BUY", 0.9, "neutral", 0.9);
    expect(c.researchSupport).toBe(0);
    expect(c.confidence).toBeLessThan(CONSENSUS.threshold);
  });

  it("without Research agreeing, nothing clears the gate — for any inputs", () => {
    for (const action of ["BUY", "SELL"] as const) {
      for (const dir of ["bullish", "bearish", "neutral"] as const) {
        if (stanceOf(action, dir) === "aligned") continue;
        for (let s = 0; s <= 1; s += 0.1) {
          for (let r = 0; r <= 1; r += 0.1) {
            expect(confidence(action, s, dir, r).confidence).toBeLessThan(CONSENSUS.threshold);
          }
        }
      }
    }
  });

  it("works for shorts: bearish Research supports a SELL", () => {
    expect(confidence("SELL", 0.8, "bearish", 0.8).researchStance).toBe("aligned");
    expect(confidence("SELL", 0.8, "bullish", 0.8).researchStance).toBe("opposed");
  });

  it("the staler input drags confidence down", () => {
    const fresh = confidence("BUY", 0.8, "bullish", 0.8);
    const stale = confidence("BUY", 0.8, "bullish", 0.8, { sentinelAgeMs: 0, researchAgeMs: 45 * 60_000 });
    expect(stale.freshnessFactor).toBeCloseTo(0.5, 3);
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });

  it("reports the whole breakdown, so the approver can see why", () => {
    const c = confidence("BUY", 0.8, "bullish", 0.6);
    expect(c).toMatchObject({
      sentinelConviction: 0.8,
      researchSupport: 0.6,
      base: 0.7,
      agreementFactor: 1,
      freshnessFactor: 1,
      threshold: CONSENSUS.threshold,
    });
  });
});

describe("freshnessFactor", () => {
  it("is 1 within the grace period, then decays linearly to 0", () => {
    expect(freshnessFactor(0)).toBe(1);
    expect(freshnessFactor(15 * 60_000)).toBe(1);
    expect(freshnessFactor(45 * 60_000)).toBeCloseTo(0.5, 5);
    expect(freshnessFactor(75 * 60_000)).toBe(0);
    expect(freshnessFactor(10 * 3_600_000)).toBe(0);
  });
});

describe("proposedCallFor — STRONG requires agreement", () => {
  it("keeps STRONG when Research agrees", () => {
    expect(proposedCallFor("STRONG_BUY", "aligned")).toBe("STRONG_BUY");
  });

  it("downgrades STRONG when Research doesn't agree — never strengthens", () => {
    expect(proposedCallFor("STRONG_BUY", "neutral")).toBe("BUY");
    expect(proposedCallFor("STRONG_SELL", "opposed")).toBe("SELL");
    expect(proposedCallFor("BUY", "opposed")).toBe("BUY");
  });
});

describe("actionFor", () => {
  it("maps calls to actions, and HOLD to nothing", () => {
    expect(actionFor("STRONG_BUY")).toBe("BUY");
    expect(actionFor("SELL")).toBe("SELL");
    expect(actionFor("HOLD")).toBeNull();
  });
});

describe("researchVeto", () => {
  const research = (disqualifiers: string[]) => ({ disqualifiers }) as unknown as ResearchAssessment;

  it("vetoes on any hard disqualifier", () => {
    expect(researchVeto(research(["Earnings in 18 hours", "Trading halted"]))).toBe(
      "Earnings in 18 hours; Trading halted"
    );
  });

  it("does not veto when there are none — or only blank entries", () => {
    expect(researchVeto(research([]))).toBeNull();
    expect(researchVeto(research(["  "]))).toBeNull();
  });
});
