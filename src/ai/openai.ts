import OpenAI from "openai";
import { appConfig } from "../config.js";
import { analysisResponseSchema, critiqueResponseSchema } from "./types.js";
import { tracked } from "./health.js";
import type { AnalysisResponse, CritiqueResponse } from "./types.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    if (!appConfig.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }
    client = new OpenAI({ apiKey: appConfig.OPENAI_API_KEY });
  }
  return client;
}

/** Every OpenAI call goes through here so provider health sees it. */
function createCompletion(
  body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  options?: { signal?: AbortSignal }
): Promise<OpenAI.Chat.ChatCompletion> {
  return tracked("OpenAI", () => getClient().chat.completions.create(body, options));
}

const AI_CALL_TIMEOUT_MS = 30_000;

async function chatCompletion(prompt: string): Promise<string> {
  const response = await createCompletion(
    {
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    },
    { signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) },
  );
  return response.choices[0]?.message?.content ?? "";
}

function parseJson<T>(raw: string, schema: { parse: (v: unknown) => T }): T {
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return schema.parse(JSON.parse(cleaned));
}

export async function openaiAnalyze(prompt: string): Promise<AnalysisResponse> {
  const raw = await chatCompletion(prompt);
  return parseJson(raw, analysisResponseSchema);
}

export async function openaiCritique(prompt: string): Promise<CritiqueResponse> {
  const raw = await chatCompletion(prompt);
  return parseJson(raw, critiqueResponseSchema);
}

export async function chatWithOpenAI(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 1000,
  history: Array<{ role: "user" | "assistant"; content: string }> = []
): Promise<string> {
  const response = await createCompletion(
    {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user" as const, content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    },
    { signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) },
  );
  return response.choices[0]?.message?.content ?? "";
}

export async function chatWithOpenAIVision(
  systemPrompt: string,
  userMessage: string,
  imageUrl: string
): Promise<string> {
  // Validate URL before passing to OpenAI — restrict to Discord CDN
  const ALLOWED_HOSTS = ["cdn.discordapp.com", "media.discordapp.net"];
  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.includes(parsed.hostname)) {
      throw new Error(`Image host not allowed: ${parsed.hostname}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("not allowed")) throw err;
    throw new Error("Invalid image URL");
  }

  const response = await createCompletion(
    {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: userMessage || "Analyze this chart/screenshot." },
          ],
        },
      ],
      temperature: 0.3,
      max_tokens: 1500,
    },
    { signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) },
  );
  return response.choices[0]?.message?.content ?? "";
}

/**
 * One turn of a tool-enabled conversation. Returns the raw assistant message
 * so the caller can inspect tool_calls and drive the loop.
 */
export async function openaiToolTurn(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  tools: OpenAI.Chat.ChatCompletionTool[],
  maxTokens = 1200
): Promise<OpenAI.Chat.ChatCompletionMessage> {
  const response = await createCompletion(
    {
      model: "gpt-4o",
      messages,
      tools,
      temperature: 0.3,
      max_tokens: maxTokens,
    },
    { signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) },
  );
  return response.choices[0].message;
}
