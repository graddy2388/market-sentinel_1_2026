import OpenAI from "openai";
import { appConfig } from "../config.js";
import { analysisResponseSchema, critiqueResponseSchema } from "./types.js";
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

async function chatCompletion(prompt: string): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 1000,
  });
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
  userMessage: string
): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 1000,
  });
  return response.choices[0]?.message?.content ?? "";
}

export async function chatWithOpenAIVision(
  systemPrompt: string,
  userMessage: string,
  imageUrl: string
): Promise<string> {
  const response = await getClient().chat.completions.create({
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
  });
  return response.choices[0]?.message?.content ?? "";
}
