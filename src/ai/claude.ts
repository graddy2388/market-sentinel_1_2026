import Anthropic from "@anthropic-ai/sdk";
import { appConfig } from "../config.js";
import { analysisResponseSchema, critiqueResponseSchema } from "./types.js";
import { safeFetchImage } from "./safe-fetch.js";
import { MODELS } from "./models.js";
import type { AnalysisResponse, CritiqueResponse } from "./types.js";
import { tracked } from "./health.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!appConfig.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }
    client = new Anthropic({ apiKey: appConfig.ANTHROPIC_API_KEY });
  }
  return client;
}

const AI_CALL_TIMEOUT_MS = 30_000;

/**
 * Thinking is on by default on current Claude models. These calls want a
 * short structured answer, so it is disabled explicitly: thinking tokens bill
 * as output, and a thinking block would arrive where text is expected.
 */
const NO_THINKING = { type: "disabled" } as const;

/**
 * First text block, not the first block. With thinking enabled the first block
 * is a thinking block, and reading content[0] would throw on a valid reply.
 */
export function firstText(content: Anthropic.ContentBlock[]): string {
  const block = content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!block) throw new Error("No text block in Claude response");
  return block.text;
}

/** Every Claude call goes through here so provider health sees it. */
function createMessage(
  body: Anthropic.MessageCreateParamsNonStreaming,
  options?: { signal?: AbortSignal }
): Promise<Anthropic.Message> {
  return tracked("Claude", () => getClient().messages.create(body, options));
}

async function chatCompletion(prompt: string): Promise<string> {
  const response = await createMessage(
    {
      model: MODELS.claude,
      thinking: NO_THINKING,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    },
    { signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) },
  );
  return firstText(response.content);
}

function parseJson<T>(raw: string, schema: { parse: (v: unknown) => T }): T {
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return schema.parse(JSON.parse(cleaned));
}

export async function claudeAnalyze(prompt: string): Promise<AnalysisResponse> {
  const raw = await chatCompletion(prompt);
  return parseJson(raw, analysisResponseSchema);
}

export async function claudeCritique(prompt: string): Promise<CritiqueResponse> {
  const raw = await chatCompletion(prompt);
  return parseJson(raw, critiqueResponseSchema);
}

export async function chatWithClaude(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 1000,
  history: Array<{ role: "user" | "assistant"; content: string }> = []
): Promise<string> {
  const response = await createMessage(
    {
      model: MODELS.claude,
      thinking: NO_THINKING,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [...history, { role: "user" as const, content: userMessage }],
    },
    { signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) },
  );
  return firstText(response.content);
}

export async function chatWithClaudeVision(
  systemPrompt: string,
  userMessage: string,
  imageUrl: string
): Promise<string> {
  // Safe fetch: SSRF protection, size limit, timeout, HTTPS-only, Discord CDN only
  const { buffer, mediaType } = await safeFetchImage(imageUrl);
  const base64 = buffer.toString("base64");

  const response = await createMessage(
    {
      model: MODELS.claude,
      thinking: NO_THINKING,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            { type: "text", text: userMessage || "Analyze this chart/screenshot." },
          ],
        },
      ],
    },
    { signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) },
  );
  return firstText(response.content);
}

/**
 * One turn of a tool-enabled conversation. Returns the raw message so the
 * caller can inspect stop_reason and tool_use blocks and drive the loop.
 */
export async function claudeToolTurn(
  system: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  maxTokens = 1200
): Promise<Anthropic.Message> {
  return createMessage(
    {
      model: MODELS.claude,
      thinking: NO_THINKING,
      max_tokens: maxTokens,
      system,
      messages,
      tools,
    },
    { signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) },
  );
}
