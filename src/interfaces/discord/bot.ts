import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from "discord.js";
import { appConfig } from "../../config.js";
import { commands, handlePrice, handleAnalyze, handleAlerts } from "./commands.js";
import { alertEmbed } from "./embeds.js";
import { handleChatMessage, handleImageMessage } from "./chat.js";
import type { TriggeredAlert } from "../../alerts/engine.js";

let client: Client | null = null;
let alertChannelId: string | null = null;

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

      let response: string;
      if (imageAttachment) {
        response = await handleImageMessage(question, imageAttachment.url);
      } else {
        response = await handleChatMessage(question);
      }
      await message.reply(response);
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

export async function stopDiscordBot(): Promise<void> {
  if (client) {
    await client.destroy();
    client = null;
    console.log("[Discord] Bot disconnected");
  }
}
