import Anthropic from "@anthropic-ai/sdk";
import { appConfig } from "../config.js";
import { analysisResponseSchema, critiqueResponseSchema } from "./types.js";
import type { AnalysisResponse, CritiqueResponse } from "./types.js";

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

async function chatCompletion(prompt: string): Promise<string> {
  const response = await getClient().messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
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
  userMessage: string
): Promise<string> {
  const response = await getClient().messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}

export async function chatWithClaudeVision(
  systemPrompt: string,
  userMessage: string,
  imageUrl: string
): Promise<string> {
  // Fetch the image and convert to base64
  const res = await fetch(imageUrl);
  const buffer = Buffer.from(await res.arrayBuffer());
  const base64 = buffer.toString("base64");

  // Detect media type from URL or default to png
  let mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" = "image/png";
  if (imageUrl.match(/\.jpe?g/i)) mediaType = "image/jpeg";
  else if (imageUrl.match(/\.gif/i)) mediaType = "image/gif";
  else if (imageUrl.match(/\.webp/i)) mediaType = "image/webp";

  const response = await getClient().messages.create({
    model: "claude-sonnet-4-6",
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
  });
  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}
