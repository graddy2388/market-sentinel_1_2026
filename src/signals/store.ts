/**
 * Persistence + change-detection for graded signals.
 *
 * Stores a queryable core plus the full GradedSignal JSON payload, so the
 * dashboard and Discord embeds can rehydrate the complete signal while the
 * monitor can cheaply query the latest call per symbol.
 */
import { desc, eq } from "drizzle-orm";
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
 * Decide whether `next` is a meaningful change from `prev` worth pushing.
 *
 * Spam policy: notify on a call change (which also covers STRONG↔normal band
 * crossings, since those are distinct call values), or a conviction move
 * larger than the threshold for the same call. First-ever signal always counts.
 */
export function hasSignalChanged(prev: GradedSignal | null, next: GradedSignal): boolean {
  if (!prev) return true;
  if (prev.call !== next.call) return true;
  if (Math.abs(next.conviction - prev.conviction) > CONVICTION_DELTA_THRESHOLD) return true;
  return false;
}
