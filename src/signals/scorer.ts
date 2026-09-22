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

/**
 * A target must pay at least this multiple of the risk to the stop. Council
 * key levels are averaged across models and can be up to 15 minutes old, so a
 * "resistance" can end up a hair above price — which once produced a STRONG
 * BUY with target == entry (+0.1% reward against a -3% stop).
 */
export const MIN_REWARD_RISK = 1.5;

/** A support-based stop tighter than this fraction of the default is noise. */
const MIN_STOP_FRACTION = 0.5;

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

/** Enough precision to see a level sitting right on price ($1.5781 vs $1.5802). */
export function formatLevel(n: number): string {
  if (n >= 100) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(4)}`;
}

/**
 * Compute entry/stop/target.
 * - Entry is the current price.
 * - For a long (buy) bias: stop below, target above. Inverted for short bias.
 * - Prefer aggregated support/resistance; otherwise use ATR; otherwise a %.
 * - A key level is only used when it makes a sane trade: the stop can't be
 *   noise-tight, and the target must clear MIN_REWARD_RISK x the risk.
 *   Rejected levels are reported in `notes` rather than silently dropped.
 */
export function deriveLevels(
  price: number,
  isLong: boolean,
  atr: number | null,
  keyLevels: { support: number | null; resistance: number | null }
): { entry: number; stop: number; target: number; notes: string[] } {
  const entry = price;
  const notes: string[] = [];

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

  // Long: stop at support below, target at resistance above. Short: mirrored.
  // `dir` turns "distance in the trade's favor" into a price.
  const dir = isLong ? 1 : -1;
  const stopLevel = isLong ? keyLevels.support : keyLevels.resistance;
  const targetLevel = isLong ? keyLevels.resistance : keyLevels.support;
  const stopName = isLong ? "support" : "resistance";
  const targetName = isLong ? "resistance" : "support";

  let stop = price - dir * stopDist;
  if (stopLevel != null) {
    const levelRisk = (price - stopLevel) * dir;
    if (levelRisk >= MIN_STOP_FRACTION * stopDist) {
      stop = stopLevel;
    } else if (levelRisk > 0) {
      notes.push(`${stopName} at ${formatLevel(stopLevel)} is too close for a stop; using ATR`);
    }
  }

  const risk = (price - stop) * dir;
  const minReward = MIN_REWARD_RISK * risk;

  let target = price + dir * Math.max(targetDist, minReward);
  if (targetLevel != null) {
    const levelReward = (targetLevel - price) * dir;
    if (levelReward >= minReward) {
      target = targetLevel;
    } else if (levelReward > -stopDist) {
      // At or just past price: the level is stale or being tested right now.
      notes.push(
        `${targetName} at ${formatLevel(targetLevel)} is too close to price to target ` +
          `(under ${MIN_REWARD_RISK}:1 reward/risk); using ATR`
      );
    }
  }

  return { entry, stop, target, notes };
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

  const { entry, stop, target, notes: levelNotes } = deriveLevels(
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
  let rationale = `${callLabel(call)} @ ${(conviction * 100).toFixed(0)}% conviction. ${parts.join(" ")}.`;
  // Levels are meaningless for HOLD, so their caveats would be too.
  if (call !== "HOLD" && levelNotes.length > 0) {
    rationale += ` Note: ${levelNotes.join("; ")}.`;
  }

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
