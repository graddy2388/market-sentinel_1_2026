/**
 * Consensus and confidence — pure functions, no I/O.
 *
 *   base       = 0.5 * sentinelConviction + 0.5 * researchSupport
 *   confidence = base * agreementFactor * freshnessFactor
 *
 * researchSupport is Research's confidence when it AGREES with the proposed
 * direction, and 0 otherwise. The architecture plan originally fed Research's
 * raw confidence into the base, which let a confidently NEUTRAL Research agent
 * push a BUY over the gate (0.9 / 0.9 → 0.9 × 0.75 = 0.675). Confidence that
 * nothing will happen isn't support for a trade.
 *
 * The practical consequence, by design: a proposal needs Research to agree.
 * Neutral or opposed caps base at 0.5 × sentinelConviction ≤ 0.5, below the
 * gate before the agreement factor even applies. Conflict means no action.
 */
import type { SignalCall } from "../signals/scorer.js";
import type { ResearchAssessment } from "./research/agent.js";
import type {
  ConfidenceBreakdown,
  Direction,
  ProposalAction,
  Stance,
} from "./types.js";

/** Every weight and threshold in one place. */
export const CONSENSUS = {
  /** Minimum confidence to be approval-eligible. */
  threshold: 0.65,
  sentinelWeight: 0.5,
  researchWeight: 0.5,
  agreementFactor: { aligned: 1.0, neutral: 0.75, opposed: 0.35 } as Record<Stance, number>,
  /** Inputs are fully fresh for this long... */
  freshnessGraceMs: 15 * 60_000,
  /** ...then decay linearly to zero over this span. */
  freshnessDecayMs: 60 * 60_000,
} as const;

export function actionFor(call: SignalCall): ProposalAction | null {
  if (call === "BUY" || call === "STRONG_BUY") return "BUY";
  if (call === "SELL" || call === "STRONG_SELL") return "SELL";
  return null;
}

export function directionOf(action: ProposalAction): Direction {
  return action === "BUY" ? "bullish" : "bearish";
}

/** Where an agent's direction stands relative to the proposed trade. */
export function stanceOf(action: ProposalAction, direction: Direction): Stance {
  if (direction === "neutral") return "neutral";
  return direction === directionOf(action) ? "aligned" : "opposed";
}

/** Rank for "how much does this stance support the trade" — used to stop dialogue moving toward agreement. */
export function stanceRank(stance: Stance): number {
  return stance === "aligned" ? 2 : stance === "neutral" ? 1 : 0;
}

/** 1.0 while fresh, then linear decay to 0. */
export function freshnessFactor(ageMs: number): number {
  const { freshnessGraceMs, freshnessDecayMs } = CONSENSUS;
  if (ageMs <= freshnessGraceMs) return 1;
  return Math.max(0, 1 - (ageMs - freshnessGraceMs) / freshnessDecayMs);
}

const round3 = (n: number) => Number(n.toFixed(3));

export interface ConfidenceInput {
  action: ProposalAction;
  sentinelConviction: number;
  researchDirection: Direction;
  researchConfidence: number;
  sentinelAgeMs: number;
  researchAgeMs: number;
}

export function computeConfidence(input: ConfidenceInput): ConfidenceBreakdown {
  const stance = stanceOf(input.action, input.researchDirection);
  const researchSupport = stance === "aligned" ? input.researchConfidence : 0;

  const base =
    CONSENSUS.sentinelWeight * input.sentinelConviction + CONSENSUS.researchWeight * researchSupport;
  const agreement = CONSENSUS.agreementFactor[stance];
  // The staler input governs.
  const freshness = Math.min(freshnessFactor(input.sentinelAgeMs), freshnessFactor(input.researchAgeMs));

  return {
    sentinelConviction: round3(input.sentinelConviction),
    researchStance: stance,
    researchSupport: round3(researchSupport),
    base: round3(base),
    agreementFactor: agreement,
    freshnessFactor: round3(freshness),
    confidence: round3(base * agreement * freshness),
    threshold: CONSENSUS.threshold,
  };
}

/** A STRONG call survives only if Research agrees; otherwise it's downgraded, never strengthened. */
export function proposedCallFor(call: SignalCall, stance: Stance): SignalCall {
  if (stance === "aligned") return call;
  if (call === "STRONG_BUY") return "BUY";
  if (call === "STRONG_SELL") return "SELL";
  return call;
}

/**
 * Research's veto: only hard, factual blockers (imminent earnings, halt,
 * delisting, exploit). A bearish opinion flows through confidence instead.
 */
export function researchVeto(research: ResearchAssessment): string | null {
  const blockers = research.disqualifiers.map((d) => d.trim()).filter(Boolean);
  return blockers.length > 0 ? blockers.join("; ") : null;
}
