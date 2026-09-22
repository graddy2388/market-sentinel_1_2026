/**
 * Shared types for the multi-agent decision pipeline.
 *
 * A DecisionRecord is the complete, self-contained account of one orchestrator
 * run: what each agent concluded independently, what they said to each other,
 * how they voted, how confidence was computed, and why the proposal ended
 * where it did. It is written once and never mutated — it's the audit trail.
 */
import type { SignalCall } from "../signals/scorer.js";
import type { ResearchAssessment } from "./research/agent.js";

export type Direction = "bullish" | "bearish" | "neutral";
export type ProposalAction = "BUY" | "SELL";
export type AgentName = "sentinel" | "research" | "execution";
export type ProposalTrigger = "signal" | "chat";

/**
 * - no_action: Sentinel had nothing actionable (HOLD); no proposal formed.
 * - vetoed: an agent raised an objective blocker.
 * - below_threshold: confidence didn't clear the gate.
 * - eligible: cleared every check. In Phase C this becomes an approval ticket;
 *   in Phase B it is only logged.
 * - error: a step failed. The pipeline fails closed — never eligible.
 */
export type ProposalStatus = "no_action" | "vetoed" | "below_threshold" | "eligible" | "error";

/** How an agent's view relates to the proposed trade's direction. */
export type Stance = "aligned" | "neutral" | "opposed";

export interface AgentVote {
  agent: AgentName;
  /** Execution never has a direction — it votes on feasibility only. */
  direction: Direction | null;
  confidence: number | null;
  rationale: string;
  /** True when this agent's final view doesn't support the proposal. */
  isDissent: boolean;
  /** An objective blocker, if this agent raised one. */
  veto: string | null;
  /** False for agents that didn't take part (Execution, until Phase D). */
  evaluated: boolean;
}

export interface DialogueTurn {
  round: number;
  agent: "sentinel" | "research";
  message: string;
  confidenceBefore: number;
  confidenceAfter: number;
  directionBefore?: Direction;
  directionAfter?: Direction;
  /** Set when code overrode the model — e.g. it tried to raise its confidence. */
  clampNote?: string;
}

export interface ConfidenceBreakdown {
  sentinelConviction: number;
  researchStance: Stance;
  /** Research confidence counted toward the trade: its confidence if aligned, else 0. */
  researchSupport: number;
  base: number;
  agreementFactor: number;
  freshnessFactor: number;
  confidence: number;
  threshold: number;
}

export interface SentinelSnapshot {
  call: SignalCall;
  conviction: number;
  rationale: string;
  price: number;
  entry: number;
  stop: number;
  target: number;
  technicalDirection: Direction;
  councilDirection: Direction | null;
  councilConsensus: string | null;
  councilDisagreements: string[];
  timestamp: number;
}

export interface DecisionRecord {
  id?: number;
  symbol: string;
  trigger: ProposalTrigger;
  status: ProposalStatus;
  action: ProposalAction | null;
  /** Sentinel's call, downgraded from STRONG unless Research agrees. */
  proposedCall: SignalCall | null;
  sentinel: SentinelSnapshot | null;
  research: ResearchAssessment | null;
  dialogue: { ran: boolean; skippedReason: string | null; turns: DialogueTurn[] };
  votes: AgentVote[];
  /** Upper bound: dialogue can only lower confidence, so this caps the final value. */
  preDialogueConfidence: number | null;
  confidence: ConfidenceBreakdown | null;
  vetoReason: string | null;
  errors: string[];
  summary: string;
  createdAt: number;
}
