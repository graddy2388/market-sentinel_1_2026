import { EmbedBuilder, type TextChannel, type Client } from "discord.js";
import { eq } from "drizzle-orm";
import { appConfig } from "../../config.js";
import { fetch24hrCached, fetchCandlesCached, getSupportedSymbols } from "../../data/providers.js";
import { analyzeTechnicals } from "../../analysis/signals.js";
import { renderChart } from "../../charts/renderer.js";
import { getDb, saveDb } from "../../state/db.js";
import { watchlist, alerts, positions, settings } from "../../state/schema.js";
import type { MarketOverview } from "../../data/types.js";
import type { TechnicalSummary, SignalDirection } from "../../analysis/types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Hour of the day (0-23) to post the briefing. Uses validated config. */
const BRIEFING_HOUR = appConfig.BRIEFING_HOUR;

/** Timezone offset in hours from UTC (e.g., -4 for EDT). Uses validated config. */
const BRIEFING_TZ_OFFSET = appConfig.BRIEFING_TZ_OFFSET;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const COLOR_GREEN = 0x2ecc71;
const COLOR_RED = 0xe74c3c;
const COLOR_BLUE = 0x3498db;

let scheduledTimeout: ReturnType<typeof setTimeout> | null = null;
let client: Client | null = null;
let channelId: string | null = null;

