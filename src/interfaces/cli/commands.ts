import { Command } from "commander";
import { fetch24hr, fetchCandles } from "../../data/providers.js";
import { analyzeTechnicals } from "../../analysis/signals.js";
import { councilAnalyze, councilCritique } from "../../ai/council.js";
import { hasAnyAI, requireAI } from "../../config.js";
import { getDb, saveDb } from "../../state/db.js";
import { watchlist, positions } from "../../state/schema.js";
import { eq } from "drizzle-orm";
import {
  symbolSchema,
  intervalSchema,
  candlesSchema,
  marketSchema,
  quantitySchema,
  priceSchema,
  notesSchema,
} from "../../validation.js";
import type { AnalysisResponse, CritiqueResponse } from "../../ai/types.js";

function formatAnalysis(label: string, analysis: AnalysisResponse): string {
  const arrow =
    analysis.direction === "bullish" ? "^" :
    analysis.direction === "bearish" ? "v" : "-";
  return `
  [${label}] ${arrow} ${analysis.direction.toUpperCase()} (${(analysis.confidence * 100).toFixed(0)}% confidence)
    ${analysis.reasoning}
    Risks: ${analysis.risks.join("; ") || "none noted"}
    Key levels: Support ${analysis.keyLevels.support ?? "N/A"} | Resistance ${analysis.keyLevels.resistance ?? "N/A"}
    Timeframe: ${analysis.timeframe}
    Suggestion: ${analysis.actionSuggestion}`;
}

function formatCritique(label: string, critique: CritiqueResponse): string {
  const emoji =
    critique.overallAssessment === "good" ? "[OK]" :
    critique.overallAssessment === "risky" ? "[!]" : "[X]";
  const issues = critique.issues
    .map((i) => `    - [${i.severity.toUpperCase()}] ${i.type}: ${i.description}`)
    .join("\n");
  return `
  ${emoji} [${label}] Score: ${critique.score}/10 — ${critique.overallAssessment.toUpperCase()}
${issues || "    No issues found."}
    Recommendation: ${critique.recommendation}`;
}

