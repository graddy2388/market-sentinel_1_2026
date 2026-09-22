/**
 * Watches — explicit, time-boxed permission to interrupt.
 *
 * Live signal pings used to follow the watchlist, which meant they never
 * stopped. A graded signal decays within the hour (see the freshness factor in
 * agents/consensus.ts), so an unsolicited overnight post is a stale call by the
 * time it's read. A watch says "I care about this symbol right now, until X".
 */
import { and, desc, eq, isNull, or, gt } from "drizzle-orm";
import { getDb, saveDb } from "./db.js";
import { watches } from "./schema.js";

/** Used when someone asks for a watch without saying how long. */
export const DEFAULT_WATCH_MINUTES = 4 * 60;

export interface Watch {
  id: number;
  symbol: string;
  /** Null means indefinite. */
  expiresAt: number | null;
  createdBy: string | null;
  createdAt: number;
}

export interface StartWatchResult extends Watch {
  /** True when this extended or replaced a watch that was already running. */
  replaced: boolean;
}

function toWatch(row: typeof watches.$inferSelect): Watch {
  return {
    id: row.id,
    symbol: row.symbol.toUpperCase(),
    expiresAt: row.expiresAt ? Date.parse(row.expiresAt) : null,
    createdBy: row.createdBy,
    createdAt: Date.parse(row.createdAt),
  };
}

/** Every watch still running: not stopped, and not past its expiry. */
export async function listActiveWatches(now = Date.now()): Promise<Watch[]> {
  const db = await getDb();
  const rows = db
    .select()
    .from(watches)
    .where(
      and(
        isNull(watches.stoppedAt),
        or(isNull(watches.expiresAt), gt(watches.expiresAt, new Date(now).toISOString()))
      )
    )
    .orderBy(desc(watches.createdAt))
    .all();
  return rows.map(toWatch);
}

export async function getActiveWatch(symbol: string, now = Date.now()): Promise<Watch | null> {
  const active = await listActiveWatches(now);
  return active.find((w) => w.symbol === symbol.toUpperCase()) ?? null;
}

/** Whether live pings are currently allowed for this symbol. */
export async function isBeingWatched(symbol: string, now = Date.now()): Promise<boolean> {
  return (await getActiveWatch(symbol, now)) !== null;
}

/**
 * Start watching a symbol. An existing watch is replaced rather than
 * duplicated, so "watch XRP for another hour" extends instead of stacking.
 *
 * @param durationMinutes Omitted uses the default; null watches indefinitely.
 */
export async function startWatch(
  symbol: string,
  opts: { durationMinutes?: number | null; createdBy?: string; now?: number } = {}
): Promise<StartWatchResult> {
  const sym = symbol.toUpperCase();
  const now = opts.now ?? Date.now();
  const minutes = opts.durationMinutes === undefined ? DEFAULT_WATCH_MINUTES : opts.durationMinutes;
  const expiresAt = minutes === null ? null : now + minutes * 60_000;

  const existing = await getActiveWatch(sym, now);
  const db = await getDb();

  if (existing) {
    db.update(watches)
      .set({ expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() })
      .where(eq(watches.id, existing.id))
      .run();
    saveDb();
    return { ...existing, expiresAt, replaced: true };
  }

  const row = db
    .insert(watches)
    .values({
      symbol: sym,
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      createdBy: opts.createdBy ?? null,
      createdAt: new Date(now).toISOString(),
    })
    .returning({ id: watches.id })
    .get();
  saveDb();

  return {
    id: row.id,
    symbol: sym,
    expiresAt,
    createdBy: opts.createdBy ?? null,
    createdAt: now,
    replaced: false,
  };
}

/** Stop watching. Returns false when nothing was running. */
export async function stopWatch(symbol: string, now = Date.now()): Promise<boolean> {
  const existing = await getActiveWatch(symbol, now);
  if (!existing) return false;

  const db = await getDb();
  db.update(watches)
    .set({ stoppedAt: new Date(now).toISOString() })
    .where(eq(watches.id, existing.id))
    .run();
  saveDb();
  return true;
}

/**
 * Watches that ran out since the last check, so the channel can be told the
 * pings have stopped. Marks them stopped so each is reported once.
 */
export async function collectExpiredWatches(now = Date.now()): Promise<Watch[]> {
  const db = await getDb();
  const rows = db.select().from(watches).where(isNull(watches.stoppedAt)).all();

  const expired = rows
    .filter((r) => r.expiresAt != null && Date.parse(r.expiresAt) <= now)
    .map(toWatch);

  for (const watch of expired) {
    db.update(watches)
      .set({ stoppedAt: new Date(now).toISOString() })
      .where(eq(watches.id, watch.id))
      .run();
  }
  if (expired.length > 0) saveDb();
  return expired;
}
