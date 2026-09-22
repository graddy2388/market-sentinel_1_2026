/**
 * Delivery gate — decides whether something reaches Discord now, waits for the
 * morning, or isn't sent at all.
 *
 * Two rules, in order:
 * 1. Only watched symbols ping. A signal nobody asked about is recorded and
 *    left at that; the dashboard and the decision records still have it.
 * 2. During quiet hours nothing is pushed. It's held and folded into the next
 *    briefing instead of dropped — you should still learn what happened
 *    overnight, just not be woken for a call that expires before you read it.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { appConfig } from "../config.js";
import { getDb, saveDb } from "../state/db.js";
import { heldNotices } from "../state/schema.js";
import { isBeingWatched } from "../state/watches.js";

export type Delivery = "sent" | "held" | "not_watched" | "failed";

export type NoticeKind = "signal" | "proposal" | "watch_expired";

export interface HeldNotice {
  id: number;
  kind: NoticeKind;
  symbol: string;
  summary: string;
  createdAt: number;
}

/** The local hour, using the same offset the briefing schedules against. */
export function localHour(now = Date.now(), offsetHours = appConfig.BRIEFING_TZ_OFFSET): number {
  return new Date(now + offsetHours * 3_600_000).getUTCHours();
}

/**
 * Whether `now` falls in the quiet window. Handles a window that wraps
 * midnight (the default, 00:00–08:00, does not, but 22:00–07:00 would).
 * Equal start and end disables quiet hours entirely.
 */
export function isQuietHour(
  now = Date.now(),
  opts: { start?: number; end?: number; offsetHours?: number } = {}
): boolean {
  const start = opts.start ?? appConfig.QUIET_HOURS_START;
  const end = opts.end ?? appConfig.QUIET_HOURS_END;
  if (start === end) return false;

  const hour = localHour(now, opts.offsetHours ?? appConfig.BRIEFING_TZ_OFFSET);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Park a notice for the next briefing. */
export async function holdNotice(kind: NoticeKind, symbol: string, summary: string): Promise<void> {
  const db = await getDb();
  db.insert(heldNotices)
    .values({ kind, symbol: symbol.toUpperCase(), summary, createdAt: new Date().toISOString() })
    .run();
  saveDb();
}

/**
 * Everything held since the last delivery, marked delivered as it's handed
 * over so nothing is reported twice.
 */
export async function takeHeldNotices(now = Date.now()): Promise<HeldNotice[]> {
  const db = await getDb();
  const rows = db
    .select()
    .from(heldNotices)
    .where(isNull(heldNotices.deliveredAt))
    .orderBy(asc(heldNotices.createdAt))
    .all();

  if (rows.length === 0) return [];

  for (const row of rows) {
    db.update(heldNotices)
      .set({ deliveredAt: new Date(now).toISOString() })
      .where(eq(heldNotices.id, row.id))
      .run();
  }
  saveDb();

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    symbol: r.symbol,
    summary: r.summary,
    createdAt: Date.parse(r.createdAt),
  }));
}

/** Count of what's waiting, without consuming it. */
export async function countHeldNotices(): Promise<number> {
  const db = await getDb();
  return db.select().from(heldNotices).where(isNull(heldNotices.deliveredAt)).all().length;
}

/**
 * Route one notification. `send` is only called when it should go out now.
 * Never throws: a delivery failure is reported, not propagated into the
 * signal pipeline.
 *
 * @param opts.requireWatch Defaults to true. Set false for notices that aren't
 * about a live watch — a watch-expiry notice would otherwise be dropped,
 * since by then the watch is over.
 */
export async function deliver(
  kind: NoticeKind,
  symbol: string,
  summary: string,
  send: () => Promise<void>,
  opts: { requireWatch?: boolean; now?: number } = {}
): Promise<Delivery> {
  const now = opts.now ?? Date.now();
  try {
    if (opts.requireWatch !== false && !(await isBeingWatched(symbol, now))) {
      return "not_watched";
    }

    if (isQuietHour(now)) {
      await holdNotice(kind, symbol, summary);
      return "held";
    }

    await send();
    return "sent";
  } catch (err) {
    console.error(`[Notify] Failed to deliver ${kind} for ${symbol}:`, err);
    return "failed";
  }
}

/** Unused elsewhere; exported for tests that need a clean slate. */
export async function _clearHeldNotices(): Promise<void> {
  const db = await getDb();
  db.delete(heldNotices).where(and()).run();
  saveDb();
}