export function registerCommands(program: Command): void {
  program
    .command("price <symbol>")
    .description("Get current price and 24h stats for a crypto symbol")
    .action(async (symbol: string) => {
      const symResult = symbolSchema.safeParse(symbol);
      if (!symResult.success) {
        console.error(`Invalid symbol: ${symResult.error.issues[0].message}`);
        return;
      }
      const sym = symResult.data;
      const data = await fetch24hr(sym);
      if (!data) {
        console.error(`Could not fetch data for ${sym}`);
        return;
      }
      console.log(`
  ${sym}/USD
  Price:     $${data.price.toFixed(2)}
  24h Change: ${data.change24h >= 0 ? "+" : ""}${data.change24h.toFixed(2)} (${data.changePercent24h >= 0 ? "+" : ""}${data.changePercent24h.toFixed(2)}%)
  24h High:   $${data.high24h.toFixed(2)}
  24h Low:    $${data.low24h.toFixed(2)}
  24h Volume: $${data.volume24h.toLocaleString()}
`);
    });

  program
    .command("analyze <symbol>")
    .description("Run full technical + AI analysis on a crypto symbol")
    .option("-c, --candles <number>", "Number of candles to analyze", "100")
    .option("-i, --interval <interval>", "Candle interval", "1h")
    .action(async (symbol: string, opts: { candles: string; interval: string }) => {
      const symResult = symbolSchema.safeParse(symbol);
      if (!symResult.success) {
        console.error(`Invalid symbol: ${symResult.error.issues[0].message}`);
        return;
      }
      const intResult = intervalSchema.safeParse(opts.interval);
      if (!intResult.success) {
        console.error(`Invalid interval: must be one of 1m, 5m, 15m, 1h, 4h, 1d`);
        return;
      }
      const candleResult = candlesSchema.safeParse(opts.candles);
      if (!candleResult.success) {
        console.error(`Invalid candles: ${candleResult.error.issues[0].message}`);
        return;
      }

      const sym = symResult.data;
      const interval = intResult.data;
      const candleCount = candleResult.data;

      console.log(`Fetching ${candleCount} ${interval} candles for ${sym}...`);

      const candles = await fetchCandles(sym, interval, candleCount);

      if (candles.length === 0) {
        console.error(`No candle data found for ${sym}`);
        return;
      }

      const technicals = analyzeTechnicals(sym, candles);
      if (!technicals) {
        console.error("Not enough data for technical analysis");
        return;
      }

      console.log(`\n=== Technical Analysis: ${sym} ===`);
      console.log(`  Price: $${technicals.price.toFixed(2)}`);
      console.log(`  Overall: ${technicals.overallDirection.toUpperCase()} (strength: ${(technicals.overallStrength * 100).toFixed(0)}%)`);

      if (technicals.indicators.rsi !== null)
        console.log(`  RSI(14): ${technicals.indicators.rsi.toFixed(1)}`);
      if (technicals.indicators.macd)
        console.log(`  MACD: ${technicals.indicators.macd.histogram.toFixed(2)} (histogram)`);
      if (technicals.indicators.sma20 !== null)
        console.log(`  SMA(20): $${technicals.indicators.sma20.toFixed(2)}`);
      if (technicals.indicators.sma50 !== null)
        console.log(`  SMA(50): $${technicals.indicators.sma50.toFixed(2)}`);
      if (technicals.indicators.bollingerBands)
        console.log(`  Bollinger: $${technicals.indicators.bollingerBands.lower.toFixed(2)} - $${technicals.indicators.bollingerBands.upper.toFixed(2)}`);

      console.log(`\n  Signals:`);
      for (const signal of technicals.signals) {
        const arrow = signal.direction === "bullish" ? "^" : signal.direction === "bearish" ? "v" : "-";
        console.log(`    ${arrow} ${signal.name} (${(signal.strength * 100).toFixed(0)}%) — ${signal.description}`);
      }

      if (hasAnyAI()) {
        console.log(`\n=== AI Council ===`);
        console.log("  Querying AI models...");
        const result = await councilAnalyze(sym, technicals);

        for (const vote of result.votes) {
          console.log(formatAnalysis(vote.model, vote.analysis));
        }

        if (result.failed.length > 0) {
          console.log(`\n  Failed: ${result.failed.map((f) => `${f.model} (${f.error})`).join(", ")}`);
        }

        if (result.consensus) {
          console.log(`\n  Council Verdict: ${result.consensus}`);
        }

        if (result.disagreements.length > 0) {
          console.log(`\n  !! DISAGREEMENTS !!`);
          for (const d of result.disagreements) {
            console.log(`    - ${d}`);
          }
        }
      } else {
        console.log("\n  (No AI keys configured — set OPENAI_API_KEY or ANTHROPIC_API_KEY for AI analysis)");
      }
    });

  program
    .command("critique <description...>")
    .description("Get a blunt critique of a proposed trade")
    .option("-s, --symbol <symbol>", "Symbol to include technical context for")
    .action(async (descriptionParts: string[], opts: { symbol?: string }) => {
      requireAI();
      const description = descriptionParts.join(" ");

      let technicals = null;
      if (opts.symbol) {
        const symResult = symbolSchema.safeParse(opts.symbol);
        if (!symResult.success) {
          console.error(`Invalid symbol: ${symResult.error.issues[0].message}`);
          return;
        }
        const candles = await fetchCandles(symResult.data, "1h", 100);
        if (candles.length >= 14) {
          technicals = analyzeTechnicals(symResult.data, candles);
        }
      }

      console.log(`\n=== Trade Critique ===`);
      console.log(`  Proposed: ${description}`);
      console.log("  Querying AI models...\n");

      const result = await councilCritique(description, technicals);

      for (const opinion of result.opinions) {
        console.log(formatCritique(opinion.model, opinion.critique));
      }

      if (result.failed.length > 0) {
        console.log(`\n  Failed: ${result.failed.map((f) => `${f.model} (${f.error})`).join(", ")}`);
      }

      console.log(`\n  Council Verdict: ${result.majorityAssessment.toUpperCase()} (avg score ${result.avgScore.toFixed(1)}/10)`);
    });

  program
    .command("watch")
    .description("List watched symbols")
    .action(async () => {
      const db = await getDb();
      const items = db.select().from(watchlist).all();
      if (items.length === 0) {
        console.log("  Watchlist is empty. Use 'watch-add <symbol>' to add symbols.");
        return;
      }
      console.log("\n  Watchlist:");
      for (const item of items) {
        console.log(`    ${item.symbol} (${item.market}) — added ${item.addedAt}`);
      }
    });

  program
    .command("watch-add <symbol>")
    .description("Add a symbol to the watchlist")
    .option("-m, --market <market>", "Market type (crypto, stock, commodity)", "crypto")
    .action(async (symbol: string, opts: { market: string }) => {
      const symResult = symbolSchema.safeParse(symbol);
      if (!symResult.success) {
        console.error(`Invalid symbol: ${symResult.error.issues[0].message}`);
        return;
      }
      const marketResult = marketSchema.safeParse(opts.market);
      if (!marketResult.success) {
        console.error(`Invalid market: must be one of crypto, stock, commodity`);
        return;
      }

      const db = await getDb();
      db.insert(watchlist)
        .values({
          symbol: symResult.data,
          market: marketResult.data,
        })
        .run();
      saveDb();
      console.log(`  Added ${symResult.data} (${marketResult.data}) to watchlist.`);
    });

  program
    .command("watch-remove <symbol>")
    .description("Remove a symbol from the watchlist")
    .action(async (symbol: string) => {
      const symResult = symbolSchema.safeParse(symbol);
      if (!symResult.success) {
        console.error(`Invalid symbol: ${symResult.error.issues[0].message}`);
        return;
      }
      const db = await getDb();
      db.delete(watchlist)
        .where(eq(watchlist.symbol, symResult.data))
        .run();
      saveDb();
      console.log(`  Removed ${symResult.data} from watchlist.`);
    });

  program
    .command("portfolio")
    .description("View current portfolio positions")
    .action(async () => {
      const db = await getDb();
      const items = db.select().from(positions).all();
      if (items.length === 0) {
        console.log("  No positions. Use 'portfolio-add' to add positions.");
        return;
      }
      console.log("\n  Portfolio:");
      for (const pos of items) {
        const currentData = await fetch24hr(pos.symbol);
        const current = currentData?.price ?? 0;
        const pnl = current > 0 ? ((current - pos.entryPrice) / pos.entryPrice * 100).toFixed(2) : "N/A";
        console.log(`    ${pos.symbol}: ${pos.quantity} @ $${pos.entryPrice.toFixed(2)} (P&L: ${pnl}%)`);
      }
    });

  program
    .command("portfolio-add <symbol> <quantity> <entryPrice>")
    .description("Add a position to portfolio")
    .option("-n, --notes <notes>", "Trade notes")
    .action(async (symbol: string, quantity: string, entryPrice: string, opts: { notes?: string }) => {
      const symResult = symbolSchema.safeParse(symbol);
      if (!symResult.success) {
        console.error(`Invalid symbol: ${symResult.error.issues[0].message}`);
        return;
      }
      const qtyResult = quantitySchema.safeParse(quantity);
      if (!qtyResult.success) {
        console.error(`Invalid quantity: ${qtyResult.error.issues[0].message}`);
        return;
      }
      const priceResult = priceSchema.safeParse(entryPrice);
      if (!priceResult.success) {
        console.error(`Invalid entry price: ${priceResult.error.issues[0].message}`);
        return;
      }
      const notesResult = notesSchema.safeParse(opts.notes);
      if (!notesResult.success) {
        console.error(`Invalid notes: ${notesResult.error.issues[0].message}`);
        return;
      }

      const db = await getDb();
      db.insert(positions)
        .values({
          symbol: symResult.data,
          quantity: qtyResult.data,
          entryPrice: priceResult.data,
          notes: notesResult.data ?? null,
        })
        .run();
      saveDb();
      console.log(`  Added position: ${symResult.data} x${qtyResult.data} @ $${priceResult.data}`);
    });
}
