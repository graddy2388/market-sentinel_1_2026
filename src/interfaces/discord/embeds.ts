import { EmbedBuilder } from "discord.js";
import { getActiveModelNames } from "../../ai/council.js";
import { getCryptoSymbols, getStockSymbols } from "../../data/providers.js";
import { isFinnhubAvailable } from "../../data/finnhub.js";
import type { MarketOverview } from "../../data/types.js";
import type { TechnicalSummary, SignalDirection } from "../../analysis/types.js";
import type { TriggeredAlert } from "../../alerts/engine.js";
import type { GradedSignal, SignalCall } from "../../signals/scorer.js";
import type { ProviderAlert } from "../../ai/health.js";
import type { DecisionRecord } from "../../agents/types.js";

const COLOR_GREEN = 0x2ecc71;
const COLOR_RED = 0xe74c3c;
const COLOR_YELLOW = 0xf1c40f;
const COLOR_BLUE = 0x3498db;

function directionColor(direction: SignalDirection): number {
  if (direction === "bullish") return COLOR_GREEN;
  if (direction === "bearish") return COLOR_RED;
  return COLOR_YELLOW;
}

function formatUsd(n: number): string {
  if (Math.abs(n) >= 10) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // $1-$10 assets (XRP, etc.) move in fractions of a cent; two decimals made a
  // stop and entry a cent apart print identically.
  if (Math.abs(n) >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(4)}`;
}

function formatPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function formatVolume(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export function priceEmbed(data: MarketOverview): EmbedBuilder {
  const isPositive = data.changePercent24h >= 0;
  const arrow = isPositive ? "▲" : "▼";

  return new EmbedBuilder()
    .setTitle(`${data.symbol}/USD`)
    .setColor(isPositive ? COLOR_GREEN : COLOR_RED)
    .addFields(
      { name: "Price", value: formatUsd(data.price), inline: true },
      { name: "24h Change", value: `${arrow} ${formatPct(data.changePercent24h)}`, inline: true },
      { name: "Volume", value: formatVolume(data.volume24h), inline: true },
      { name: "24h High", value: formatUsd(data.high24h), inline: true },
      { name: "24h Low", value: formatUsd(data.low24h), inline: true },
    )
    .setFooter({ text: "Market Sentinel" })
    .setTimestamp();
}

export function alertEmbed(alert: TriggeredAlert, currentPrice: number): EmbedBuilder {
  const conditionLabel: Record<string, string> = {
    price_above: "Price Above",
    price_below: "Price Below",
    pct_change: "% Change Exceeded",
    rsi_above: "RSI Above",
    rsi_below: "RSI Below",
  };

  return new EmbedBuilder()
    .setTitle(`Alert Triggered: ${alert.symbol}`)
    .setColor(COLOR_RED)
    .setDescription(`Your **${conditionLabel[alert.conditionType] ?? alert.conditionType}** alert has been triggered.`)
    .addFields(
      { name: "Condition", value: `${conditionLabel[alert.conditionType] ?? alert.conditionType} ${alert.threshold}`, inline: true },
      { name: "Current Price", value: formatUsd(currentPrice), inline: true },
      { name: "Created", value: alert.createdAt, inline: false },
      { name: "Triggered", value: alert.triggeredAt, inline: false },
    )
    .setFooter({ text: "Market Sentinel Alert Engine" })
    .setTimestamp();
}

export function analysisEmbed(technicals: TechnicalSummary): EmbedBuilder {
  const { indicators, signals, overallDirection, overallStrength } = technicals;

  const directionEmoji =
    overallDirection === "bullish" ? "▲" : overallDirection === "bearish" ? "▼" : "◆";

  const indicatorLines: string[] = [];
  if (indicators.rsi !== null) indicatorLines.push(`**RSI:** ${indicators.rsi.toFixed(1)}`);
  if (indicators.macd) indicatorLines.push(`**MACD:** ${indicators.macd.histogram.toFixed(4)}`);
  if (indicators.sma20 !== null) indicatorLines.push(`**SMA20:** ${formatUsd(indicators.sma20)}`);
  if (indicators.sma50 !== null) indicatorLines.push(`**SMA50:** ${formatUsd(indicators.sma50)}`);
  if (indicators.bollingerBands) {
    indicatorLines.push(
      `**BB:** ${formatUsd(indicators.bollingerBands.lower)} / ${formatUsd(indicators.bollingerBands.middle)} / ${formatUsd(indicators.bollingerBands.upper)}`
    );
  }
  if (indicators.atr !== null) indicatorLines.push(`**ATR:** ${indicators.atr.toFixed(4)}`);

  const signalLines = signals.slice(0, 6).map((s) => {
    const icon = s.direction === "bullish" ? "▲" : s.direction === "bearish" ? "▼" : "◆";
    return `${icon} ${s.name} (${(s.strength * 100).toFixed(0)}%)`;
  });

  return new EmbedBuilder()
    .setTitle(`${technicals.symbol} Technical Analysis`)
    .setColor(directionColor(overallDirection))
    .setDescription(
      `${directionEmoji} **${overallDirection.toUpperCase()}** (strength: ${(overallStrength * 100).toFixed(0)}%)\nPrice: ${formatUsd(technicals.price)}`
    )
    .addFields(
      { name: "Indicators", value: indicatorLines.join("\n") || "N/A", inline: false },
      { name: "Signals", value: signalLines.join("\n") || "None", inline: false },
    )
    .setFooter({ text: "Market Sentinel" })
    .setTimestamp();
}

export function alertListEmbed(
  alertRows: Array<{ id: number; symbol: string; conditionType: string; threshold: number; createdAt: string }>
): EmbedBuilder {
  if (alertRows.length === 0) {
    return new EmbedBuilder()
      .setTitle("Active Alerts")
      .setColor(COLOR_BLUE)
      .setDescription("No active alerts.")
      .setFooter({ text: "Market Sentinel" })
      .setTimestamp();
  }

  const conditionLabel: Record<string, string> = {
    price_above: "Price Above",
    price_below: "Price Below",
    pct_change: "% Change",
    rsi_above: "RSI Above",
    rsi_below: "RSI Below",
  };

  const lines = alertRows.map(
    (a) => `**#${a.id}** ${a.symbol} — ${conditionLabel[a.conditionType] ?? a.conditionType} **${a.threshold}** (set ${a.createdAt})`
  );

  return new EmbedBuilder()
    .setTitle(`Active Alerts (${alertRows.length})`)
    .setColor(COLOR_BLUE)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Market Sentinel" })
    .setTimestamp();
}

