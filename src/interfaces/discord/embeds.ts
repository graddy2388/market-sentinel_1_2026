import { EmbedBuilder } from "discord.js";
import type { MarketOverview } from "../../data/types.js";
import type { TechnicalSummary, SignalDirection } from "../../analysis/types.js";
import type { TriggeredAlert } from "../../alerts/engine.js";

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
  if (Math.abs(n) >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
