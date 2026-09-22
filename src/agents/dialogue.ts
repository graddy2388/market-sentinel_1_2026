/**
 * Phase 2: bounded dialogue between Sentinel and Research.
 *
 * Two rounds; in each, Research challenges and Sentinel answers. The point is
 * to surface reasoning a bare vote would flatten — and to give the human
 * approver a transcript to read.
 *
 * The invariant that matters: DIALOGUE CAN ONLY LOWER CONFIDENCE. Talking adds
 * no evidence, and language models are easily talked into agreeing with each
 * other. So an agent may lower its confidence, or move its direction AWAY from
 * the proposed trade, but code refuses any attempt to raise confidence or move
 * toward agreement — and records that it did. That makes dialogue a filter
 * that can only kill trades, never manufacture one.
 */
import { z } from "zod";
import { askAgentJson } from "./llm.js";
import { stanceOf, stanceRank } from "./consensus.js";
import { formatLevel } from "../signals/scorer.js";
import type { ResearchAssessment } from "./research/agent.js";
import type { Direction, DialogueTurn, ProposalAction, SentinelSnapshot } from "./types.js";

export const DIALOGUE_ROUNDS = 2;

const researchTurnSchema = z.object({
  message: z.string().min(1),
  direction: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.number().min(0).max(1),
});

const sentinelTurnSchema = z.object({
  message: z.string().min(1),
  conviction: z.number().min(0).max(1),
});

export interface DialogueInput {
  symbol: string;
  action: ProposalAction;
  sentinel: SentinelSnapshot;
  research: ResearchAssessment;
}

export interface DialogueResult {
  turns: DialogueTurn[];
  sentinelConviction: number;
  researchDirection: Direction;
  researchConfidence: number;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function researchSystem(input: DialogueInput): string {
  return [
    "You are the Research Agent in a pre-trade review. The Sentinel agent (technical",
    `analysis plus a multi-model AI council) proposes to ${input.action} ${input.symbol}.`,
    "You assessed the asset independently, before seeing its proposal.",
    "",
    "Challenge the proposal using YOUR evidence: news, fundamentals, supply, and how this",
    "system's past calls on the asset resolved. Never compute or cite technical indicators.",
    "If Sentinel's answer exposes a weakness in your view, say so honestly.",
    "",
    "Dialogue adds no new evidence. You may LOWER your confidence or move your direction",
    "away from the proposal; raising confidence or moving toward it will be ignored.",
    "",
    'Respond ONLY with JSON: {"message":"2-4 sentences","direction":"bullish|bearish|neutral","confidence":0.0-1.0}',
  ].join("\n");
}

function sentinelSystem(input: DialogueInput): string {
  return [
    `You speak for the Sentinel agent, whose technical read and AI council produced a`,
    `${input.sentinel.call.replace("_", " ")} signal on ${input.symbol} at ${pct(input.sentinel.conviction)} conviction.`,
    "The Research agent is reviewing the proposal.",
    "",
    "Answer its challenges on technical grounds: defend the signal where the data supports",
    "it, and concede where Research raises a real risk. Don't invent data you weren't given.",
    "",
    "You may LOWER your conviction (0 withdraws the signal); raising it will be ignored.",
    "",
    'Respond ONLY with JSON: {"message":"2-4 sentences","conviction":0.0-1.0}',
  ].join("\n");
}

function context(input: DialogueInput, turns: DialogueTurn[], round: number): string {
  const s = input.sentinel;
  const r = input.research;
  const unavailable = r.sources.filter((src) => !src.available).map((src) => src.label);

  return [
    "## Sentinel signal",
    `${s.call.replace("_", " ")} @ ${pct(s.conviction)} conviction. Price ${formatLevel(s.price)}; ` +
      `entry ${formatLevel(s.entry)}, stop ${formatLevel(s.stop)}, target ${formatLevel(s.target)}.`,
    s.rationale,
    s.councilConsensus ? `AI council: ${s.councilConsensus}` : "AI council: unavailable",
    ...s.councilDisagreements.map((d) => `- ${d}`),
    "",
    "## Research assessment (made independently)",
    `${r.direction} @ ${pct(r.confidence)} confidence (data quality ${pct(r.dataQuality)}).`,
    `Thesis: ${r.thesis}`,
    ...r.supportingFacts.map((f) => `- fact: ${f}`),
    ...r.risks.map((k) => `- risk: ${k}`),
    r.historicalContext ? `This system's past calls: ${r.historicalContext}` : "No graded history for this asset.",
    unavailable.length ? `Sources unavailable: ${unavailable.join(", ")}.` : "",
    "",
    "## Dialogue so far",
    turns.length === 0
      ? "(none — you open)"
      : turns.map((t) => `[Round ${t.round}] ${t.agent === "research" ? "Research" : "Sentinel"}: ${t.message}`).join("\n"),
    "",
    `## Your turn (round ${round} of ${DIALOGUE_ROUNDS})`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Run the bounded dialogue. Turns are appended to `turns` as they happen, so
 * the caller keeps a partial transcript if a later turn throws — and it should
 * fail closed when one does.
 */
export async function runDialogue(
  input: DialogueInput,
  turns: DialogueTurn[] = []
): Promise<DialogueResult> {
  let sentinelConviction = input.sentinel.conviction;
  let researchDirection: Direction = input.research.direction;
  let researchConfidence = input.research.confidence;

  for (let round = 1; round <= DIALOGUE_ROUNDS; round++) {
    // --- Research challenges ---
    const r = await askAgentJson(researchSystem(input), context(input, turns, round), researchTurnSchema);
    const notes: string[] = [];

    let nextDirection = r.direction as Direction;
    if (stanceRank(stanceOf(input.action, nextDirection)) > stanceRank(stanceOf(input.action, researchDirection))) {
      notes.push(`tried to move toward the proposal (${researchDirection} → ${nextDirection}); ignored`);
      nextDirection = researchDirection;
    }
    let nextConfidence = r.confidence;
    if (nextConfidence > researchConfidence) {
      notes.push(`tried to raise confidence to ${pct(nextConfidence)}; held at ${pct(researchConfidence)}`);
      nextConfidence = researchConfidence;
    }

    turns.push({
      round,
      agent: "research",
      message: r.message,
      confidenceBefore: researchConfidence,
      confidenceAfter: nextConfidence,
      directionBefore: researchDirection,
      directionAfter: nextDirection,
      ...(notes.length ? { clampNote: notes.join("; ") } : {}),
    });
    researchDirection = nextDirection;
    researchConfidence = nextConfidence;

    // --- Sentinel answers ---
    const s = await askAgentJson(sentinelSystem(input), context(input, turns, round), sentinelTurnSchema);
    let nextConviction = s.conviction;
    let clampNote: string | undefined;
    if (nextConviction > sentinelConviction) {
      clampNote = `tried to raise conviction to ${pct(nextConviction)}; held at ${pct(sentinelConviction)}`;
      nextConviction = sentinelConviction;
    }

    turns.push({
      round,
      agent: "sentinel",
      message: s.message,
      confidenceBefore: sentinelConviction,
      confidenceAfter: nextConviction,
      ...(clampNote ? { clampNote } : {}),
    });
    sentinelConviction = nextConviction;
  }

  return { turns, sentinelConviction, researchDirection, researchConfidence };
}