export function helpEmbed(): EmbedBuilder {
  const models = getActiveModelNames();
  const modelStatus = models.length > 0
    ? models.join(", ")
    : "None configured — add API keys to .env";

  const cryptoSymbols = getCryptoSymbols();
  const stockSymbols = getStockSymbols();
  const finnhub = isFinnhubAvailable();

  // Build markets field
  const marketsLines: string[] = [];
  marketsLines.push(`**Crypto** (${cryptoSymbols.length}) — ${cryptoSymbols.slice(0, 12).join(", ")}...`);
  if (finnhub) {
    marketsLines.push(`**Stocks & ETFs** (${stockSymbols.length}+) — ${stockSymbols.slice(0, 10).join(", ")}...`);
    marketsLines.push(`**Commodities** — GLD, SLV (via ETFs)`);
    marketsLines.push("*Any US ticker works — just ask!*");
  } else {
    marketsLines.push("*Add FINNHUB_API_KEY for stocks, ETFs & commodities*");
  }

  return new EmbedBuilder()
    .setTitle("Market Sentinel")
    .setColor(COLOR_BLUE)
    .setDescription("Your AI-powered trading advisor. Ask me about crypto, stocks, or commodities — I'll give you a straight answer.")
    .addFields(
      {
        name: "Slash Commands",
        value: [
          "`/price <symbol>` — Current price + 24h stats",
          "`/analyze <symbol>` — Technical analysis (RSI, MACD, Bollinger, etc.)",
          "`/alerts` — View your active price alerts",
          "`/help` — This message",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Chat",
        value: [
          "**@ mention me** or **DM me** to chat. I scale my response to your question:",
          '• Quick questions → short answer ("buy or sell BTC?")',
          '• Deep questions → full council analysis ("analyze ETH technicals")',
          "• Send a screenshot → I'll analyze charts, positions, or P&L",
          '• I remember recent messages per channel, so follow-ups work ("why?")',
          '• Say "reset" to clear our conversation history',
        ].join("\n"),
        inline: false,
      },
      {
        name: "Markets",
        value: marketsLines.join("\n"),
        inline: false,
      },
      {
        name: "Tips",
        value: [
          '• Ask for "one word" or "quick" if you want a short take',
          '• Say "analyze" or "breakdown" for the full council treatment',
          "• Describe a trade idea and I'll critique it honestly",
          "• I post a daily briefing each morning with top movers + signals",
        ].join("\n"),
        inline: false,
      },
      {
        name: `Active AI Models (${models.length})`,
        value: modelStatus,
        inline: false,
      },
    )
    .setFooter({ text: "Market Sentinel" })
    .setTimestamp();
}

function signalCallColor(call: SignalCall): number {
  if (call === "STRONG_BUY" || call === "BUY") return COLOR_GREEN;
  if (call === "STRONG_SELL" || call === "SELL") return COLOR_RED;
  return COLOR_YELLOW;
}

function signalCallEmoji(call: SignalCall): string {
  switch (call) {
    case "STRONG_BUY": return "🟢🟢";
    case "BUY": return "🟢";
    case "SELL": return "🔴";
    case "STRONG_SELL": return "🔴🔴";
    default: return "⚪";
  }
}

/**
 * An AI provider broke or recovered. Written for the operator: what's wrong,
 * what (if anything) to do, and that the rest of the system keeps running.
 */
export function providerAlertEmbed(alert: ProviderAlert): EmbedBuilder {
  // Discord renders <t:unix:R> as a live relative time ("12 minutes ago").
  const since = alert.failingSince ? `<t:${Math.floor(alert.failingSince / 1000)}:R>` : null;

  if (alert.status === "recovered") {
    return new EmbedBuilder()
      .setTitle(`✅ ${alert.provider} is working again`)
      .setColor(COLOR_GREEN)
      .setDescription(since ? `It had been failing since ${since}.` : "Calls are succeeding again.")
      .setFooter({ text: "Market Sentinel health monitor" })
      .setTimestamp(alert.timestamp);
  }

  const fields = [
    { name: "What to do", value: alert.advice ?? "Check the container logs.", inline: false },
    {
      name: "Meanwhile",
      value:
        alert.healthyOthers && alert.healthyOthers.length > 0
          ? `Retries are automatic. Still working: ${alert.healthyOthers.join(", ")}.`
          : "No other AI provider is currently working — chat and AI analysis are down until one recovers.",
      inline: false,
    },
  ];
  if (since) fields.push({ name: "Failing since", value: since, inline: true });
  if (alert.consecutiveFailures) {
    fields.push({ name: "Failed calls in a row", value: String(alert.consecutiveFailures), inline: true });
  }

  return new EmbedBuilder()
    .setTitle(`⚠️ ${alert.reminder ? "Still failing: " : ""}${alert.provider} — ${alert.label ?? "failing"}`)
    .setColor(COLOR_RED)
    .addFields(fields)
    .setFooter({ text: "Market Sentinel health monitor" })
    .setTimestamp(alert.timestamp);
}

/**
 * A proposal that cleared every check. Phase B is shadow mode: this is what
 * WOULD go to approval, announced so its quality can be judged before any
 * approval path exists. Dissent is always shown, or "Unanimous" said outright —
 * a missing dissent field must never be ambiguous with "nobody objected".
 */
export function shadowProposalEmbed(record: DecisionRecord): EmbedBuilder {
  const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}%`);
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const c = record.confidence;
  const s = record.sentinel;

  const voteLines = record.votes.map((v) => {
    const name = v.agent[0].toUpperCase() + v.agent.slice(1);
    if (!v.evaluated) return `**${name}** — not evaluated yet`;
    return `**${name}** — ${v.direction} @ ${pct(v.confidence)}${v.isDissent ? " ⚠️ dissent" : ""}`;
  });

  const dissent = record.votes.filter((v) => v.isDissent);
  const dissentText = dissent.length
    ? dissent.map((v) => `**${v.agent}:** ${clip(v.rationale, 400)}`).join("\n")
    : "Unanimous — no agent dissented.";

  const dialogue = record.dialogue.ran
    ? `${record.dialogue.turns.length} turns; confidence ${pct(record.preDialogueConfidence)} → ${pct(c?.confidence)}`
    : record.dialogue.skippedReason ?? "Did not run";

  const fields = [
    {
      name: "Confidence",
      value: c
        ? `**${pct(c.confidence)}** (gate ${pct(c.threshold)}) = (½·${pct(c.sentinelConviction)} + ½·${pct(c.researchSupport)}) × ${c.agreementFactor} agreement × ${c.freshnessFactor} freshness`
        : "—",
      inline: false,
    },
    { name: "Votes", value: voteLines.join("\n"), inline: false },
    { name: "Dissent", value: dissentText, inline: false },
    { name: "Dialogue", value: dialogue, inline: false },
  ];
  if (s) {
    fields.push({
      name: "Levels",
      value: `Entry ${formatUsd(s.entry)} · Stop ${formatUsd(s.stop)} · Target ${formatUsd(s.target)}`,
      inline: false,
    });
  }

  return new EmbedBuilder()
    .setTitle(`🧪 Shadow proposal: ${record.proposedCall?.replace("_", " ") ?? record.action} ${record.symbol}`)
    .setColor(COLOR_BLUE)
    .setDescription("Cleared every check and **would go to you for approval**. Shadow mode: logged only — no order is placed.")
    .addFields(fields)
    .setFooter({ text: `Decision record #${record.id ?? "unsaved"} · Market Sentinel orchestrator · not financial advice` })
    .setTimestamp(record.createdAt);
}

