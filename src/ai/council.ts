import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { appConfig } from "../config.js";
import { analysisResponseSchema, critiqueResponseSchema } from "./types.js";
import { buildAnalysisPrompt, buildCritiquePrompt } from "./prompts.js";
import type {
  AnalysisResponse,
  CritiqueResponse,
  CouncilAnalysisResult,
  CouncilCritiqueResult,
  ModelVote,
  ModelCritique,
  ModelError,
} from "./types.js";
import type { TechnicalSummary } from "../analysis/types.js";

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/** Per-model timeout for API calls (30 seconds). */
const AI_CALL_TIMEOUT_MS = 30_000;

/**
 * Soft deadline for the council as a whole. Once this passes AND a majority of
 * models have answered, we stop waiting for stragglers — the slowest model no
 * longer gates the reply. Models that miss the cutoff are reported as dropped.
 */
export const COUNCIL_SOFT_DEADLINE_MS = 10_000;

/**
 * Max output tokens per council response. The JSON schema needs ~200-400
 * tokens; generation time scales with output length, so keeping this tight is
 * a direct latency win (display truncates long reasoning anyway).
 */
const COUNCIL_MAX_TOKENS = 600;

interface AIProvider {
  name: string;
  available(): boolean;
  analyze(prompt: string): Promise<AnalysisResponse>;
  critique(prompt: string): Promise<CritiqueResponse>;
}

/**
 * Parse a model's JSON reply robustly:
 * 1. strip markdown code fences,
 * 2. try a direct parse,
 * 3. fall back to extracting the outermost {...} block (models sometimes wrap
 *    the JSON in prose despite instructions).
 */
export function parseJson<T>(raw: string, schema: { parse: (v: unknown) => T }): T {
  const cleaned = raw.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
  try {
    return schema.parse(JSON.parse(cleaned));
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("No JSON object found in model response");
    }
    return schema.parse(JSON.parse(cleaned.slice(start, end + 1)));
  }
}

/**
 * Settle a set of promises with an early-exit quorum:
 * - resolves when ALL tasks settle, or
 * - once the soft deadline has passed AND at least ceil(n/2) have fulfilled.
 * Tasks still pending at resolution are returned as null (dropped).
 * Handlers are attached to every task up front, so late settlement after an
 * early exit never becomes an unhandled rejection.
 */
export function settleWithQuorum<T>(
  tasks: Promise<T>[],
  softDeadlineMs: number = COUNCIL_SOFT_DEADLINE_MS
): Promise<Array<PromiseSettledResult<T> | null>> {
  if (tasks.length === 0) return Promise.resolve([]);
  const quorum = Math.ceil(tasks.length / 2);

  return new Promise((resolve) => {
    const results: Array<PromiseSettledResult<T> | null> = new Array(tasks.length).fill(null);
    let settledCount = 0;
    let fulfilledCount = 0;
    let deadlinePassed = false;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(results.slice());
    };

    const maybeFinishEarly = () => {
      if (deadlinePassed && fulfilledCount >= quorum) finish();
    };

    const timer = setTimeout(() => {
      deadlinePassed = true;
      maybeFinishEarly();
    }, softDeadlineMs);
    timer.unref?.();

    tasks.forEach((task, i) => {
      task
        .then(
          (value) => {
            results[i] = { status: "fulfilled", value };
            fulfilledCount++;
          },
          (reason) => {
            results[i] = { status: "rejected", reason };
          }
        )
        .then(() => {
          settledCount++;
          if (settledCount === tasks.length) finish();
          else maybeFinishEarly();
        });
    });
  });
}

/**
 * Sanitize upstream error messages before exposing to users.
 * Strips API keys, URLs, and internal details — returns a generic category.
 */
function sanitizeProviderError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes("timeout") || lower.includes("aborted")) return "request timed out";
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("auth")) return "authentication failed";
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota")) return "rate limited";
  if (lower.includes("500") || lower.includes("502") || lower.includes("503")) return "provider unavailable";
  if (lower.includes("json") || lower.includes("parse") || lower.includes("zod")) return "invalid response format";
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("fetch")) return "connection failed";

  // Default — don't leak raw message
  return "request failed";
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider factory (reuses the installed `openai` package)
// ---------------------------------------------------------------------------

function createOAIProvider(
  name: string,
  getApiKey: () => string | undefined,
  baseURL: string,
  model: string
): AIProvider {
  let client: OpenAI | null = null;

  function getClient(): OpenAI {
    if (!client) {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error(`${name} API key not configured`);
      client = new OpenAI({ apiKey, baseURL });
    }
    return client;
  }

  async function complete(prompt: string): Promise<string> {
    const res = await getClient().chat.completions.create(
      {
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: COUNCIL_MAX_TOKENS,
      },
      { signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) },
    );
    return res.choices[0]?.message?.content ?? "";
  }

  return {
    name,
    available: () => !!getApiKey(),
    async analyze(prompt) {
      return parseJson(await complete(prompt), analysisResponseSchema);
    },
    async critique(prompt) {
      return parseJson(await complete(prompt), critiqueResponseSchema);
    },
  };
}

