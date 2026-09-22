/**
 * Orchestrator — the deterministic phase controller.
 *
 * Plain code, not a language model: control flow that could one day move money
 * must not be something a model can be argued or prompt-injected out of. The
 * LLMs reason inside each agent; this module only sequences and enforces.
 *
 *   1. Sentinel and Research assess independently (Research never sees Sentinel's call)
 *   2. Objective vetoes
 *   3. Pre-dialogue confidence — dialogue can only lower it, so a proposal
 *      already below the gate skips the dialogue's cost
 *   4. Bounded dialogue (2 rounds)
 *   5. Votes, final confidence, gate
 *
 * Every run produces a persisted DecisionRecord, including runs that end early.
 * Any failure ends in status "error", which is never eligible: fail closed.
 *
 * PHASE B: nothing here places, stages, or approves an order. An "eligible"
 * record is only logged (and announced as a shadow proposal).
 */
import { assessSymbol, type SentinelAssessment } from "../signals/monitor.js";
import { researchSymbol } from "./research/agent.js";
import { runDialogue } from "./dialogue.js";
import {
  CONSENSUS,
  actionFor,
  computeConfidence,
  directionOf,
  proposedCallFor,
  researchVeto,
  stanceOf,
} from "./consensus.js";
import { saveDecisionRecord } from "../state/proposals.js";
import type {
  AgentVote,
  DecisionRecord,
  Direction,
  ProposalStatus,
  ProposalTrigger,
  SentinelSnapshot,
} from "./types.js";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const pct = (n: number) => `${Math.round(n * 100)}%`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ---------------------------------------------------------------------------
// Scheduling: one pipeline at a time, one pending run per symbol.
// A burst of signals queues up instead of fanning out LLM calls.
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();
const pendingBySymbol = new Map<string, Promise<DecisionRecord>>();

