#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fetch24hrCached, fetchCandlesCached } from "../../data/providers.js";
import { startPoller, stopPoller } from "../../data/poller.js";
import { DataManager } from "../../data/manager.js";
import { startSignalMonitor, stopSignalMonitor } from "../../signals/monitor.js";
import { bus } from "../../events/bus.js";
import { analyzeTechnicals } from "../../analysis/signals.js";
import { councilAnalyze, councilCritique } from "../../ai/council.js";
import { hasAnyAI, hasDiscord } from "../../config.js";
import { getDb, saveDb, closeDb } from "../../state/db.js";
import { watchlist, positions, alerts } from "../../state/schema.js";
import { eq } from "drizzle-orm";
import type { CandleInterval } from "../../data/types.js";
import {
  symbolSchema,
  intervalSchemaWithDefault as intervalSchema,
  candlesSchemaWithDefault as candlesSchema,
  marketSchema,
  quantitySchema,
  priceSchema,
  thresholdSchema,
  descriptionSchema,
  notesSchema,
} from "../../validation.js";

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "market-sentinel",
    version: "0.1.0",
  });

  server.tool(
    "get-price",
    "Get current price and 24h stats for a crypto symbol",
    { symbol: symbolSchema.describe("Crypto symbol, e.g. BTC, ETH, SOL") },
    async ({ symbol }) => {
      const data = await fetch24hrCached(symbol);
      if (!data) {
        return { content: [{ type: "text" as const, text: `Could not fetch data for ${symbol.toUpperCase()}` }] };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            symbol: data.symbol,
            pair: `${data.symbol}/USD`,
            price: data.price,
            change24h: data.change24h,
            changePercent24h: data.changePercent24h,
            high24h: data.high24h,
            low24h: data.low24h,
            volume24h: data.volume24h,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "analyze-asset",
    "Run full technical + AI analysis on a crypto asset. Returns indicators, signals, and dual-model AI opinions with disagreement detection.",
    {
      symbol: symbolSchema.describe("Crypto symbol, e.g. BTC, ETH"),
      interval: intervalSchema.describe("Candle interval"),
      candles: candlesSchema.describe("Number of candles to analyze"),
    },
    async ({ symbol, interval, candles }) => {
      const klines = await fetchCandlesCached(symbol, interval as CandleInterval, candles);
      if (klines.length < 14) {
        return { content: [{ type: "text" as const, text: `Not enough data for ${symbol.toUpperCase()}. Got ${klines.length} candles, need at least 14.` }] };
      }

      const technicals = analyzeTechnicals(symbol.toUpperCase(), klines);
      if (!technicals) {
        return { content: [{ type: "text" as const, text: "Technical analysis failed — not enough data." }] };
      }

      const result: Record<string, unknown> = {
        symbol: symbol.toUpperCase(),
        price: technicals.price,
        overallDirection: technicals.overallDirection,
        overallStrength: technicals.overallStrength,
        indicators: technicals.indicators,
        signals: technicals.signals,
      };

      if (hasAnyAI()) {
        const council = await councilAnalyze(symbol.toUpperCase(), technicals);
        result.ai = {
          majorityDirection: council.majorityDirection,
          directionBreakdown: council.directionBreakdown,
          avgConfidence: council.avgConfidence,
          consensus: council.consensus,
          votes: council.votes,
          disagreements: council.disagreements,
          failed: council.failed,
        };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get-technical-signals",
    "Get raw technical indicator values and signal summary for a symbol",
    {
      symbol: symbolSchema.describe("Crypto symbol"),
      interval: intervalSchema,
      candles: candlesSchema,
    },
    async ({ symbol, interval, candles }) => {
      const klines = await fetchCandlesCached(symbol, interval as CandleInterval, candles);
      const technicals = analyzeTechnicals(symbol.toUpperCase(), klines);
      if (!technicals) {
        return { content: [{ type: "text" as const, text: "Not enough data for analysis." }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(technicals, null, 2) }] };
    }
  );

  server.tool(
    "critique-trade",
    "Get a blunt, honest critique of a proposed trade from both AI models. Will call out FOMO, poor risk management, etc.",
    {
      description: z.string().min(1).max(2000).describe("Description of the proposed trade, e.g. 'Buy 0.5 BTC at $67,000 because I think it will hit $100k'"),
      symbol: symbolSchema.optional().describe("Optional symbol for technical context"),
    },
    async ({ description, symbol }) => {
      if (!hasAnyAI()) {
        return { content: [{ type: "text" as const, text: "No AI API keys configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY." }] };
      }

      let technicals = null;
      if (symbol) {
        const klines = await fetchCandlesCached(symbol, "1h", 100);
        if (klines.length >= 14) {
          technicals = analyzeTechnicals(symbol.toUpperCase(), klines);
        }
      }

      const council = await councilCritique(description, technicals);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            trade: description,
            majorityAssessment: council.majorityAssessment,
            avgScore: council.avgScore,
            opinions: council.opinions,
            failed: council.failed,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "manage-watchlist",
    "Add, remove, or list symbols on the watchlist",
    {
      action: z.enum(["list", "add", "remove"]),
      symbol: symbolSchema.optional().describe("Symbol (required for add/remove)"),
      market: z.enum(["crypto", "stock", "commodity"]).default("crypto"),
    },
    async ({ action, symbol, market }) => {
      const db = await getDb();

      if (action === "list") {
        const items = db.select().from(watchlist).all();
        return { content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }] };
      }

      if (!symbol) {
        return { content: [{ type: "text" as const, text: "Symbol is required for add/remove." }] };
      }

      if (action === "add") {
        db.insert(watchlist).values({ symbol: symbol.toUpperCase(), market }).run();
        saveDb();
        return { content: [{ type: "text" as const, text: `Added ${symbol.toUpperCase()} (${market}) to watchlist.` }] };
      }

      db.delete(watchlist).where(eq(watchlist.symbol, symbol.toUpperCase())).run();
      saveDb();
      return { content: [{ type: "text" as const, text: `Removed ${symbol.toUpperCase()} from watchlist.` }] };
    }
  );

  server.tool(
    "add-position",
    "Record a new portfolio position",
    {
      symbol: symbolSchema,
      quantity: z.number().positive().max(1e12),
      entryPrice: z.number().positive().max(1e12),
      notes: z.string().max(500).optional(),
    },
    async ({ symbol, quantity, entryPrice, notes }) => {
      const db = await getDb();
      db.insert(positions)
        .values({
          symbol: symbol.toUpperCase(),
          quantity,
          entryPrice,
          notes: notes ?? null,
        })
        .run();
      saveDb();
      return { content: [{ type: "text" as const, text: `Position added: ${symbol.toUpperCase()} x${quantity} @ $${entryPrice}` }] };
    }
  );

  server.tool(
    "evaluate-portfolio",
    "Evaluate the full portfolio with current prices and AI risk assessment",
    {},
    async () => {
      const db = await getDb();
      const items = db.select().from(positions).all();

      if (items.length === 0) {
        return { content: [{ type: "text" as const, text: "Portfolio is empty." }] };
      }

      const portfolio = await Promise.all(
        items.map(async (pos) => {
          const data = await fetch24hrCached(pos.symbol);
          const currentPrice = data?.price ?? 0;
          const pnl = currentPrice > 0
            ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
            : null;
          return {
            symbol: pos.symbol,
            quantity: pos.quantity,
            entryPrice: pos.entryPrice,
            currentPrice,
            pnlPercent: pnl,
            value: currentPrice * pos.quantity,
            notes: pos.notes,
          };
        })
      );

      const totalValue = portfolio.reduce((sum, p) => sum + p.value, 0);
      const allocations = portfolio.map((p) => ({
        ...p,
        allocation: totalValue > 0 ? (p.value / totalValue) * 100 : 0,
      }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ totalValue, positions: allocations }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "set-alert",
    "Set a price alert for a symbol",
    {
      symbol: symbolSchema,
      condition: z.enum(["price_above", "price_below", "pct_change", "rsi_above", "rsi_below"]),
      threshold: z.number().finite().describe("Price level, percentage, or RSI value"),
    },
    async ({ symbol, condition, threshold }) => {
      const db = await getDb();
      db.insert(alerts)
        .values({
          symbol: symbol.toUpperCase(),
          conditionType: condition,
          threshold,
        })
        .run();
      saveDb();
      return { content: [{ type: "text" as const, text: `Alert set: ${symbol.toUpperCase()} ${condition} ${threshold}` }] };
    }
  );

  server.tool(
    "list-alerts",
    "List all active alerts",
    {},
    async () => {
      const db = await getDb();
      const items = db.select().from(alerts).where(eq(alerts.active, true)).all();
      return { content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }] };
    }
  );

  return server;
}

// --- Transport selection ---

const MCP_TRANSPORT = process.env.MCP_TRANSPORT ?? "stdio";
const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3100", 10);

// Live data manager (Binance WebSocket) — activated in startHttp when the
// watchlist contains crypto symbols.
let dataManager: DataManager | null = null;

async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const MAX_BODY_SIZE = 256 * 1024; // 256 KB — MCP messages are small JSON

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// --- Rate limiting (per-IP, in-memory, bounded) ---
const RATE_LIMIT = 120;            // max requests per window
const RATE_WINDOW_MS = 60_000;     // 1-minute window
const MAX_RATE_ENTRIES = 10_000;   // cap map size to prevent memory exhaustion
const rateLimiter = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(ip);
  if (!entry || now > entry.resetAt) {
    // Evict oldest entries if map is at capacity
    if (rateLimiter.size >= MAX_RATE_ENTRIES) {
      const firstKey = rateLimiter.keys().next().value;
      if (firstKey !== undefined) rateLimiter.delete(firstKey);
    }
    rateLimiter.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// Clean up stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimiter) {
    if (now > entry.resetAt) rateLimiter.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// --- Session TTL (clean up abandoned MCP sessions, bounded) ---
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 100;              // cap concurrent sessions
const sessionLastSeen = new Map<string, number>();

async function startHttp() {
  // Start background poller with symbols from the DB watchlist, and activate
  // the live Binance WebSocket + reactive signal monitor for crypto symbols.
  try {
    const db = await getDb();
    const items = db.select().from(watchlist).all();
    const symbols = items.map((row) => row.symbol);
    if (symbols.length > 0) {
      startPoller(symbols);
    } else {
      console.log("[Market Sentinel] Watchlist is empty — poller not started. Add symbols via manage-watchlist.");
    }

    // Live streaming is crypto-only (Binance). Use the actual crypto watchlist
    // rows — NOT every known crypto symbol — so we don't subscribe to
    // stablecoins or symbols without a Binance USDT pair.
    const cryptoWatchlist = items
      .filter((row) => row.market === "crypto")
      .map((row) => row.symbol.toUpperCase());
    if (cryptoWatchlist.length > 0) {
      dataManager = new DataManager(cryptoWatchlist);
      dataManager.on("connected", () => console.log("[Market Sentinel] Binance stream connected"));
      dataManager.on("disconnected", () => console.log("[Market Sentinel] Binance stream disconnected"));
      dataManager.on("error", (err: Error) => console.error("[Market Sentinel] Binance stream error:", err.message));
      dataManager.start();
      startSignalMonitor(dataManager);
      // Push graded-signal changes to Discord when configured.
      if (hasDiscord()) {
        const { sendSignalNotification } = await import("../discord/bot.js");
        bus.onSignal((signal) => {
          sendSignalNotification(signal).catch((err) =>
            console.error("[Market Sentinel] Signal notification error:", err)
          );
        });
      }
      console.log(`[Market Sentinel] Live signal monitor active for: ${cryptoWatchlist.join(", ")}`);
    }
  } catch (err) {
    console.warn("[Market Sentinel] Could not read watchlist for poller/monitor:", err);
  }

  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Periodic session cleanup
  const sessionCleanup = setInterval(() => {
    const now = Date.now();
    for (const [sid, lastSeen] of sessionLastSeen) {
      if (now - lastSeen > SESSION_TTL_MS) {
        const transport = transports.get(sid);
        if (transport) {
          transport.close().catch(() => {});
          transports.delete(sid);
        }
        sessionLastSeen.delete(sid);
        console.log(`[MCP] Expired stale session: ${sid}`);
      }
    }
  }, 5 * 60 * 1000);
  sessionCleanup.unref();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${MCP_PORT}`);

    // --- Security headers on all responses ---
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");

    // --- Rate limiting ---
    const clientIp = req.socket.remoteAddress ?? "unknown";
    if (url.pathname !== "/health" && !checkRateLimit(clientIp)) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }

    // --- Health endpoint (for Docker healthcheck) ---
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // --- MCP endpoint ---
    if (url.pathname === "/mcp") {
      const method = req.method?.toUpperCase();

      if (method === "POST") {
        try {
          const body = await parseJsonBody(req);
          const sessionId = req.headers["mcp-session-id"] as string | undefined;

          let transport: StreamableHTTPServerTransport;

          if (sessionId && transports.has(sessionId)) {
            // Reuse existing session transport
            transport = transports.get(sessionId)!;
            sessionLastSeen.set(sessionId, Date.now());
          } else if (!sessionId && isInitializeRequest(body)) {
            // Reject if we've hit the session cap
            if (transports.size >= MAX_SESSIONS) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Too many active sessions" },
                id: null,
              }));
              return;
            }
            // New session — create a fresh server + transport pair
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                console.log(`[MCP] Session initialized: ${sid}`);
                transports.set(sid, transport);
                sessionLastSeen.set(sid, Date.now());
              },
            });

            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid) {
                console.log(`[MCP] Session closed: ${sid}`);
                transports.delete(sid);
                sessionLastSeen.delete(sid);
              }
            };

            // Each session gets its own McpServer instance
            const server = createMcpServer();
            await server.connect(transport);
            await transport.handleRequest(req, res, body);
            return;
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Bad Request: No valid session ID" },
              id: null,
            }));
            return;
          }

          await transport.handleRequest(req, res, body);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : "Unknown error";
          // Don't log full stack traces to avoid leaking internals
          console.error(`[MCP] POST error: ${errMsg}`);
          if (!res.headersSent) {
            const statusCode = errMsg === "Request body too large" ? 413 : 500;
            res.writeHead(statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: statusCode === 413 ? "Request body too large" : "Internal server error" },
              id: null,
            }));
          }
        }
        return;
      }

      if (method === "GET") {
        // SSE stream for notifications
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (!sessionId || !transports.has(sessionId)) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid or missing session ID");
          return;
        }
        await transports.get(sessionId)!.handleRequest(req, res);
        return;
      }

      if (method === "DELETE") {
        // Session termination
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (!sessionId || !transports.has(sessionId)) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid or missing session ID");
          return;
        }
        await transports.get(sessionId)!.handleRequest(req, res);
        return;
      }

      // Method not allowed
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    // --- 404 ---
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  const MCP_HOST = process.env.MCP_HOST || "127.0.0.1";
  httpServer.listen(MCP_PORT, MCP_HOST, async () => {
    console.log(`[Market Sentinel] MCP StreamableHTTP server listening on http://${MCP_HOST}:${MCP_PORT}/mcp`);
    console.log(`[Market Sentinel] Health check: http://${MCP_HOST}:${MCP_PORT}/health`);

    // Start Discord bot + alert engine if configured
    if (hasDiscord()) {
      try {
        const { startDiscordBot, sendAlertNotification } = await import("../discord/bot.js");
        const { startAlertEngine } = await import("../../alerts/engine.js");

        await startDiscordBot();
        startAlertEngine((alert, currentPrice) => {
          sendAlertNotification(alert, currentPrice).catch((err) =>
            console.error("[Market Sentinel] Alert notification error:", err)
          );
        });
        console.log("[Market Sentinel] Discord bot and alert engine started");
      } catch (err) {
        console.error("[Market Sentinel] Failed to start Discord/alert engine:", err);
      }
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Market Sentinel] Shutting down...");
    stopPoller();
    stopSignalMonitor();
    if (dataManager) {
      dataManager.stop();
      dataManager = null;
    }

    if (hasDiscord()) {
      try {
        const { stopDiscordBot } = await import("../discord/bot.js");
        const { stopAlertEngine } = await import("../../alerts/engine.js");
        stopAlertEngine();
        await stopDiscordBot();
      } catch { /* ignore */ }
    }

    for (const [sid, transport] of transports) {
      try {
        await transport.close();
      } catch { /* ignore */ }
      transports.delete(sid);
      sessionLastSeen.delete(sid);
    }
    clearInterval(sessionCleanup);
    httpServer.close();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  if (MCP_TRANSPORT === "sse" || MCP_TRANSPORT === "http" || MCP_TRANSPORT === "streamable-http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error("MCP server error:", err);
  closeDb();
  process.exit(1);
});
