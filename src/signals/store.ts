/**
 * Persistence + change-detection for graded signals.
 *
 * Stores a queryable core plus the full GradedSignal JSON payload, so the
 * dashboard and Discord embeds can rehydrate the complete signal while the
 * monitor can cheaply query the latest call per symbol.
 */
import { desc, eq, gte } from "drizzle-orm";
import { getDb, saveDb } from "../state/db.js";
import { signalHistory } from "../state/schema.js";
import type { GradedSignal } from "./scorer.js";

/** Minimum conviction movement (same call) that still warrants a new push. */
const CONVICTION_DELTA_THRESHOLD = 0.15;

/** Persist a graded signal to history. */
export async function insertSignal(signal: GradedSignal): Promise<void> {
  const db = await getDb();
  db.insert(signalHistory)
    .values({
      symbol: signal.symbol,
      call: signal.call,
      conviction: signal.conviction,
      price: signal.price,
      entry: signal.entry,
      stop: signal.stop,
      target: signal.target,
      technicalDirection: signal.components.technical,
      aiDirection: signal.components.ai ?? null,
      agreement: signal.components.agreement,
      payload: JSON.stringify(signal),
      createdAt: new Date(signal.timestamp).toISOString(),
    })
    .run();
  saveDb();
}

/** Get the most recent graded signal for a symbol, or null if none. */
export async function getLatestSignal(symbol: string): Promise<GradedSignal | null> {
  const db = await getDb();
  const row = db
    .select()
    .from(signalHistory)
    .where(eq(signalHistory.symbol, symbol.toUpperCase()))
    .orderBy(desc(signalHistory.createdAt), desc(signalHistory.id))
    .limit(1)
    .get();

  if (!row) return null;
  try {
    return JSON.parse(row.payload) as GradedSignal;
  } catch {
    return null;
  }
}

/** Get the latest graded signal for every symbol that has one. */
export async function getAllLatestSignals(): Promise<GradedSignal[]> {
  const db = await getDb();
  const rows = db
    .select()
    .from(signalHistory)
    .orderBy(desc(signalHistory.createdAt), desc(signalHistory.id))
    .all();

  const seen = new Set<string>();
  const latest: GradedSignal[] = [];
  for (const row of rows) {
    if (seen.has(row.symbol)) continue;
    seen.add(row.symbol);
    try {
      latest.push(JSON.parse(row.payload) as GradedSignal);
    } catch {
      // Skip corrupt payloads
    }
  }
  return latest;
}

/**
 * Minimum time between posts for the same symbol, unless the signal flips
 * between bullish and bearish.
 *
 * The monitor re-scores on every 1-minute candle, and the 1h indicators include
 * the still-forming hour, so strength can swing within minutes. Without this,
 * XRP posted STRONG BUY -> BUY -> STRONG BUY in seven minutes.
 */
export const MIN_REPOST_INTERVAL_MS = 60 * 60_000;

type Side = "bullish" | "bearish" | "none";

function sideOf(call: GradedSignal["call"]): Side {
  if (call === "BUY" || call === "STRONG_BUY") return "bullish";
  if (call === "SELL" || call === "STRONG_SELL") return "bearish";
  return "none";
}

/**
 * Decide whether `next` is a meaningful change from `prev` worth pushing.
 *
 * Spam policy:
 * - HOLD never follows HOLD: movement below the action threshold (26% → 0%)
 *   is noise, not news.
 * - A bullish ↔ bearish flip always posts immediately — it's the one change
 *   someone acting on the prior call can't afford to hear about late.
 * - Anything else (a call change, or a conviction move beyond the threshold)
 *   posts only once MIN_REPOST_INTERVAL_MS has passed since the last post.
 *   Suppressed signals aren't persisted, so the comparison stays against what
 *   the channel actually saw.
 * - The first-ever actionable signal always posts.
 */
export function hasSignalChanged(prev: GradedSignal | null, next: GradedSignal): boolean {
  if (next.call === "HOLD" && (!prev || prev.call === "HOLD")) return false;
  if (!prev) return true;

  const prevSide = sideOf(prev.call);
  const nextSide = sideOf(next.call);
  if (prevSide !== "none" && nextSide !== "none" && prevSide !== nextSide) return true;

  const changed =
    prev.call !== next.call ||
    Math.abs(next.conviction - prev.conviction) > CONVICTION_DELTA_THRESHOLD;
  if (!changed) return false;

  return next.timestamp - prev.timestamp >= MIN_REPOST_INTERVAL_MS;
}

/** Signals posted since `sinceMs`, newest first — what the channel has recently seen. */
export async function getRecentSignals(sinceMs: number, limit = 5): Promise<GradedSignal[]> {
  const db = await getDb();
  const rows = db
    .select()
    .from(signalHistory)
    .where(gte(signalHistory.createdAt, new Date(sinceMs).toISOString()))
    .orderBy(desc(signalHistory.createdAt), desc(signalHistory.id))
    .limit(limit)
    .all();

  const signals: GradedSignal[] = [];
  for (const row of rows) {
    try {
      signals.push(JSON.parse(row.payload) as GradedSignal);
    } catch {
      // Skip corrupt payloads
    }
  }
  return signals;
}