// ---------------------------------------------------------------------------
// Claude provider (uses native Anthropic SDK)
// ---------------------------------------------------------------------------

function createClaudeProvider(): AIProvider {
  let client: Anthropic | null = null;

  function getClient(): Anthropic {
    if (!client) {
      if (!appConfig.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
      client = new Anthropic({ apiKey: appConfig.ANTHROPIC_API_KEY });
    }
    return client;
  }

  async function complete(prompt: string): Promise<string> {
    const res = await getClient().messages.create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: COUNCIL_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) },
    );
    const block = res.content[0];
    if (block.type !== "text") throw new Error("Unexpected response type");
    return block.text;
  }

  return {
    name: "Claude",
    available: () => !!appConfig.ANTHROPIC_API_KEY,
    async analyze(prompt) {
      return parseJson(await complete(prompt), analysisResponseSchema);
    },
    async critique(prompt) {
      return parseJson(await complete(prompt), critiqueResponseSchema);
    },
  };
}

// ---------------------------------------------------------------------------
// Provider registry — all 7 models
// ---------------------------------------------------------------------------

const providers: AIProvider[] = [
  // Existing paid models
  createOAIProvider(
    "OpenAI",
    () => appConfig.OPENAI_API_KEY,
    "https://api.openai.com/v1",
    "gpt-4o"
  ),
  createClaudeProvider(),

  // Free-tier models (OpenAI-compatible endpoints)
  createOAIProvider(
    "Gemini",
    () => appConfig.GEMINI_API_KEY,
    "https://generativelanguage.googleapis.com/v1beta/openai/",
    "gemini-2.0-flash"
  ),
  createOAIProvider(
    "Groq",
    () => appConfig.GROQ_API_KEY,
    "https://api.groq.com/openai/v1",
    "llama-3.3-70b-versatile"
  ),
  createOAIProvider(
    "Cohere",
    () => appConfig.COHERE_API_KEY,
    "https://api.cohere.com/compatibility/v1",
    "command-r-plus"
  ),
  createOAIProvider(
    "Mistral",
    () => appConfig.MISTRAL_API_KEY,
    "https://api.mistral.ai/v1",
    "mistral-small-latest"
  ),
  createOAIProvider(
    "DeepSeek",
    () => appConfig.DEEPSEEK_API_KEY,
    "https://api.deepseek.com",
    "deepseek-chat"
  ),
];

function getAvailableProviders(): AIProvider[] {
  return providers.filter((p) => p.available());
}

/** Returns the display names of all providers that have API keys configured. */
export function getActiveModelNames(): string[] {
  return getAvailableProviders().map((p) => p.name);
}

// ---------------------------------------------------------------------------
// Majority vote + disagreement detection
// ---------------------------------------------------------------------------

function computeMajority(votes: ModelVote[]): {
  direction: "bullish" | "bearish" | "neutral";
  breakdown: { bullish: number; bearish: number; neutral: number };
  avgConfidence: number;
} {
  const breakdown = { bullish: 0, bearish: 0, neutral: 0 };
  let totalConf = 0;

  for (const v of votes) {
    breakdown[v.analysis.direction]++;
    totalConf += v.analysis.confidence;
  }

  let direction: "bullish" | "bearish" | "neutral";
  if (breakdown.bullish > breakdown.bearish && breakdown.bullish > breakdown.neutral) {
    direction = "bullish";
  } else if (breakdown.bearish > breakdown.bullish && breakdown.bearish > breakdown.neutral) {
    direction = "bearish";
  } else {
    direction = "neutral";
  }

  return {
    direction,
    breakdown,
    avgConfidence: votes.length > 0 ? totalConf / votes.length : 0,
  };
}

function findCouncilDisagreements(votes: ModelVote[]): string[] {
  if (votes.length < 2) return [];
  const disagreements: string[] = [];

  // Direction splits
  const directionMap = new Map<string, string[]>();
  for (const v of votes) {
    const list = directionMap.get(v.analysis.direction) ?? [];
    list.push(v.model);
    directionMap.set(v.analysis.direction, list);
  }
  if (directionMap.size > 1) {
    const parts = Array.from(directionMap.entries())
      .map(([dir, models]) => `${models.join(", ")} say ${dir}`)
      .join(" | ");
    disagreements.push(`Direction split: ${parts}`);
  }

  // Confidence spread
  const confidences = votes.map((v) => v.analysis.confidence);
  const maxConf = Math.max(...confidences);
  const minConf = Math.min(...confidences);
  if (maxConf - minConf > 0.3) {
    const highest = votes.find((v) => v.analysis.confidence === maxConf)!;
    const lowest = votes.find((v) => v.analysis.confidence === minConf)!;
    disagreements.push(
      `Confidence spread: ${highest.model} ${(maxConf * 100).toFixed(0)}% vs ${lowest.model} ${(minConf * 100).toFixed(0)}%`
    );
  }

  // Unique risks flagged by only one model (only relevant with 3+ models)
  if (votes.length >= 3) {
    const riskOwners = new Map<string, string[]>();
    for (const v of votes) {
      for (const risk of v.analysis.risks) {
        const key = risk.toLowerCase().slice(0, 30);
        const models = riskOwners.get(key) ?? [];
        models.push(v.model);
        riskOwners.set(key, models);
      }
    }
    for (const [, models] of riskOwners) {
      if (models.length === 1) {
        disagreements.push(`Only ${models[0]} flagged a unique risk`);
        break; // cap at one to keep it concise
      }
    }
  }

  return disagreements;
}

