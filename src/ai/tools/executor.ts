/**
 * Tool execution.
 *
 * Results are fed back to the model, which then writes the user-facing reply —
 * so these return compact, factual summaries rather than Discord-formatted
 * prose. That also keeps this module free of any dependency on the Discord
 * layer (avoiding a chat.ts <-> tool-loop import cycle).
 *
 * Two invariants:
 * - Every argument is validated with the shared schemas in src/validation.ts.
 *   Model-supplied arguments are untrusted input.
 * - Nothing throws to the caller. A failure comes back as text so the model can
 *   explain it instead of the whole turn erroring out.
 */
import { eq } from "drizzle-orm";
import { fetch24hrCached, fetchCandlesCached } from "../../data/providers.js";
import { analyzeTechnicals } from "../../analysis/signals.js";
import { councilAnalyze } from "../council.js";
import { renderChart } from "../../charts/renderer.js";
import { getDb, saveDb } from "../../state/db.js";
import { alerts, positions } from "../../state/schema.js";
import {
  addToWatchlist,
  removeFromWatchlist,
  listWatchlist,
} from "../../state/watchlist.js";
import { symbolSchema, thresholdSchema } from "../../validation.js";
import { hasAnyAI } from "../../config.js";

/** Side-channel outputs a tool result cannot carry as text. */
export interface ToolArtifacts {
  chart?: Buffer;
  symbol?: string;
}

export interface ToolResult {
  text: string;
  artifacts?: ToolArtifacts;
}

/** Candles fetched for analysis — 250 so SMA(200) can compute. */
const ANALYSIS_CANDLES = 250;
/** Chart shows the most recent slice for readability. */
const CHART_CANDLES = 100;

function fail(message: string): ToolResult {
  return { text: `ERROR: ${message}` };
}

