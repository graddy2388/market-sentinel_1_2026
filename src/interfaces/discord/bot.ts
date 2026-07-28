import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from "discord.js";
import { appConfig } from "../../config.js";
import { commands, handlePrice, handleAnalyze, handleAlerts, handleHelp } from "./commands.js";
import { alertEmbed, signalEmbed } from "./embeds.js";
import { handleChatMessage, handleImageMessage, type ChatResponse } from "./chat.js";
import { startBriefingScheduler, stopBriefingScheduler } from "./briefing.js";
import type { TriggeredAlert } from "../../alerts/engine.js";
import type { GradedSignal } from "../../signals/scorer.js";

let client: Client | null = null;
let alertChannelId: string | null = null;

// --- Per-user rate limiting for chat messages ---
const USER_RATE_LIMIT = 5;        // max requests per window
const USER_RATE_WINDOW_MS = 60_000; // 1-minute window
const userRateLimiter = new Map<string, { count: number; resetAt: number }>();

function checkUserRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = userRateLimiter.get(userId);
  if (!entry || now > entry.resetAt) {
    userRateLimiter.set(userId, { count: 1, resetAt: now + USER_RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= USER_RATE_LIMIT;
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of userRateLimiter) {
    if (now > entry.resetAt) userRateLimiter.delete(id);
  }
}, 5 * 60_000).unref();

export async function startDiscordBot(): Promise<Client> {
  const token = appConfig.DISCORD_BOT_TOKEN!;
  alertChannelId = appConfig.DISCORD_CHANNEL_ID ?? null;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`[Discord] Bot logged in as ${c.user.tag}`);

    // Register slash commands globally using the built-in ApplicationCommandManager
    try {
      const commandData = commands.map((cmd) => cmd.toJSON());
      await c.application.commands.set(commandData);
      console.log("[Discord] Slash commands registered");
    } catch (err) {
      console.error("[Discord] Failed to register slash commands:", err);
    }

    // Start the daily briefing scheduler
    startBriefingScheduler(c);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      switch (interaction.commandName) {
        case "price":
          await handlePrice(interaction);
          break;
        case "analyze":
          await handleAnalyze(interaction);
          break;
        case "alerts":
          await handleAlerts(interaction);
          break;
        case "help":
          await handleHelp(interaction);
          break;
        default:
          await interaction.reply({ content: "Unknown command.", ephemeral: true });
      }
    } catch (err) {
      console.error(`[Discord] Command error (${interaction.commandName}):`, err);
      try {
        const msg = "An error occurred while processing the command.";
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply({ content: msg });
        } else {
          await interaction.reply({ content: msg, ephemeral: true });
        }
      } catch {
        // interaction may have expired
      }
    }
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore messages from bots (including ourselves)
    if (message.author.bot) return;

    const isDM = message.channel.isDMBased();
    const isMentioned = client!.user && message.mentions.has(client!.user);

    if (!isDM && !isMentioned) return;

    // Per-user rate limiting — 5 requests per minute
    if (!checkUserRateLimit(message.author.id)) {
      try {
        await message.reply("You're sending messages too fast. Please wait a moment before trying again.");
      } catch { /* ignore */ }
      return;
    }

    // Strip the @mention from the message content to get the actual question
    let question = message.content;
    if (client!.user) {
      question = question.replace(new RegExp(`<@!?${client!.user.id}>`, "g"), "").trim();
    }

    try {
      // Show typing indicator while the AI processes
      if ("sendTyping" in message.channel) {
        await message.channel.sendTyping();
      }

      // Check for image attachments
      const imageAttachment = message.attachments.find((a) =>
        a.contentType?.startsWith("image/")
      );

      // Conversation memory is keyed per channel/DM so follow-ups keep context.
      const sessionId = message.channelId;

      if (imageAttachment) {
        const response = await handleImageMessage(question, imageAttachment.url, sessionId);
        await message.reply(response);
      } else {
        const responses = await handleChatMessage(question, sessionId);
        for (const response of responses) {
          const opts: { content: string; files?: { attachment: Buffer; name: string }[] } = {
            content: response.content,
          };
          if (response.chart) {
            opts.files = [{ attachment: response.chart, name: `${response.symbol ?? "chart"}.png` }];
          }
          await message.reply(opts);
        }
      }
    } catch (err) {
      console.error("[Discord] Chat message error:", err);
      try {
        await message.reply("Something went wrong. Try again in a moment.");
      } catch {
        // Message may have been deleted or channel unavailable
      }
    }
  });

  await client.login(token);
  return client;
}

export async function sendAlertNotification(alert: TriggeredAlert, currentPrice: number): Promise<void> {
  if (!client || !alertChannelId) return;

  try {
    const channel = await client.channels.fetch(alertChannelId);
    if (channel && channel.isTextBased() && "send" in channel) {
      await (channel as TextChannel).send({
        embeds: [alertEmbed(alert, currentPrice)],
      });
    }
  } catch (err) {
    console.error("[Discord] Failed to send alert notification:", err);
  }
}

export async function sendSignalNotification(signal: GradedSignal): Promise<void> {
  // Silently no-op if Discord isn't configured (mirrors sendAlertNotification).
  if (!client || !alertChannelId) return;

  try {
    const channel = await client.channels.fetch(alertChannelId);
    if (channel && channel.isTextBased() && "send" in channel) {
      await (channel as TextChannel).send({
        embeds: [signalEmbed(signal)],
      });
    }
  } catch (err) {
    console.error("[Discord] Failed to send signal notification:", err);
  }
}

export async function stopDiscordBot(): Promise<void> {
  stopBriefingScheduler();
  if (client) {
    await client.destroy();
    client = null;
    console.log("[Discord] Bot disconnected");
  }
}
