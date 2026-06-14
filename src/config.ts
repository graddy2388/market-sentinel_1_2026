import { config } from "dotenv";
import { z } from "zod";
import { join, dirname } from "path";
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
  BRIEFING_HOUR: z.coerce.number().min(0).max(23).default(8),
  BRIEFING_TZ_OFFSET: z.coerce.number().min(-12).max(14).default(-4),
  // Web dashboard access token. When unset, the dashboard is disabled entirely
  // (routes 404) so it can never be exposed unauthenticated. Min length guards
  // against trivially guessable tokens.
  DASHBOARD_TOKEN: z.string().min(16, "DASHBOARD_TOKEN must be at least 16 characters").optional(),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid configuration:", parsed.error.format());
  process.exit(1);
}

export const appConfig = parsed.data;

// DB_PATH from env (Docker: /data/data.db) or fallback to ~/.market-sentinel/data.db
const envDbPath = process.env.DB_PATH;
export const DB_PATH = envDbPath || join(homedir(), ".market-sentinel", "data.db");
export const DATA_DIR = dirname(DB_PATH);

// Ensure data directory exists (skip if read-only filesystem)
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {
  // Directory may already exist or filesystem is read-only (Docker)
}

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

export function hasDashboard(): boolean {
  return !!appConfig.DASHBOARD_TOKEN;
}

export function requireAI(): void {
  if (!hasAnyAI()) {
    console.error(
      "At least one AI API key is required (OPENAI_API_KEY or ANTHROPIC_API_KEY)."
    );
    process.exit(1);
  }
}