function parseSymbol(raw: unknown): { symbol: string } | { error: string } {
  const parsed = symbolSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: `Invalid symbol: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  return { symbol: parsed.data };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function getMarketData(input: Record<string, unknown>): Promise<ToolResult> {
  const sym = parseSymbol(input.symbol);
  if ("error" in sym) return fail(sym.error);

  const [overview, candles] = await Promise.all([
    fetch24hrCached(sym.symbol),
    fetchCandlesCached(sym.symbol, "1h", ANALYSIS_CANDLES),
  ]);

  if (!overview) {
    return fail(`No market data found for ${sym.symbol}. It may not be a listed symbol.`);
  }

  const technicals = candles.length >= 14 ? analyzeTechnicals(sym.symbol, candles) : null;

  const payload: Record<string, unknown> = {
    symbol: overview.symbol,
    market: overview.market,
    price: overview.price,
    change24hPercent: Number(overview.changePercent24h.toFixed(2)),
    high24h: overview.high24h,
    low24h: overview.low24h,
    volume24hUsd: Math.round(overview.volume24h),
  };

  if (technicals) {
    payload.technicals = {
      direction: technicals.overallDirection,
      strength: Number(technicals.overallStrength.toFixed(2)),
      rsi: technicals.indicators.rsi != null ? Number(technicals.indicators.rsi.toFixed(1)) : null,
      sma20: technicals.indicators.sma20,
      sma50: technicals.indicators.sma50,
      atr: technicals.indicators.atr,
      candleInterval: candles[0]?.interval,
      candleCount: candles.length,
    };
  } else {
    payload.technicals = null;
    payload.note = "Not enough candle history for technical indicators.";
  }

  return { text: JSON.stringify(payload) };
}

async function runAnalysis(input: Record<string, unknown>): Promise<ToolResult> {
  const sym = parseSymbol(input.symbol);
  if ("error" in sym) return fail(sym.error);
  if (!hasAnyAI()) return fail("No AI models configured for council analysis.");

  const [overview, candles] = await Promise.all([
    fetch24hrCached(sym.symbol),
    fetchCandlesCached(sym.symbol, "1h", ANALYSIS_CANDLES),
  ]);

  if (candles.length < 14) {
    return fail(`Not enough candle history to analyze ${sym.symbol}.`);
  }

  const technicals = analyzeTechnicals(sym.symbol, candles);
  if (!technicals) return fail(`Technical analysis failed for ${sym.symbol}.`);

  // Chart renders alongside the council call rather than after it.
  const chartPromise = renderChart(
    candles.slice(-CHART_CANDLES),
    sym.symbol,
    overview?.price,
    overview?.changePercent24h
  ).catch(() => undefined);

  const council = await councilAnalyze(sym.symbol, technicals);
  const chart = await chartPromise;

  const payload = {
    symbol: sym.symbol,
    price: technicals.price,
    technicalDirection: technicals.overallDirection,
    technicalStrength: Number(technicals.overallStrength.toFixed(2)),
    council: {
      consensus: council.consensus,
      majorityDirection: council.majorityDirection,
      breakdown: council.directionBreakdown,
      avgConfidence: Number(council.avgConfidence.toFixed(2)),
      disagreements: council.disagreements,
      modelsFailed: council.failed.map((f) => f.model),
      votes: council.votes.map((v) => ({
        model: v.model,
        direction: v.analysis.direction,
        confidence: v.analysis.confidence,
        reasoning: v.analysis.reasoning,
        keyLevels: v.analysis.keyLevels,
        action: v.analysis.actionSuggestion,
      })),
    },
    chartAttached: Boolean(chart),
  };

  return {
    text: JSON.stringify(payload),
    artifacts: chart ? { chart, symbol: sym.symbol } : { symbol: sym.symbol },
  };
}

async function manageWatchlist(input: Record<string, unknown>): Promise<ToolResult> {
  const action = String(input.action ?? "").toLowerCase();

  if (action === "list") {
    const items = await listWatchlist();
    return {
      text: JSON.stringify({
        count: items.length,
        watchlist: items.map((i) => ({ symbol: i.symbol, market: i.market })),
      }),
    };
  }

  const sym = parseSymbol(input.symbol);
  if ("error" in sym) return fail(`${sym.error} (required for ${action})`);

  if (action === "add") {
    const result = await addToWatchlist(sym.symbol);
    return {
      text: JSON.stringify({
        action: "add",
        symbol: result.symbol,
        market: result.market,
        added: result.added,
        note: result.added
          ? "Added to the watchlist; it will appear in the daily briefing."
          : "Already on the watchlist — no change made.",
      }),
      artifacts: { symbol: result.symbol },
    };
  }

  if (action === "remove") {
    const removed = await removeFromWatchlist(sym.symbol);
    return {
      text: JSON.stringify({
        action: "remove",
        symbol: sym.symbol,
        removed,
        note: removed ? "Removed from the watchlist." : "It was not on the watchlist.",
      }),
    };
  }

  return fail(`Unknown watchlist action "${action}". Use list, add, or remove.`);
}

const ALERT_CONDITIONS = [
  "price_above",
  "price_below",
  "pct_change",
  "rsi_above",
  "rsi_below",
] as const;

type AlertCondition = (typeof ALERT_CONDITIONS)[number];

async function manageAlerts(input: Record<string, unknown>): Promise<ToolResult> {
  const action = String(input.action ?? "").toLowerCase();
  const db = await getDb();

  if (action === "list") {
    const rows = db.select().from(alerts).where(eq(alerts.active, true)).all();
    return {
      text: JSON.stringify({
        count: rows.length,
        alerts: rows.map((a) => ({
          id: a.id,
          symbol: a.symbol,
          condition: a.conditionType,
          threshold: a.threshold,
        })),
      }),
    };
  }

  if (action === "set") {
    const sym = parseSymbol(input.symbol);
    if ("error" in sym) return fail(`${sym.error} (required to set an alert)`);

    const condition = String(input.condition ?? "");
    if (!ALERT_CONDITIONS.includes(condition as AlertCondition)) {
      return fail(`Invalid condition. Use one of: ${ALERT_CONDITIONS.join(", ")}.`);
    }

    const threshold = thresholdSchema.safeParse(input.threshold);
    if (!threshold.success) return fail("Invalid threshold — must be a finite number.");

    db.insert(alerts)
      .values({
        symbol: sym.symbol,
        conditionType: condition as AlertCondition,
        threshold: threshold.data,
      })
      .run();
    saveDb();

    return {
      text: JSON.stringify({
        action: "set",
        symbol: sym.symbol,
        condition,
        threshold: threshold.data,
        created: true,
      }),
    };
  }

  return fail(`Unknown alert action "${action}". Use list or set.`);
}

async function listPositions(): Promise<ToolResult> {
  const db = await getDb();
  const rows = db.select().from(positions).all();
  if (rows.length === 0) {
    return { text: JSON.stringify({ count: 0, positions: [], note: "Portfolio is empty." }) };
  }

  const summaries = await Promise.all(
    rows.map(async (p) => {
      const overview = await fetch24hrCached(p.symbol);
      const currentPrice = overview?.price ?? null;
      const pnlPercent =
        currentPrice != null
          ? Number((((currentPrice - p.entryPrice) / p.entryPrice) * 100).toFixed(2))
          : null;
      return {
        symbol: p.symbol,
        quantity: p.quantity,
        entryPrice: p.entryPrice,
        currentPrice,
        pnlPercent,
      };
    })
  );

  return { text: JSON.stringify({ count: summaries.length, positions: summaries }) };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

const HANDLERS: Record<string, ToolHandler> = {
  get_market_data: getMarketData,
  run_analysis: runAnalysis,
  manage_watchlist: manageWatchlist,
  manage_alerts: manageAlerts,
  list_positions: listPositions,
};

/**
 * Execute a tool by name. Always resolves — failures come back as ERROR text
 * so the model can recover rather than the turn blowing up.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool "${name}".`);

  try {
    return await handler(input ?? {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Tools] ${name} failed:`, message);
    return fail(`${name} failed: ${message}`);
  }
}
