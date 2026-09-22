/**
 * Structured-reply helper for agents: Claude first, OpenAI as fallback, and
 * one retry when a reply comes back garbled. Provider health tracking happens
 * underneath, in the Claude/OpenAI clients.
 */
import { chatWithClaude } from "../ai/claude.js";
import { chatWithOpenAI } from "../ai/openai.js";
import { completeParsed } from "../ai/council.js";
import { hasClaude, hasOpenAI } from "../config.js";

export async function askAgentJson<T>(
  system: string,
  prompt: string,
  schema: { parse: (v: unknown) => T },
  maxTokens = 500
): Promise<T> {
  if (hasClaude()) {
    try {
      return await completeParsed(() => chatWithClaude(system, prompt, maxTokens), schema);
    } catch (err) {
      if (!hasOpenAI()) throw err;
      console.error("[Agents] Claude failed, falling back to OpenAI:", err instanceof Error ? err.message : err);
    }
  }
  if (hasOpenAI()) {
    return completeParsed(() => chatWithOpenAI(system, prompt, maxTokens), schema);
  }
  throw new Error("No AI provider configured for agents");
}
