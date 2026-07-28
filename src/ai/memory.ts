/**
 * Rolling conversation memory.
 *
 * Keeps a short, bounded history per session (a Discord channel/DM, or the web
 * dashboard) so the bot can answer follow-ups like "why bearish?" or "what
 * about the entry?" without the user repeating context.
 *
 * Deliberately in-memory and ephemeral:
 * - History is conversational context, not a system of record — the SQLite DB
 *   holds the durable data (positions, alerts, signal history).
 * - Bounded on every axis (turns, chars, age, session count) so a busy server
 *   can't grow memory or token spend without limit.
 * - Cleared on restart, which is the honest behavior to advertise.
 */

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

/** Max turns retained per session (user+assistant messages combined). */
export const MAX_TURNS = 12;

/** Max characters kept per turn — long council dumps get summarized down. */
export const MAX_TURN_CHARS = 1500;

/** Sessions idle longer than this are dropped. */
export const SESSION_TTL_MS = 2 * 60 * 60_000; // 2 hours

/** Hard cap on tracked sessions; least-recently-used is evicted past this. */
export const MAX_SESSIONS = 500;

interface Session {
  turns: ConversationTurn[];
  lastActivity: number;
}

const sessions = new Map<string, Session>();

function pruneExpired(now: number): void {
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) sessions.delete(id);
  }
}

function evictLruIfNeeded(): void {
  if (sessions.size <= MAX_SESSIONS) return;
  let oldestId: string | null = null;
  let oldestAt = Infinity;
  for (const [id, s] of sessions) {
    if (s.lastActivity < oldestAt) {
      oldestAt = s.lastActivity;
      oldestId = id;
    }
  }
  if (oldestId) sessions.delete(oldestId);
}

/** Truncate a turn so a single long reply can't dominate the context window. */
function clampContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_TURN_CHARS) return trimmed;
  return trimmed.slice(0, MAX_TURN_CHARS - 3) + "...";
}

/**
 * Append a turn to a session's history.
 * Empty content is ignored (nothing useful to recall).
 */
export function recordTurn(
  sessionId: string,
  role: ConversationTurn["role"],
  content: string
): void {
  if (!sessionId || !content?.trim()) return;

  const now = Date.now();
  pruneExpired(now);

  let session = sessions.get(sessionId);
  if (!session) {
    session = { turns: [], lastActivity: now };
    sessions.set(sessionId, session);
    evictLruIfNeeded();
  }

  session.turns.push({ role, content: clampContent(content), timestamp: now });
  if (session.turns.length > MAX_TURNS) {
    session.turns.splice(0, session.turns.length - MAX_TURNS);
  }
  session.lastActivity = now;
}

/**
 * Get the recent turns for a session, oldest first.
 * Returns [] for unknown or expired sessions.
 */
export function getHistory(sessionId: string): ConversationTurn[] {
  if (!sessionId) return [];
  const session = sessions.get(sessionId);
  if (!session) return [];
  if (Date.now() - session.lastActivity > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return [];
  }
  return session.turns.slice();
}

/** Forget a single session (e.g. an explicit "reset" command). */
export function clearSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

/** Test/maintenance helper: drop all sessions. */
export function clearAllSessions(): void {
  sessions.clear();
}

/** Number of tracked sessions (diagnostics/tests). */
export function sessionCount(): number {
  return sessions.size;
}
