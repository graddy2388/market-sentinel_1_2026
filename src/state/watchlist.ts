/**
 * Watchlist service — the single source of truth for watchlist mutations.
 *
 * Previously each interface hand-rolled its own DB calls, which drifted: the
 * MCP handler did a bare `db.insert`, so adding the same symbol twice created
 * duplicate rows (and double-listed it in the daily briefing). The Discord
 * surface had no write path at all, which is why the bot could only *claim* it
 * had added a coin. MCP, CLI, and the chat tool all route through here now.
 */
import { eq } from "drizzle-orm";
import { getDb, saveDb } from "./db.js";
import { watchlist } from "./schema.js";
import { resolveMarket } from "../data/providers.js";
import type { MarketType } from "../data/types.js";

export interface WatchlistEntry {
  symbol: string;
  market: MarketType;
  addedAt: string;
}

export interface WatchlistAddResult {
  symbol: string;
  market: MarketType;
  /** False when the symbol was already present (no duplicate row written). */
  added: boolean;
}

/** All watchlist entries, oldest first. */
export async function listWatchlist(): Promise<WatchlistEntry[]> {
  const db = await getDb();
  return db
    .select()
    .from(watchlist)
    .all()
    .map((r) => ({
      symbol: r.symbol.toUpperCase(),
      market: r.market as MarketType,
      addedAt: r.addedAt,
    }));
}

/** True when the symbol is already tracked. */
export async function isWatched(symbol: string): Promise<boolean> {
  const upper = symbol.toUpperCase();
  const rows = await listWatchlist();
  return rows.some((r) => r.symbol === upper);
}

/**
 * Add a symbol to the watchlist. Idempotent — re-adding an existing symbol is
 * a no-op that reports `added: false` rather than writing a duplicate row.
 *
 * When `market` is omitted it is resolved from live data (so VVV lands as
 * crypto and SPY as stock) instead of blindly defaulting to "crypto".
 */
export async function addToWatchlist(
  symbol: string,
  market?: MarketType
): Promise<WatchlistAddResult> {
  const upper = symbol.toUpperCase();
  const resolved: MarketType = market ?? (await resolveMarket(upper)) ?? "crypto";

  if (await isWatched(upper)) {
    return { symbol: upper, market: resolved, added: false };
  }

  const db = await getDb();
  db.insert(watchlist).values({ symbol: upper, market: resolved }).run();
  saveDb();
  return { symbol: upper, market: resolved, added: true };
}

/** Remove a symbol. Returns false when it wasn't on the list. */
export async function removeFromWatchlist(symbol: string): Promise<boolean> {
  const upper = symbol.toUpperCase();
  if (!(await isWatched(upper))) return false;

  const db = await getDb();
  db.delete(watchlist).where(eq(watchlist.symbol, upper)).run();
  saveDb();
  return true;
}