function formatUsd(n: number): string {
  if (Math.abs(n) >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toPrecision(4)}`;
}

function formatPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function directionEmoji(dir: SignalDirection): string {
  if (dir === "bullish") return "▲";
  if (dir === "bearish") return "▼";
  return "◆";
}

// ---------------------------------------------------------------------------
// Briefing generation
// ---------------------------------------------------------------------------

interface SymbolBriefing {
  symbol: string;
  overview: MarketOverview;
  technicals: TechnicalSummary | null;
  chart: Buffer | null;
}

async function gatherSymbolData(symbol: string): Promise<SymbolBriefing | null> {
  const overview = await fetch24hrCached(symbol);
  if (!overview) return null;

  const candles = await fetchCandlesCached(symbol, "1h", 100);
  let technicals: TechnicalSummary | null = null;
  if (candles.length >= 14) {
    technicals = analyzeTechnicals(symbol, candles);
  }

  let chart: Buffer | null = null;
  if (candles.length >= 10) {
    try {
      chart = await renderChart(candles, symbol, overview.price, overview.changePercent24h);
    } catch {
      // Chart render failed — not critical
    }
  }

  return { symbol, overview, technicals, chart };
}

async function getWatchlistSymbols(): Promise<string[]> {
  try {
    const db = await getDb();
    const rows = db.select().from(watchlist).all();
    if (rows.length > 0) return rows.map((r) => r.symbol.toUpperCase());
  } catch {
    // DB might not be initialized
  }
  // Fallback to config default watchlist
  return appConfig.DEFAULT_WATCHLIST;
}

async function getActiveAlertCount(): Promise<number> {
  try {
    const db = await getDb();
    return db.select().from(alerts).where(eq(alerts.active, true)).all().length;
  } catch {
    return 0;
  }
}

interface PositionSummary {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number | null;
  pnlPercent: number | null;
}

async function getPositionSummaries(): Promise<PositionSummary[]> {
  try {
    const db = await getDb();
    const rows = db.select().from(positions).all();
    if (rows.length === 0) return [];

    const summaries = await Promise.all(
      rows.map(async (pos) => {
        const overview = await fetch24hrCached(pos.symbol);
        const currentPrice = overview?.price ?? null;
        const pnlPercent = currentPrice != null
          ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
          : null;
        return {
          symbol: pos.symbol,
          quantity: pos.quantity,
          entryPrice: pos.entryPrice,
          currentPrice,
          pnlPercent,
        };
      })
    );
    return summaries;
  } catch {
    return [];
  }
}

export async function generateBriefing(): Promise<{
  embeds: EmbedBuilder[];
  files: { attachment: Buffer; name: string }[];
}> {
  const symbols = await getWatchlistSymbols();
  const [alertCount, positionSummaries] = await Promise.all([
    getActiveAlertCount(),
    getPositionSummaries(),
  ]);

  // Fetch data for all watchlist symbols in parallel
  const results = await Promise.allSettled(symbols.map((s) => gatherSymbolData(s)));
  const briefings: SymbolBriefing[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) briefings.push(r.value);
  }

  // Sort by absolute change — biggest movers first
  briefings.sort((a, b) => Math.abs(b.overview.changePercent24h) - Math.abs(a.overview.changePercent24h));

  // --- Build the main embed ---
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

  const mainEmbed = new EmbedBuilder()
    .setTitle(`Daily Briefing — ${dateStr}`)
    .setColor(COLOR_BLUE)
    .setTimestamp();

  // Market overview section
  if (briefings.length > 0) {
    const overviewLines = briefings.map((b) => {
      const arrow = b.overview.changePercent24h >= 0 ? "▲" : "▼";
      const techInfo = b.technicals
        ? ` | RSI ${b.technicals.indicators.rsi?.toFixed(0) ?? "—"} ${directionEmoji(b.technicals.overallDirection)}`
        : "";
      return `**${b.symbol}** ${formatUsd(b.overview.price)} ${arrow} ${formatPct(b.overview.changePercent24h)}${techInfo}`;
    });
    mainEmbed.addFields({ name: "Watchlist", value: overviewLines.join("\n"), inline: false });
  }

  // Top mover highlight
  if (briefings.length > 0) {
    const top = briefings[0];
    const dir = top.overview.changePercent24h >= 0 ? "gainer" : "loser";
    mainEmbed.addFields({
      name: `Top Mover`,
      value: `**${top.symbol}** is today's biggest ${dir} at ${formatPct(top.overview.changePercent24h)}`,
      inline: false,
    });
  }

  // Signals section — list significant technical signals
  const significantSignals: string[] = [];
  for (const b of briefings) {
    if (!b.technicals) continue;
    const { indicators, overallDirection, overallStrength } = b.technicals;
    // Overbought/oversold
    if (indicators.rsi != null && indicators.rsi > 70) {
      significantSignals.push(`**${b.symbol}** RSI ${indicators.rsi.toFixed(0)} — overbought`);
    } else if (indicators.rsi != null && indicators.rsi < 30) {
      significantSignals.push(`**${b.symbol}** RSI ${indicators.rsi.toFixed(0)} — oversold`);
    }
    // Strong trend signals
    if (overallStrength > 0.6) {
      significantSignals.push(`**${b.symbol}** strong ${overallDirection} signal (${(overallStrength * 100).toFixed(0)}%)`);
    }
  }
  if (significantSignals.length > 0) {
    mainEmbed.addFields({
      name: "Key Signals",
      value: significantSignals.slice(0, 6).join("\n"),
      inline: false,
    });
  }

  // Portfolio section
  if (positionSummaries.length > 0) {
    const posLines = positionSummaries.map((p) => {
      const pnl = p.pnlPercent != null ? ` (${formatPct(p.pnlPercent)})` : "";
      const price = p.currentPrice != null ? formatUsd(p.currentPrice) : "—";
      return `**${p.symbol}** ${p.quantity} @ ${formatUsd(p.entryPrice)} → ${price}${pnl}`;
    });
    const totalPnl = positionSummaries
      .filter((p) => p.pnlPercent != null)
      .reduce((sum, p) => sum + p.pnlPercent!, 0);
    const avgPnl = positionSummaries.length > 0 ? totalPnl / positionSummaries.filter((p) => p.pnlPercent != null).length : 0;

    posLines.push(`\nAvg P&L: ${formatPct(avgPnl)}`);
    mainEmbed.addFields({ name: "Portfolio", value: posLines.join("\n"), inline: false });
  }

  // Alerts section
  if (alertCount > 0) {
    mainEmbed.addFields({
      name: "Active Alerts",
      value: `${alertCount} alert${alertCount === 1 ? "" : "s"} active`,
      inline: true,
    });
  }

  mainEmbed.setFooter({ text: "Market Sentinel Daily Briefing" });

  // Collect charts to attach
  const files: { attachment: Buffer; name: string }[] = [];
  // Attach chart for the top 2 movers
  for (const b of briefings.slice(0, 2)) {
    if (b.chart) {
      files.push({ attachment: b.chart, name: `${b.symbol}-daily.png` });
    }
  }

  return { embeds: [mainEmbed], files };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function getNextBriefingTime(): Date {
  const now = new Date();
  // Convert desired local hour to UTC
  const targetUtcHour = (BRIEFING_HOUR - BRIEFING_TZ_OFFSET + 24) % 24;

  const next = new Date(now);
  next.setUTCHours(targetUtcHour, 0, 0, 0);

  // If we've already passed today's time, schedule for tomorrow
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next;
}

