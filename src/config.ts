import { config } from "dotenv";
import { z } from "zod";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

// Load .env from CWD (default) or from a custom path via ENV_FILE
config({ path: process.env.ENV_FILE || undefined, override: true });

const configSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  FINNHUB_API_KEY: z.string().optional(),
  GOLDAPI_KEY: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CHANNEL_ID: z.string().optional(),
  DEFAULT_WATCHLIST: z
    .string()
    .default("BTC,ETH,SPY,SLV")
    .transform((s) => s.split(",")),
  ALERT_COOLDOWN_MINUTES: z.coerce.number().default(15),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid configuration:", parsed.error.format());
  process.exit(1);
}

export const appConfig = parsed.data;

export const DATA_DIR = join(homedir(), ".market-sentinel");
export const DB_PATH = join(DATA_DIR, "data.db");

mkdirSync(DATA_DIR, { recursive: true });

export function hasOpenAI(): boolean {
  return !!appConfig.OPENAI_API_KEY;
}

export function hasClaude(): boolean {
  return !!appConfig.ANTHROPIC_API_KEY;
}

export function hasGemini(): boolean {
  return !!appConfig.GEMINI_API_KEY;
}

export function hasGroq(): boolean {
  return !!appConfig.GROQ_API_KEY;
}

export function hasCohere(): boolean {
  return !!appConfig.COHERE_API_KEY;
}

export function hasMistral(): boolean {
  return !!appConfig.MISTRAL_API_KEY;
}

export function hasDeepSeek(): boolean {
  return !!appConfig.DEEPSEEK_API_KEY;
}

export function hasAnyAI(): boolean {
  return (
    hasOpenAI() ||
    hasClaude() ||
    hasGemini() ||
    hasGroq() ||
    hasCohere() ||
    hasMistral() ||
    hasDeepSeek()
  );
}

export function hasDiscord(): boolean {
  return !!appConfig.DISCORD_BOT_TOKEN;
}

export function requireAI(): void {
  if (!hasAnyAI()) {
    console.error(
      "At least one AI API key is required (OPENAI_API_KEY or ANTHROPIC_API_KEY)."
    );
    process.exit(1);
  }
}