export function proposeTrade(symbol: string, trigger: ProposalTrigger): Promise<DecisionRecord> {
  const sym = symbol.toUpperCase();
  const pending = pendingBySymbol.get(sym);
  if (pending) return pending;

  const run = queue.then(() => runPipeline(sym, trigger));
  queue = run.catch(() => undefined);
  pendingBySymbol.set(sym, run);
  const clear = () => pendingBySymbol.delete(sym);
  run.then(clear, clear);
  return run;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function snapshot(a: SentinelAssessment): SentinelSnapshot {
  const s = a.signal;
  const council = a.council && a.council.votes.length > 0 ? a.council : undefined;
  return {
    call: s.call,
    conviction: s.conviction,
    rationale: s.rationale,
    price: s.price,
    entry: s.entry,
    stop: s.stop,
    target: s.target,
    technicalDirection: a.technical.overallDirection,
    councilDirection: council?.majorityDirection ?? null,
    councilConsensus: council?.consensus ?? null,
    councilDisagreements: council?.disagreements ?? [],
    timestamp: s.timestamp,
  };
}

export async function runPipeline(symbol: string, trigger: ProposalTrigger): Promise<DecisionRecord> {
  const record: DecisionRecord = {
    symbol,
    trigger,
    status: "error",
    action: null,
    proposedCall: null,
    sentinel: null,
    research: null,
    dialogue: { ran: false, skippedReason: null, turns: [] },
    votes: [],
    preDialogueConfidence: null,
    confidence: null,
    vetoReason: null,
    errors: [],
    summary: "",
    createdAt: Date.now(),
  };

  const finish = (status: ProposalStatus) => finalize(record, status);

  // --- Phase 1a: Sentinel ---
  let assessment: SentinelAssessment | null;
  try {
    assessment = await assessSymbol(symbol);
  } catch (err) {
    record.errors.push(`Sentinel failed: ${errorMessage(err)}`);
    return finish("error");
  }
  if (!assessment) {
    record.errors.push("Not enough market data for a Sentinel read.");
    return finish("error");
  }
  record.sentinel = snapshot(assessment);

  const action = actionFor(assessment.signal.call);
  if (!action) return finish("no_action");
  record.action = action;

  // --- Phase 1b: Research, blind to Sentinel's call ---
  try {
    record.research = await researchSymbol(symbol);
  } catch (err) {
    record.errors.push(`Research failed: ${errorMessage(err)}`);
    return finish("error");
  }
  const research = record.research;

  // --- Phase 2: objective vetoes, and the pre-dialogue ceiling ---
  const ages = () => {
    const now = Date.now();
    return { sentinelAgeMs: now - assessment!.signal.timestamp, researchAgeMs: now - research.timestamp };
  };
  const pre = computeConfidence({
    action,
    sentinelConviction: assessment.signal.conviction,
    researchDirection: research.direction,
    researchConfidence: research.confidence,
    ...ages(),
  });
  record.preDialogueConfidence = pre.confidence;
  record.confidence = pre;
  record.proposedCall = proposedCallFor(assessment.signal.call, pre.researchStance);

  const veto = researchVeto(research);
  if (veto) {
    record.vetoReason = `Research: ${veto}`;
    record.dialogue.skippedReason = "Vetoed before dialogue.";
    return finish("vetoed");
  }
  if (pre.confidence < CONSENSUS.threshold) {
    record.dialogue.skippedReason =
      "Already below the gate before dialogue, and dialogue can only lower confidence.";
    return finish("below_threshold");
  }

  // --- Phase 3: bounded dialogue ---
  // The transcript array is shared, so turns spoken before a failure are kept.
  record.dialogue = { ran: true, skippedReason: null, turns: [] };
  try {
    const result = await runDialogue(
      { symbol, action, sentinel: record.sentinel, research },
      record.dialogue.turns
    );

    // --- Phases 4-5: final confidence and the gate ---
    const final = computeConfidence({
      action,
      sentinelConviction: result.sentinelConviction,
      researchDirection: result.researchDirection,
      researchConfidence: result.researchConfidence,
      ...ages(),
    });
    record.confidence = final;
    record.proposedCall = proposedCallFor(assessment.signal.call, final.researchStance);
    return finish(final.confidence >= CONSENSUS.threshold ? "eligible" : "below_threshold");
  } catch (err) {
    record.errors.push(`Dialogue failed: ${errorMessage(err)}`);
    record.dialogue.skippedReason = `Dialogue failed after ${record.dialogue.turns.length} turn(s) — failing closed.`;
    return finish("error");
  }
}

// ---------------------------------------------------------------------------
// Votes, summary, persistence
// ---------------------------------------------------------------------------

function lastTurn(record: DecisionRecord, agent: "sentinel" | "research") {
  return [...record.dialogue.turns].reverse().find((t) => t.agent === agent);
}

export function buildVotes(record: DecisionRecord): AgentVote[] {
  const votes: AgentVote[] = [];
  const { action, sentinel, research } = record;

  if (sentinel) {
    const said = lastTurn(record, "sentinel");
    const conviction = said?.confidenceAfter ?? sentinel.conviction;
    votes.push({
      agent: "sentinel",
      direction: action ? directionOf(action) : "neutral",
      confidence: conviction,
      rationale: said ? `${sentinel.rationale} In dialogue: ${said.message}` : sentinel.rationale,
      // Withdrawing its own signal in dialogue counts as dissent.
      isDissent: action !== null && conviction === 0,
      veto: null,
      evaluated: true,
    });
  }

  if (research) {
    const said = lastTurn(record, "research");
    const direction: Direction = said?.directionAfter ?? research.direction;
    votes.push({
      agent: "research",
      direction,
      confidence: said?.confidenceAfter ?? research.confidence,
      rationale: said ? `${research.thesis} In dialogue: ${said.message}` : research.thesis,
      isDissent: action !== null && stanceOf(action, direction) !== "aligned",
      veto: researchVeto(research),
      evaluated: true,
    });
  }

  votes.push({
    agent: "execution",
    direction: null,
    confidence: null,
    rationale: "Not evaluated — the Execution agent (tradeability, sizing, risk limits) arrives in Phase D.",
    isDissent: false,
    veto: null,
    evaluated: false,
  });

  return votes;
}

export function summarize(record: DecisionRecord): string {
  const { symbol, action, status, sentinel, confidence } = record;
  const call = record.proposedCall?.replace("_", " ");
  const gate = confidence ? `${pct(confidence.confidence)} (gate ${pct(confidence.threshold)})` : "";
  const dissent = record.votes.filter((v) => v.isDissent);
  const dissentText = dissent.length
    ? ` Dissent — ${dissent.map((v) => `${v.agent} (${v.direction}): ${clip(v.rationale, 200)}`).join(" | ")}`
    : "";

  switch (status) {
    case "no_action":
      return `${symbol} — Sentinel says ${sentinel?.call.replace("_", " ") ?? "HOLD"}; nothing to propose.`;
    case "vetoed":
      return `${action} ${symbol} — vetoed. ${record.vetoReason}`;
    case "below_threshold":
      return `${action} ${symbol} — rejected at ${gate}.${dissentText || " No dissent; conviction was simply too low."}`;
    case "eligible":
      return `${call} ${symbol} — eligible at ${gate}.${dissentText || " Unanimous."} Logged only — no order placed.`;
    default:
      return `${symbol} — pipeline failed, so no proposal (fail closed). ${record.errors.join(" ")}`;
  }
}

async function finalize(record: DecisionRecord, status: ProposalStatus): Promise<DecisionRecord> {
  record.status = status;
  record.votes = buildVotes(record);
  record.summary = summarize(record);
  try {
    record.id = await saveDecisionRecord(record);
  } catch (err) {
    // No audit record, no proposal: an unsaved decision is never eligible.
    console.error(`[Orchestrator] Failed to save decision record for ${record.symbol}:`, err);
    record.errors.push(`Decision record not saved: ${errorMessage(err)}`);
    record.status = "error";
    record.summary = summarize(record);
  }
  console.log(`[Orchestrator] #${record.id ?? "unsaved"} ${record.summary}`);
  return record;
}