function buildCouncilConsensus(votes: ModelVote[]): string | null {
  if (votes.length === 0) return null;

  if (votes.length === 1) {
    const v = votes[0];
    return `Only ${v.model}: ${v.analysis.direction} (${(v.analysis.confidence * 100).toFixed(0)}% confidence)`;
  }

  const { direction, breakdown, avgConfidence } = computeMajority(votes);
  const total = votes.length;
  const majorityCount = breakdown[direction];

  if (majorityCount === total) {
    return `Unanimous (${total}/${total}): ${direction} — avg ${(avgConfidence * 100).toFixed(0)}% confidence`;
  }

  if (majorityCount > total / 2) {
    return `Majority (${majorityCount}/${total}): ${direction} — avg ${(avgConfidence * 100).toFixed(0)}% confidence`;
  }

  return `Split vote (${breakdown.bullish} bullish / ${breakdown.bearish} bearish / ${breakdown.neutral} neutral) — no clear majority`;
}

// ---------------------------------------------------------------------------
// Council analysis — runs all available models in parallel
// ---------------------------------------------------------------------------

export async function councilAnalyze(
  symbol: string,
  technicals: TechnicalSummary
): Promise<CouncilAnalysisResult> {
  const prompt = buildAnalysisPrompt(symbol, technicals);
  const available = getAvailableProviders();

  // Early-exit quorum: don't let one slow model gate the whole reply.
  const results = await settleWithQuorum(
    available.map(async (provider): Promise<ModelVote> => {
      const analysis = await provider.analyze(prompt);
      return { model: provider.name, analysis };
    })
  );

  const votes: ModelVote[] = [];
  const failed: ModelError[] = [];

  results.forEach((result, i) => {
    if (result === null) {
      console.warn(`[Council] ${available[i].name} analysis dropped (no response within ${COUNCIL_SOFT_DEADLINE_MS / 1000}s)`);
      failed.push({ model: available[i].name, error: "too slow — dropped" });
    } else if (result.status === "fulfilled") {
      votes.push(result.value);
    } else {
      // Log the full error for debugging, expose only sanitized version to users
      const rawMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`[Council] ${available[i].name} analysis failed: ${rawMsg}`);
      failed.push({ model: available[i].name, error: sanitizeProviderError(result.reason) });
    }
  });

  const { direction, breakdown, avgConfidence } = computeMajority(votes);

  return {
    symbol,
    timestamp: Date.now(),
    votes,
    failed,
    majorityDirection: direction,
    directionBreakdown: breakdown,
    avgConfidence,
    disagreements: findCouncilDisagreements(votes),
    consensus: buildCouncilConsensus(votes),
  };
}

// ---------------------------------------------------------------------------
// Council critique — runs all available models in parallel
// ---------------------------------------------------------------------------

export async function councilCritique(
  tradeDescription: string,
  technicals: TechnicalSummary | null
): Promise<CouncilCritiqueResult> {
  const prompt = buildCritiquePrompt(tradeDescription, technicals);
  const available = getAvailableProviders();

  // Early-exit quorum: don't let one slow model gate the whole reply.
  const results = await settleWithQuorum(
    available.map(async (provider): Promise<ModelCritique> => {
      const critique = await provider.critique(prompt);
      return { model: provider.name, critique };
    })
  );

  const opinions: ModelCritique[] = [];
  const failed: ModelError[] = [];

  results.forEach((result, i) => {
    if (result === null) {
      console.warn(`[Council] ${available[i].name} critique dropped (no response within ${COUNCIL_SOFT_DEADLINE_MS / 1000}s)`);
      failed.push({ model: available[i].name, error: "too slow — dropped" });
    } else if (result.status === "fulfilled") {
      opinions.push(result.value);
    } else {
      const rawMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`[Council] ${available[i].name} critique failed: ${rawMsg}`);
      failed.push({ model: available[i].name, error: sanitizeProviderError(result.reason) });
    }
  });

  // Aggregate scores and assessments
  let totalScore = 0;
  const assessments = { good: 0, risky: 0, bad: 0 };
  for (const o of opinions) {
    totalScore += o.critique.score;
    assessments[o.critique.overallAssessment]++;
  }
  const avgScore = opinions.length > 0 ? totalScore / opinions.length : 0;

  let majorityAssessment: "good" | "risky" | "bad";
  if (assessments.bad >= assessments.risky && assessments.bad >= assessments.good) {
    majorityAssessment = "bad";
  } else if (assessments.risky >= assessments.good) {
    majorityAssessment = "risky";
  } else {
    majorityAssessment = "good";
  }

  return {
    opinions,
    failed,
    avgScore,
    majorityAssessment,
  };
}
