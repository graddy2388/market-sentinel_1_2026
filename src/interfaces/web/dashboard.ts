/**
 * Web dashboard request handler.
 *
 * Served from the same HTTP server as MCP (port 3100). Returns `true` when it
 * has handled the request, so the main server can fall through to its 404.
 *
 * Auth: a shared DASHBOARD_TOKEN. The browser bootstraps via /dashboard?token=…,
 * which sets an HttpOnly; SameSite=Strict cookie and redirects to a clean URL
 * (keeping the token out of the address bar / history). All /api/* and /events
 * requests are then authorized by the cookie — browsers can't attach custom
 * headers to EventSource, so a header-based scheme wouldn't work for SSE.
 *
 * When DASHBOARD_TOKEN is unset the dashboard is disabled entirely (the handler
 * declines every route, so they 404) — it can never be exposed unauthenticated.
 */
import { readFile } from "fs/promises";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { appConfig, hasDashboard } from "../../config.js";
import { fetch24hrCached } from "../../data/providers.js";
import { getDb } from "../../state/db.js";
import { watchlist, positions } from "../../state/schema.js";
import { getAllLatestSignals } from "../../signals/store.js";
import { handleChatMessage } from "../discord/chat.js";
import { bus } from "../../events/bus.js";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const COOKIE_NAME = "ms_dash";
const COOKIE_MAX_AGE = 12 * 60 * 60; // 12 hours
const MAX_CHAT_BODY = 8 * 1024; // 8 KB — chat messages are small
const MAX_CHAT_MESSAGE = 2000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Constant-time token comparison (avoids leaking length/contents via timing). */
function validToken(candidate: string | null | undefined): boolean {
  const secret = appConfig.DASHBOARD_TOKEN;
  if (!secret || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isAuthed(req: IncomingMessage): boolean {
  const cookies = parseCookies(req.headers.cookie);
  return validToken(cookies[COOKIE_NAME]);
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized. Open /dashboard?token=YOUR_TOKEN to sign in." }));
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

async function serveStatic(res: ServerResponse, fileName: string): Promise<void> {
  const ext = extname(fileName).toLowerCase();
  const mime = MIME[ext];
  // Only serve known, whitelisted asset types from the web dir.
  if (!mime) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  const fullPath = join(WEB_DIR, fileName);
  // Path-traversal guard: resolved path must stay inside WEB_DIR.
  if (!fullPath.startsWith(WEB_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(fullPath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}

// ---------------------------------------------------------------------------
// API: snapshot
// ---------------------------------------------------------------------------

async function serveSnapshot(res: ServerResponse): Promise<void> {
  const db = await getDb();
  const wl = db.select().from(watchlist).all();
  const symbols = wl.length > 0 ? wl.map((r) => r.symbol.toUpperCase()) : appConfig.DEFAULT_WATCHLIST;

  const prices = await Promise.all(
    symbols.map(async (s) => {
      const d = await fetch24hrCached(s);
      return d
        ? { symbol: d.symbol, price: d.price, changePercent24h: d.changePercent24h }
        : { symbol: s, price: null, changePercent24h: null };
    })
  );

  const signals = await getAllLatestSignals();

  const posRows = db.select().from(positions).all();
  const portfolio = await Promise.all(
    posRows.map(async (p) => {
      const d = await fetch24hrCached(p.symbol);
      const currentPrice = d?.price ?? null;
      const pnlPercent =
        currentPrice != null ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100 : null;
      return {
        symbol: p.symbol,
        quantity: p.quantity,
        entryPrice: p.entryPrice,
        currentPrice,
        pnlPercent,
      };
    })
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ prices, signals, portfolio, timestamp: Date.now() }));
}

// ---------------------------------------------------------------------------
// API: chat (reuses the Discord chat handler)
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function serveChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let message: string;
  try {
    const raw = await readBody(req, MAX_CHAT_BODY);
    const body = JSON.parse(raw) as { message?: unknown };
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Body must include a non-empty 'message' string." }));
      return;
    }
    message = body.message.slice(0, MAX_CHAT_MESSAGE);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body." }));
    return;
  }

  const responses = await handleChatMessage(message);
  // Convert chart Buffers to data URLs the browser can render directly.
  const out = responses.map((r) => ({
    content: r.content,
    symbol: r.symbol,
    chartDataUrl: r.chart ? `data:image/png;base64,${r.chart.toString("base64")}` : undefined,
  }));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ responses: out }));
}

// ---------------------------------------------------------------------------
// SSE: live tick + signal stream (dashboard, separate from MCP's GET /mcp)
// ---------------------------------------------------------------------------

function serveEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 5000\n\n");

  const offTick = bus.onTick((tick) => {
    res.write(`event: tick\ndata: ${JSON.stringify(tick)}\n\n`);
  });
  const offSignal = bus.onSignal((signal) => {
    res.write(`event: signal\ndata: ${JSON.stringify(signal)}\n\n`);
  });

  // Heartbeat keeps proxies from closing an idle connection.
  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 25_000);
  heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    offTick();
    offSignal();
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Handle a dashboard route. Returns true if the request was handled (caller
 * should stop), false to let the main server continue (e.g. to its 404).
 */
export async function handleDashboardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (!hasDashboard()) return false; // dashboard disabled → fall through to 404

  const path = url.pathname;
  const isDashboardRoute =
    path === "/dashboard" ||
    path.startsWith("/dashboard/") ||
    path === "/events" ||
    path.startsWith("/api/");
  if (!isDashboardRoute) return false;

  // --- Bootstrap: token in query → set cookie → redirect to clean URL ---
  if (path === "/dashboard" && req.method === "GET") {
    const qsToken = url.searchParams.get("token");
    if (qsToken && validToken(qsToken)) {
      res.writeHead(302, {
        "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(qsToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
        Location: "/dashboard",
      });
      res.end();
      return true;
    }
    if (!isAuthed(req)) {
      unauthorized(res);
      return true;
    }
    await serveStatic(res, "index.html");
    return true;
  }

  // Everything below requires a valid cookie.
  if (!isAuthed(req)) {
    unauthorized(res);
    return true;
  }

  if (path.startsWith("/dashboard/") && req.method === "GET") {
    await serveStatic(res, path.slice("/dashboard/".length));
    return true;
  }

  if (path === "/api/snapshot" && req.method === "GET") {
    await serveSnapshot(res);
    return true;
  }

  if (path === "/api/chat" && req.method === "POST") {
    await serveChat(req, res);
    return true;
  }

  if (path === "/events" && req.method === "GET") {
    serveEvents(req, res);
    return true;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unknown dashboard route" }));
  return true;
}