export function signalEmbed(signal: GradedSignal): EmbedBuilder {
  const label = signal.call.replace("_", " ");
  const emoji = signalCallEmoji(signal.call);
  const isHold = signal.call === "HOLD";

  // A HOLD has no trade behind it, so entry/stop/target would be fiction — and
  // with conviction near zero the levels can even come out inverted.
  const levelFields = isHold
    ? [{ name: "Levels", value: "None — no trade setup", inline: true }]
    : [
        { name: "Entry", value: formatUsd(signal.entry), inline: true },
        { name: "Stop", value: formatUsd(signal.stop), inline: true },
        { name: "Target", value: formatUsd(signal.target), inline: true },
      ];

  return new EmbedBuilder()
    .setTitle(`${emoji} ${signal.symbol} — ${isHold ? "signal cleared (HOLD)" : label}`)
    .setColor(signalCallColor(signal.call))
    .setDescription(signal.rationale)
    .addFields(
      { name: "Conviction", value: `${(signal.conviction * 100).toFixed(0)}%`, inline: true },
      { name: "Price", value: formatUsd(signal.price), inline: true },
      ...levelFields,
      {
        name: "Source",
        value: signal.components.ai
          ? `Technical ${signal.components.technical} + AI ${signal.components.ai}${signal.components.agreement ? " (agree)" : " (mixed)"}`
          : `Technical ${signal.components.technical} (AI unavailable)`,
        inline: false,
      },
    )
    .setFooter({ text: "Market Sentinel Signal Engine — advisory only, not financial advice" })
    .setTimestamp();
}
