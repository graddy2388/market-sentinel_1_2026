/**
 * Historical base rates from the system's own past calls.
 *
 * This is the most honest research input available: rather than asking a model
 * whether a setup looks good, it asks how this system's previous calls on this
 * symbol actually resolved. No external API, no vendor opinion — just the
 * signal_history table graded against subsequent price.
 *
 * A low hit rate is a legitimate reason for the Research Agent to argue against
 * a trade even when the technicals look clean.
 */
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../state/db.js";
import { signalHistory } from "../../state/schema.js";
import { fetchCandlesCached } from "../../data/providers.js";
import type { SignalCall } from "../../signals/scorer.js";

/** How far after a signal to measure the outcome. */
const HORIZON_MS = 24 * 60 * 60_000;

/** Move smaller than this counts as flat, not a win or a loss. */
const FLAT_THRESHOLD_PERCENT = 0.5;

/** Past signals considered per symbol. */
const MAX_SIGNALS = 40;

export interface SignalOutcome {
  call: SignalCall;
  conviction: number;
  at: string;
  priceAtSignal: number;
  priceAfter: number | null;
  changePercent: number | null;
  /** null when the horizon hasn't elapsed or no price data covers it. */
  correct: boolean | null;
}

export interface BacktestSummary {
  symbol: string;
  totalSignals: number;
  graded: number;
  hitRate: number | null;
  avgMovePercent: number | null;
  byCall: Record<string, { count: number; graded: number; hitRate: number | null }>;
  recent: SignalOutcome[];
  note: string;
}

function isBullish(call: SignalCall): boolean {
  return call === "BUY" || call === "STRONG_BUY";
}
function isBearish(call: SignalCall): boolean {
  return call === "SELL" || call === "STRONG_SELL";
}

/**
 * Grade a directional call against a subsequent move.
 * HOLD is never graded — there's no directional claim to be right or wrong about.
 */
function gradeCall(call: SignalCall, changePercent: number): boolean | null {
  if (Math.abs(changePercent) < FLAT_THRESHOLD_PERCENT) return null;
  if (isBullish(call)) return changePercent > 0;
  if (isBearish(call)) return changePercent < 0;
  return null;
}

/**
 * How did past calls on this symbol actually resolve?
 *
 * Outcomes are measured against the hourly candle series, so only signals
 * inside the available candle window can be graded. Everything else is counted
 * but reported as ungraded rather than silently dropped.
 */
export async function backtestSymbol(symbol: string): Promise<BacktestSummary> {
  const sym = symbol.toUpperCase();
  const db = await getDb();

  const rows = db
    .select()
    .from(signalHistory)
    .where(eq(signalHistory.symbol, sym))
    .orderBy(desc(signalHistory.createdAt))
    .limit(MAX_SIGNALS)
    .all();

  const empty: BacktestSummary = {
    symbol: sym,
    totalSignals: 0,
    graded: 0,
    hitRate: null,
    avgMovePercent: null,
    byCall: {},
    recent: [],
    note: "No prior signals recorded for this symbol.",
  };
  if (rows.length === 0) return empty;

  // Hourly candles give us the "price N hours later" reference.
  const candles = await fetchCandlesCached(sym, "1h", 250);
  const priceAt = (targetMs: number): number | null => {
    if (candles.length === 0) return null;
    // Candles must actually span the target time, or the "outcome" is fiction.
    const first = candles[0].timestamp;
    const last = candles[candles.length - 1].timestamp;
    if (targetMs < first || targetMs > last) return null;

    let closest = candles[0];
    let bestDelta = Infinity;
    for (const c of candles) {
      const delta = Math.abs(c.timestamp - targetMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        closest = c;
      }
    }
    return closest.close;
  };

  const outcomes: SignalOutcome[] = rows.map((r) => {
    const signalMs = Date.parse(r.createdAt);
    const after = Number.isFinite(signalMs) ? priceAt(signalMs + HORIZON_MS) : null;
    const changePercent =
      after != null && r.price > 0 ? ((after - r.price) / r.price) * 100 : null;

    return {
      call: r.call as SignalCall,
      conviction: r.conviction,
      at: r.createdAt,
      priceAtSignal: r.price,
      priceAfter: after,
      changePercent: changePercent != null ? Number(changePercent.toFixed(2)) : null,
      correct: changePercent != null ? gradeCall(r.call as SignalCall, changePercent) : null,
    };
  });

  const graded = outcomes.filter((o) => o.correct !== null);
  const hits = graded.filter((o) => o.correct === true).length;

  const byCall: BacktestSummary["byCall"] = {};
  for (const o of outcomes) {
    const bucket = (byCall[o.call] ??= { count: 0, graded: 0, hitRate: null });
    bucket.count++;
    if (o.correct !== null) bucket.graded++;
  }
  for (const [call, bucket] of Object.entries(byCall)) {
    const callGraded = graded.filter((o) => o.call === call);
    bucket.hitRate =
      callGraded.length > 0
        ? Number(
            (callGraded.filter((o) => o.correct === true).length / callGraded.length).toFixed(2)
          )
        : null;
  }

  const movesWithSign = graded
    .map((o) => {
      // Express the move in the direction the call was betting on, so a correct
      // SELL shows as a positive result rather than a negative price change.
      if (o.changePercent == null) return null;
      if (isBearish(o.call)) return -o.changePercent;
      return o.changePercent;
    })
    .filter((v): v is number => v !== null);

  return {
    symbol: sym,
    totalSignals: outcomes.length,
    graded: graded.length,
    hitRate: graded.length > 0 ? Number((hits / graded.length).toFixed(2)) : null,
    avgMovePercent:
      movesWithSign.length > 0
        ? Number((movesWithSign.reduce((a, b) => a + b, 0) / movesWithSign.length).toFixed(2))
        : null,
    byCall,
    recent: outcomes.slice(0, 5),
    note:
      graded.length === 0
        ? "Signals exist but none could be graded — the candle window doesn't cover their outcome horizon yet."
        : `${graded.length} of ${outcomes.length} prior signals graded over a ${HORIZON_MS / 3_600_000}h horizon.`,
  };
}
