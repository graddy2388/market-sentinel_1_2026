/**
 * Graded signal scorer.
 *
 * Fuses the local technical read (direction + strength) with the AI council's
 * majority vote into a single conviction-scored BUY/SELL/HOLD call, and derives
 * entry/stop/target levels.
 *
 * Design notes:
 * - Council key levels live PER VOTE (`votes[].analysis.keyLevels`), not at the
 *   top of CouncilAnalysisResult — they must be aggregated.
 * - A council with zero votes (all providers failed) is treated as ABSENT, not
 *   as a real "neutral" call. `councilAnalyze` returns majorityDirection:
 *   "neutral", avgConfidence: 0 on total failure.
 * - `indicators.atr` can be null — fall back to a percentage stop.
 */
import type { TechnicalSummary, SignalDirection } from "../analysis/types.js";
import type { CouncilAnalysisResult } from "../ai/types.js";

export type SignalCall = "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL";

export interface GradedSignal {
  symbol: string;
  call: SignalCall;
  conviction: number; // 0–1
  price: number;
  entry: number;
  stop: number;
  target: number;
  rationale: string;
  components: {
    technical: SignalDirection;
    ai?: SignalDirection;
    agreement: boolean;
  };
  timestamp: number;
}

// Weighting between the technical read and the AI council when both present.
const TECHNICAL_WEIGHT = 0.5;
const AI_WEIGHT = 0.5;

// Conviction thresholds for grading.
const STRONG_THRESHOLD = 0.7;
const ACTION_THRESHOLD = 0.3;

// ATR multipliers for stop/target (1:2 risk-reward).
const ATR_STOP_MULT = 1.5;
const ATR_TARGET_MULT = 3.0;

// Percentage fallback when ATR is unavailable (crypto is volatile).
const PCT_STOP = 0.025; // 2.5%
const PCT_TARGET = 0.05; // 5%

/** Map a signal direction to a signed score in [-1, 1]. */
function directionScore(direction: SignalDirection, strength: number): number {
  if (direction === "bullish") return strength;
  if (direction === "bearish") return -strength;
  return 0;
}

/**
 * Determine whether a council result is usable.
 * Zero votes means every provider failed — treat as absent, not neutral.
 */
function councilIsPresent(council?: CouncilAnalysisResult): council is CouncilAnalysisResult {
  return !!council && council.votes.length > 0;
}

/** Aggregate support/resistance across all council votes (levels are per-vote). */
function aggregateKeyLevels(council: CouncilAnalysisResult): {
  support: number | null;
  resistance: number | null;
} {
  const supports = council.votes
    .map((v) => v.analysis.keyLevels.support)
    .filter((n): n is number => n != null);
  const resistances = council.votes
    .map((v) => v.analysis.keyLevels.resistance)
    .filter((n): n is number => n != null);

  const avg = (arr: number[]): number | null =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return { support: avg(supports), resistance: avg(resistances) };
}

/** Convert a net signed score in [-1, 1] into a graded call. */
function gradeCall(net: number): SignalCall {
  const mag = Math.abs(net);
  if (net > 0) {
    if (mag >= STRONG_THRESHOLD) return "STRONG_BUY";
    if (mag >= ACTION_THRESHOLD) return "BUY";
    return "HOLD";
  }
  if (net < 0) {
    if (mag >= STRONG_THRESHOLD) return "STRONG_SELL";
    if (mag >= ACTION_THRESHOLD) return "SELL";
    return "HOLD";
  }
  return "HOLD";
}

/**
 * Compute entry/stop/target.
 * - Entry is the current price.
 * - For a long (buy) bias: stop below, target above. Inverted for short bias.
 * - Prefer aggregated support/resistance; otherwise use ATR; otherwise a %.
 */
function deriveLevels(
  price: number,
  isLong: boolean,
  atr: number | null,
  keyLevels: { support: number | null; resistance: number | null }
): { entry: number; stop: number; target: number } {
  const entry = price;

  // ATR-based or percentage-based defaults.
  let stopDist: number;
  let targetDist: number;
  if (atr != null && atr > 0) {
    stopDist = ATR_STOP_MULT * atr;
    targetDist = ATR_TARGET_MULT * atr;
  } else {
    stopDist = PCT_STOP * price;
    targetDist = PCT_TARGET * price;
  }

  let stop: number;
  let target: number;
  if (isLong) {
    // Prefer a real support level for the stop if it sits below price.
    stop =
      keyLevels.support != null && keyLevels.support < price
        ? keyLevels.support
        : price - stopDist;
    target =
      keyLevels.resistance != null && keyLevels.resistance > price
        ? keyLevels.resistance
        : price + targetDist;
  } else {
    stop =
      keyLevels.resistance != null && keyLevels.resistance > price
        ? keyLevels.resistance
        : price + stopDist;
    target =
      keyLevels.support != null && keyLevels.support < price
        ? keyLevels.support
        : price - targetDist;
  }

  return { entry, stop, target };
}

function callLabel(call: SignalCall): string {
  return call.replace("_", " ");
}

/**
 * Score a graded signal by fusing the technical read with the AI council.
 *
 * @param technical The local technical summary (required).
 * @param council   Optional AI council result. Treated as absent if it has no votes.
 */
export function scoreSignal(
  technical: TechnicalSummary,
  council?: CouncilAnalysisResult
): GradedSignal {
  const techNet = directionScore(technical.overallDirection, technical.overallStrength);

  let net: number;
  let aiDirection: SignalDirection | undefined;
  let agreement = false;

  if (councilIsPresent(council)) {
    aiDirection = council.majorityDirection;
    const aiNet = directionScore(council.majorityDirection, council.avgConfidence);
    net = TECHNICAL_WEIGHT * techNet + AI_WEIGHT * aiNet;
    agreement =
      technical.overallDirection !== "neutral" &&
      technical.overallDirection === council.majorityDirection;
  } else {
    // Technical-only — no usable AI input.
    net = techNet;
  }

  const call = gradeCall(net);
  const conviction = Math.min(Math.abs(net), 1);
  const isLong = net > 0;

  const keyLevels = councilIsPresent(council)
    ? aggregateKeyLevels(council)
    : { support: null, resistance: null };

  const { entry, stop, target } = deriveLevels(
    technical.price,
    isLong,
    technical.indicators.atr,
    keyLevels
  );

  // Build a concise rationale.
  const parts: string[] = [];
  parts.push(`Technicals ${technical.overallDirection} (${(technical.overallStrength * 100).toFixed(0)}%)`);
  if (councilIsPresent(council)) {
    parts.push(
      `AI council ${council.majorityDirection} (${(council.avgConfidence * 100).toFixed(0)}% avg conf)`
    );
    parts.push(agreement ? "— in agreement" : "— mixed");
  } else {
    parts.push("AI council unavailable — technical-only");
  }
  const rationale = `${callLabel(call)} @ ${(conviction * 100).toFixed(0)}% conviction. ${parts.join(" ")}.`;

  return {
    symbol: technical.symbol,
    call,
    conviction,
    price: technical.price,
    entry,
    stop,
    target,
    rationale,
    components: {
      technical: technical.overallDirection,
      ai: aiDirection,
      agreement,
    },
    timestamp: Date.now(),
  };
}
