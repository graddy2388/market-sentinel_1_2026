import { fetch24hrCached, fetchCandlesCached, getSupportedSymbols } from "../../data/coingecko.js";
import { analyzeTechnicals } from "../../analysis/signals.js";
import { dualAnalyze, dualCritique } from "../../ai/dual-analyst.js";
import { chatWithClaude, chatWithClaudeVision } from "../../ai/claude.js";
import { chatWithOpenAI, chatWithOpenAIVision } from "../../ai/openai.js";
import { hasClaude, hasOpenAI, hasAnyAI } from "../../config.js";
import type { DualAnalysisResult, CritiqueResponse } from "../../ai/types.js";
import type { TechnicalSummary } from "../../analysis/types.js";

const DISCORD_CHAR_LIMIT = 2000;

const SYSTEM_PROMPT =
  "You are Market Sentinel, a blunt and honest trading advisor. " +
  "You have access to crypto market data. Be concise — this is Discord, not an essay. " +
  "If the user asks about a specific asset without naming it, ask them to specify.";

/**
 * Build a regex that matches any supported symbol as a standalone word.
 * Sorted longest-first so "MATIC" matches before "MAT" etc.
 */
function buildSymbolRegex(): RegExp {
  const symbols = getSupportedSymbols().sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(${symbols.join("|")})\\b`, "i");
}

/**
 * Detect whether the question sounds like a trade proposal
 * (e.g. "should I buy …", "thinking about longing …").
 */
function isTradeProposal(text: string): boolean {
  const patterns = [
    /\b(should i|thinking about|planning to|gonna|going to|want to)\b.*\b(buy|sell|long|short|enter|exit|trade|swap|dca|ape)\b/i,
    /\b(buy|sell|long|short|enter|exit|trade|swap|dca|ape)\b.*\b(good idea|bad idea|smart|dumb|worth|risky)\b/i,
    /\b(critique|review|rate|evaluate)\b.*\b(trade|position|entry|plan)\b/i,
  ];
  return patterns.some((p) => p.test(text));
}

function formatDualAnalysis(result: DualAnalysisResult, question: string): string {
  const parts: string[] = [];

  if (result.consensus) {
    parts.push(`**Consensus:** ${result.consensus}`);
  }

  if (result.openai) {
    const o = result.openai;
    parts.push(
      `**OpenAI:** ${o.direction} (${(o.confidence * 100).toFixed(0)}%) — ${o.reasoning}`
    );
    if (o.actionSuggestion) parts.push(`> ${o.actionSuggestion}`);
  }

  if (result.claude) {
    const c = result.claude;
    parts.push(
      `**Claude:** ${c.direction} (${(c.confidence * 100).toFixed(0)}%) — ${c.reasoning}`
    );
    if (c.actionSuggestion) parts.push(`> ${c.actionSuggestion}`);
  }

  if (result.disagreements.length > 0) {
    parts.push(`\n**Disagreements:**\n${result.disagreements.map((d) => `- ${d}`).join("\n")}`);
  }

  if (!result.openai && !result.claude) {
    parts.push("Both AI models failed to respond. Try again later.");
  }

  return parts.join("\n");
}

function formatCritique(
  critique: { openai: CritiqueResponse | null; claude: CritiqueResponse | null }
): string {
  const parts: string[] = [];

  if (critique.openai) {
    const o = critique.openai;
    parts.push(
      `**OpenAI:** ${o.overallAssessment.toUpperCase()} (${o.score}/10) — ${o.recommendation}`
    );
    if (o.issues.length > 0) {
      const top = o.issues.slice(0, 3);
      parts.push(top.map((i) => `> [${i.severity}] ${i.description}`).join("\n"));
    }
  }

  if (critique.claude) {
    const c = critique.claude;
    parts.push(
      `**Claude:** ${c.overallAssessment.toUpperCase()} (${c.score}/10) — ${c.recommendation}`
    );
    if (c.issues.length > 0) {
      const top = c.issues.slice(0, 3);
      parts.push(top.map((i) => `> [${i.severity}] ${i.description}`).join("\n"));
    }
  }

  if (!critique.openai && !critique.claude) {
    parts.push("Both AI models failed to respond. Try again later.");
  }

  return parts.join("\n");
}

function truncate(text: string): string {
  if (text.length <= DISCORD_CHAR_LIMIT) return text;
  return text.slice(0, DISCORD_CHAR_LIMIT - 4) + " ...";
}

async function handleSymbolQuestion(
  symbol: string,
  question: string
): Promise<string> {
  // Fetch market data and candles in parallel
  const [marketData, candles] = await Promise.all([
    fetch24hrCached(symbol),
    fetchCandlesCached(symbol, "1h", 100),
  ]);

  let technicals: TechnicalSummary | null = null;
  if (candles.length >= 14) {
    technicals = analyzeTechnicals(symbol, candles);
  }

  // Price context header
  const priceInfo = marketData
    ? `${symbol} — $${marketData.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${marketData.changePercent24h >= 0 ? "+" : ""}${marketData.changePercent24h.toFixed(2)}% 24h)`
    : `${symbol} — price data unavailable`;

  if (isTradeProposal(question) && technicals) {
    const critique = await dualCritique(question, technicals);
    return `**${priceInfo}**\n\n${formatCritique(critique)}`;
  }

  if (technicals) {
    const analysis = await dualAnalyze(symbol, technicals);
    return `**${priceInfo}**\n\n${formatDualAnalysis(analysis, question)}`;
  }

  // Not enough candle data for full analysis — fall back to simple AI chat with price context
  const context = marketData
    ? `Current ${symbol} price: $${marketData.price}. 24h change: ${marketData.changePercent24h.toFixed(2)}%.`
    : `No market data available for ${symbol}.`;

  const prompt = `${context}\n\nUser question: ${question}`;
  return await singleAIChat(SYSTEM_PROMPT, prompt);
}

async function singleAIChat(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  if (hasClaude()) {
    return chatWithClaude(systemPrompt, userMessage);
  }
  if (hasOpenAI()) {
    return chatWithOpenAI(systemPrompt, userMessage);
  }
  return "No AI models are configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.";
}

const VISION_PROMPT =
  "You are Market Sentinel, a blunt and honest trading advisor analyzing a screenshot. " +
  "Identify what's shown (chart, order book, portfolio, positions, P&L, etc.) and give your analysis. " +
  "Call out any red flags, risks, or opportunities you see. Be concise — this is Discord.";

export async function handleImageMessage(
  question: string,
  imageUrl: string
): Promise<string> {
  if (!hasAnyAI()) {
    return "No AI models are configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable image analysis.";
  }

  const prompt = question.trim() || "What do you see in this image? Analyze it from a trading perspective.";

  try {
    // Prefer Claude for vision (strong at chart analysis), fall back to OpenAI
    let response: string;
    if (hasClaude()) {
      response = await chatWithClaudeVision(VISION_PROMPT, prompt, imageUrl);
    } else {
      response = await chatWithOpenAIVision(VISION_PROMPT, prompt, imageUrl);
    }
    return truncate(response);
  } catch (err) {
    console.error("[Chat] Vision error:", err);
    return "Failed to analyze the image. Make sure it's a valid image format (PNG, JPG, GIF, WebP).";
  }
}

export async function handleChatMessage(question: string): Promise<string> {
  if (!hasAnyAI()) {
    return "No AI models are configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable chat.";
  }

  const trimmed = question.trim();
  if (!trimmed) {
    return "You mentioned me but didn't ask anything. What do you want to know?";
  }

  try {
    // Check if the question references a known crypto symbol
    const match = trimmed.match(buildSymbolRegex());
    if (match) {
      const symbol = match[1].toUpperCase();
      return truncate(await handleSymbolQuestion(symbol, trimmed));
    }

    // General trading question — single AI call
    return truncate(await singleAIChat(SYSTEM_PROMPT, trimmed));
  } catch (err) {
    console.error("[Chat] Error handling message:", err);
    return "Something went wrong while processing your question. Try again in a moment.";
  }
}
