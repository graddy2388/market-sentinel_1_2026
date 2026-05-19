import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { fetch24hrCached, fetchCandlesCached } from "../../data/providers.js";
import { analyzeTechnicals } from "../../analysis/signals.js";
import { getDb } from "../../state/db.js";
import { alerts } from "../../state/schema.js";
import { eq } from "drizzle-orm";
import { symbolSchema } from "../../validation.js";
import { priceEmbed, analysisEmbed, alertListEmbed, helpEmbed } from "./embeds.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("price")
    .setDescription("Get current price and 24h stats for a crypto symbol")
    .addStringOption((opt) =>
      opt.setName("symbol").setDescription("Crypto symbol, e.g. BTC, ETH").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("analyze")
    .setDescription("Run technical analysis on a crypto symbol")
    .addStringOption((opt) =>
      opt.setName("symbol").setDescription("Crypto symbol, e.g. BTC, ETH").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("alerts")
    .setDescription("List all active price alerts"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show what Market Sentinel can do and which AI models are active"),
];

export async function handlePrice(interaction: ChatInputCommandInteraction): Promise<void> {
  const raw = interaction.options.getString("symbol", true);
  const parsed = symbolSchema.safeParse(raw);
  if (!parsed.success) {
    await interaction.reply({ content: "Invalid symbol. Use letters only (e.g. BTC, ETH).", ephemeral: true });
    return;
  }
  const symbol = parsed.data;
  await interaction.deferReply();

  const data = await fetch24hrCached(symbol);
  if (!data) {
    await interaction.editReply(`Could not fetch price data for **${symbol}**.`);
    return;
  }

  await interaction.editReply({ embeds: [priceEmbed(data)] });
}

export async function handleAnalyze(interaction: ChatInputCommandInteraction): Promise<void> {
  const raw = interaction.options.getString("symbol", true);
  const parsed = symbolSchema.safeParse(raw);
  if (!parsed.success) {
    await interaction.reply({ content: "Invalid symbol. Use letters only (e.g. BTC, ETH).", ephemeral: true });
    return;
  }
  const symbol = parsed.data;
  await interaction.deferReply();

  const candles = await fetchCandlesCached(symbol, "1h", 100);
  if (candles.length < 14) {
    await interaction.editReply(
      `Not enough data for **${symbol}**. Got ${candles.length} candles, need at least 14.`
    );
    return;
  }

  const technicals = analyzeTechnicals(symbol, candles);
  if (!technicals) {
    await interaction.editReply(`Technical analysis failed for **${symbol}**.`);
    return;
  }

  await interaction.editReply({ embeds: [analysisEmbed(technicals)] });
}

export async function handleAlerts(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const db = await getDb();
  const activeAlerts = db.select().from(alerts).where(eq(alerts.active, true)).all();

  const rows = activeAlerts.map((a) => ({
    id: a.id,
    symbol: a.symbol,
    conditionType: a.conditionType,
    threshold: a.threshold,
    createdAt: a.createdAt,
  }));

  await interaction.editReply({ embeds: [alertListEmbed(rows)] });
}

export async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ embeds: [helpEmbed()], ephemeral: true });
}