function scheduleNext(): void {
  const nextTime = getNextBriefingTime();
  const delayMs = nextTime.getTime() - Date.now();

  console.log(
    `[Briefing] Next briefing scheduled for ${nextTime.toISOString()} (in ${Math.round(delayMs / 60_000)} min)`
  );

  scheduledTimeout = setTimeout(async () => {
    await postBriefing();
    // Schedule the next one after posting
    scheduleNext();
  }, delayMs);
}

/** Get the date string (YYYY-MM-DD) of the last posted briefing, if any. */
async function getLastBriefingDate(): Promise<string | null> {
  try {
    const db = await getDb();
    const row = db.select().from(settings).where(eq(settings.key, "last_briefing_date")).get();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** Persist the date of the last posted briefing. */
async function setLastBriefingDate(dateStr: string): Promise<void> {
  try {
    const db = await getDb();
    // Upsert: delete then insert (sql.js/drizzle doesn't have ON CONFLICT easily)
    db.delete(settings).where(eq(settings.key, "last_briefing_date")).run();
    db.insert(settings).values({ key: "last_briefing_date", value: dateStr }).run();
    saveDb();
  } catch (err) {
    console.error("[Briefing] Failed to persist last briefing date:", err);
  }
}

/** Get today's date string in the briefing timezone. */
function getTodayDateStr(): string {
  const now = new Date();
  const localMs = now.getTime() + BRIEFING_TZ_OFFSET * 3600_000;
  const local = new Date(localMs);
  return local.toISOString().slice(0, 10);
}

async function postBriefing(): Promise<void> {
  if (!client || !channelId) {
    console.warn("[Briefing] Cannot post — client or channel not configured");
    return;
  }

  // Deduplicate: don't post if we already briefed today
  const today = getTodayDateStr();
  const lastDate = await getLastBriefingDate();
  if (lastDate === today) {
    console.log(`[Briefing] Already posted today (${today}) — skipping`);
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      console.error("[Briefing] Channel not found or not a text channel");
      return;
    }

    console.log("[Briefing] Generating daily briefing...");
    const { embeds, files } = await generateBriefing();

    await (channel as TextChannel).send({ embeds, files });
    await setLastBriefingDate(today);
    console.log("[Briefing] Posted daily briefing");
  } catch (err) {
    console.error("[Briefing] Failed to post:", err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startBriefingScheduler(discordClient: Client): void {
  client = discordClient;
  channelId = appConfig.DISCORD_CHANNEL_ID ?? null;

  if (!channelId) {
    console.warn("[Briefing] No DISCORD_CHANNEL_ID configured — scheduler disabled");
    return;
  }

  console.log(`[Briefing] Scheduler started — daily at ${BRIEFING_HOUR}:00 (UTC${BRIEFING_TZ_OFFSET >= 0 ? "+" : ""}${BRIEFING_TZ_OFFSET})`);
  scheduleNext();
}

export function stopBriefingScheduler(): void {
  if (scheduledTimeout) {
    clearTimeout(scheduledTimeout);
    scheduledTimeout = null;
  }
  client = null;
  channelId = null;
  console.log("[Briefing] Scheduler stopped");
}
