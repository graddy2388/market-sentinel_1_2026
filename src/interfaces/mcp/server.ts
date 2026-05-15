#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fetch24hrCached, fetchCandlesCached } from "../../data/coingecko.js";
import { startPoller, stopPoller } from "../../data/poller.js";
import { analyzeTechnicals } from "../../analysis/signals.js";
import { dualAnalyze, dualCritique } from "../../ai/dual-analyst.js";
import { hasAnyAI, hasDiscord } from "../../config.js";
import { getDb, saveDb, closeDb } from "../../state/db.js";
import { watchlist, positions, alerts } from "../../state/schema.js";
import { eq } from "drizzle-orm";
import type { CandleInterval } from "../../data/types.js";

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "market-sentinel",
    version: "0.1.0",
  });

  server.tool(
    "get-price",
    "Get current price and 24h stats for a crypto symbol",
    { symbol: z.string().describe("Crypto symbol, e.g. BTC, ETH, SOL") },
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
      symbol: z.string().describe("Crypto symbol, e.g. BTC, ETH"),
      interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("1h").describe("Candle interval"),
      candles: z.number().default(100).describe("Number of candles to analyze"),
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
        const aiResult = await dualAnalyze(symbol.toUpperCase(), technicals);
        result.ai = {
          openai: aiResult.openai,
          claude: aiResult.claude,
          disagreements: aiResult.disagreements,
          consensus: aiResult.consensus,
        };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get-technical-signals",
    "Get raw technical indicator values and signal summary for a symbol",
    {
      symbol: z.string().describe("Crypto symbol"),
      interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("1h"),
      candles: z.number().default(100),
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
      description: z.string().describe("Description of the proposed trade, e.g. 'Buy 0.5 BTC at $67,000 because I think it will hit $100k'"),
      symbol: z.string().optional().describe("Optional symbol for technical context"),
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

      const result = await dualCritique(description, technicals);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            trade: description,
            openai: result.openai,
            claude: result.claude,
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
      symbol: z.string().optional().describe("Symbol (required for add/remove)"),
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
      symbol: z.string(),
      quantity: z.number(),
      entryPrice: z.number(),
      notes: z.string().optional(),
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
      symbol: z.string(),
      condition: z.enum(["price_above", "price_below", "pct_change", "rsi_above", "rsi_below"]),
      threshold: z.number().describe("Price level, percentage, or RSI value"),
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

async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
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

async function startHttp() {
  // Start background poller with symbols from the DB watchlist
  try {
    const db = await getDb();
    const items = db.select().from(watchlist).all();
    const symbols = items.map((row) => row.symbol);
    if (symbols.length > 0) {
      startPoller(symbols);
    } else {
      console.log("[Market Sentinel] Watchlist is empty — poller not started. Add symbols via manage-watchlist.");
    }
  } catch (err) {
    console.warn("[Market Sentinel] Could not read watchlist for poller:", err);
  }

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${MCP_PORT}`);

    // --- Health endpoint (for Docker healthcheck) ---
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
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
          } else if (!sessionId && isInitializeRequest(body)) {
            // New session — create a fresh server + transport pair
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                console.log(`[MCP] Session initialized: ${sid}`);
                transports.set(sid, transport);
              },
            });

            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid) {
                console.log(`[MCP] Session closed: ${sid}`);
                transports.delete(sid);
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
          console.error("[MCP] POST error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
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

  httpServer.listen(MCP_PORT, "0.0.0.0", async () => {
    console.log(`[Market Sentinel] MCP StreamableHTTP server listening on http://0.0.0.0:${MCP_PORT}/mcp`);
    console.log(`[Market Sentinel] Health check: http://0.0.0.0:${MCP_PORT}/health`);

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
    }
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
