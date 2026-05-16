import { fetch24hrCached, fetchCandlesCached, getSupportedSymbols } from "../../data/coingecko.js";
import { analyzeTechnicals } from "../../analysis/signals.js";
import { councilAnalyze, councilCritique } from "../../ai/council.js";
import { chatWithClaude, chatWithClaudeVision } from "../../ai/claude.js";
import { chatWithOpenAI, chatWithOpenAIVision } from "../../ai/openai.js";
import { hasClaude, hasOpenAI, hasAnyAI } from "../../config.js";
import type { CouncilAnalysisResult, CouncilCritiqueResult, ModelVote } from "../../ai/types.js";
import type { TechnicalSummary } from "../../analysis/types.js";

const DISCORD_CHAR_LIMIT = 2000;

const SYSTEM_PROMPT =
  "You are Market Sentinel, a blunt and honest trading advisor. " +
  "You have access to crypto market data. Be concise — this is Discord, not an essay. " +
  "If the user asks about a specific asset without naming it, ask them to specify.";

/**
 * Build a regex that matches any supported symbol as a standalone word.
 * Global flag so we can find ALL matches, not just the first.
 * Sorted longest-first so "MATIC" matches before "MAT" etc.
 */
function buildSymbolRegex(): RegExp {
  const symbols = getSupportedSymbols().sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(${symbols.join("|")})\\b`, "gi");
}

/** Extract all unique known symbols from a message. */
function findAllSymbols(text: string): string[] {
  const regex = buildSymbolRegex();
  const matches = [...text.matchAll(regex)];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    const sym = m[1].toUpperCase();
    if (!seen.has(sym)) {
      seen.add(sym);
      result.push(sym);
    }
  }
  return result;
}

/** Find ticker-like patterns in the original text that we don't support. */
function findUnknownTickers(text: string, knownSymbols: string[]): string[] {
  // Match 2-6 char uppercase sequences that appear as-is in the original text
  const potentialTickers = /\b[A-Z]{2,6}\b/g;
  const all = [...text.matchAll(potentialTickers)].map((m) => m[0]);
  const knownSet = new Set(knownSymbols);
  const unknowns = new Set<string>();
  for (const t of all) {
    if (!knownSet.has(t)) unknowns.add(t);
  }
  return [...unknowns];
}

/**
 * Detect whether the question sounds like a trade proposal.
 */
function isTradeProposal(text: string): boolean {
  const patterns = [
    /\b(should i|thinking about|planning to|gonna|going to|want to)\b.*\b(buy|sell|long|short|enter|exit|trade|swap|dca|ape)\b/i,
    /\b(buy|sell|long|short|enter|exit|trade|swap|dca|ape)\b.*\b(good idea|bad idea|smart|dumb|worth|risky)\b/i,
    /\b(critique|review|rate|evaluate)\b.*\b(trade|position|entry|plan)\b/i,
  ];
  return patterns.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Council analysis formatting — rich output
// ---------------------------------------------------------------------------

function formatVoteDetailed(vote: ModelVote): string {
  const v = vote.analysis;
  const dir = v.direction.toUpperCase();
  const conf = (v.confidence * 100).toFixed(0);
  const lines: string[] = [];

  lines.push(`**${vote.model}** — ${dir} (${conf}%)`);
  lines.push(v.reasoning);

  // Key levels + timeframe on one line
  const levelParts: string[] = [];
  if (v.keyLevels.support != null) levelParts.push(`Support: $${v.keyLevels.support.toLocaleString()}`);
  if (v.keyLevels.resistance != null) levelParts.push(`Resistance: $${v.keyLevels.resistance.toLocaleString()}`);
  if (levelParts.length > 0) levelParts.push(`Timeframe: ${v.timeframe}`);
  if (levelParts.length > 0) lines.push(levelParts.join(" | "));

  // Risks
  if (v.risks.length > 0) {
    lines.push(`Risks: ${v.risks.join(", ")}`);
  }

  // Action
  if (v.actionSuggestion) {
    lines.push(`> ${v.actionSuggestion}`);
  }

  return lines.join("\n");
}

function formatVoteCompact(vote: ModelVote): string {
  const v = vote.analysis;
  const dir = v.direction === "bullish" ? "BULL" : v.direction === "bearish" ? "BEAR" : "NEUTRAL";
  return `**${vote.model}:** ${dir} ${(v.confidence * 100).toFixed(0)}%`;
}

function buildDisagreementBreakdown(votes: ModelVote[]): string[] {
  if (votes.length < 2) return [];
  const lines: string[] = [];

  // Direction analysis — show who said what and a snippet of why
  const directionGroups = new Map<string, ModelVote[]>();
  for (const v of votes) {
    const group = directionGroups.get(v.analysis.direction) ?? [];
    group.push(v);
    directionGroups.set(v.analysis.direction, group);
  }

  if (directionGroups.size > 1) {
    for (const [dir, group] of directionGroups) {
      const names = group.map((v) => v.model).join(", ");
      // Grab the first 60 chars of reasoning from the first model in this group
      const snippet = group[0].analysis.reasoning.slice(0, 80);
      const ellipsis = group[0].analysis.reasoning.length > 80 ? "..." : "";
      lines.push(`**${dir.toUpperCase()}** (${names}): ${snippet}${ellipsis}`);
    }
  }

  // Key level comparison
  const supports = votes.filter((v) => v.analysis.keyLevels.support != null).map((v) => ({
    model: v.model,
    level: v.analysis.keyLevels.support!,
  }));
  const resistances = votes.filter((v) => v.analysis.keyLevels.resistance != null).map((v) => ({
    model: v.model,
    level: v.analysis.keyLevels.resistance!,
  }));

  if (supports.length >= 2) {
    const min = Math.min(...supports.map((s) => s.level));
    const max = Math.max(...supports.map((s) => s.level));
    if (max - min > min * 0.01) {
      // >1% difference — worth noting
      lines.push(`Support range: $${min.toLocaleString()} – $${max.toLocaleString()}`);
    } else {
      lines.push(`Support consensus: ~$${min.toLocaleString()}`);
    }
  }

  if (resistances.length >= 2) {
    const min = Math.min(...resistances.map((r) => r.level));
    const max = Math.max(...resistances.map((r) => r.level));
    if (max - min > min * 0.01) {
      lines.push(`Resistance range: $${min.toLocaleString()} – $${max.toLocaleString()}`);
    } else {
      lines.push(`Resistance consensus: ~$${min.toLocaleString()}`);
    }
  }

  // Confidence spread
  const confidences = votes.map((v) => ({ model: v.model, conf: v.analysis.confidence }));
  const maxC = confidences.reduce((a, b) => (a.conf > b.conf ? a : b));
  const minC = confidences.reduce((a, b) => (a.conf < b.conf ? a : b));
  if (maxC.conf - minC.conf > 0.15) {
    lines.push(
      `Confidence: ${minC.model} ${(minC.conf * 100).toFixed(0)}% → ${maxC.model} ${(maxC.conf * 100).toFixed(0)}%`
    );
  }

  // Risks that only one model flagged (when 3+ models)
  if (votes.length >= 3) {
    const riskCount = new Map<string, string[]>();
    for (const v of votes) {
      for (const risk of v.analysis.risks) {
        const key = risk.toLowerCase().slice(0, 40);
        const models = riskCount.get(key) ?? [];
        models.push(v.model);
        riskCount.set(key, models);
      }
    }
    const unique = [...riskCount.entries()]
      .filter(([, models]) => models.length === 1)
      .slice(0, 2);
    for (const [risk, [model]] of unique) {
      lines.push(`Only ${model} flagged: "${risk}"`);
    }
  }

  return lines;
}

function aggregateRisks(votes: ModelVote[]): string[] {
  if (votes.length < 3) return [];
  const riskCount = new Map<string, number>();
  for (const v of votes) {
    for (const risk of v.analysis.risks) {
      const key = risk.toLowerCase().slice(0, 50);
      riskCount.set(key, (riskCount.get(key) ?? 0) + 1);
    }
  }
  return [...riskCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([risk, count]) => `${risk} (${count}/${votes.length})`);
}

function formatCouncilAnalysis(result: CouncilAnalysisResult): string {
  const parts: string[] = [];

  // Council verdict with breakdown
  const b = result.directionBreakdown;
  const breakdownStr = [
    b.bullish > 0 ? `${b.bullish} bullish` : null,
    b.bearish > 0 ? `${b.bearish} bearish` : null,
    b.neutral > 0 ? `${b.neutral} neutral` : null,
  ].filter(Boolean).join(" / ");

  if (result.consensus) {
    parts.push(`**Council:** ${result.consensus}`);
  } else {
    parts.push(`**Council:** ${breakdownStr}`);
  }

  // Aggregate key levels from all votes
  const supports = result.votes.map((v) => v.analysis.keyLevels.support).filter((s): s is number => s != null);
  const resistances = result.votes.map((v) => v.analysis.keyLevels.resistance).filter((r): r is number => r != null);
  const metaLine: string[] = [`Avg confidence: ${(result.avgConfidence * 100).toFixed(0)}%`];
  if (supports.length > 0) {
    const avg = supports.reduce((a, b) => a + b, 0) / supports.length;
    metaLine.push(`Support: ~$${avg.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }
  if (resistances.length > 0) {
    const avg = resistances.reduce((a, b) => a + b, 0) / resistances.length;
    metaLine.push(`Resistance: ~$${avg.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }
  parts.push(metaLine.join(" | "));

  if (result.votes.length <= 3) {
    // Detailed per-model output
    for (const vote of result.votes) {
      parts.push("");
      parts.push(formatVoteDetailed(vote));
    }
  } else {
    // Compact per-model + aggregated data
    parts.push("");
    parts.push(result.votes.map(formatVoteCompact).join(" | "));

    // Aggregated risks across council
    const topRisks = aggregateRisks(result.votes);
    if (topRisks.length > 0) {
      parts.push(`\n**Top risks:** ${topRisks.join(", ")}`);
    }

    // Top recommendation from highest-confidence model
    const top = [...result.votes].sort((a, b) => b.analysis.confidence - a.analysis.confidence)[0];
    if (top?.analysis.actionSuggestion) {
      parts.push(`**Top recommendation (${top.model}, ${(top.analysis.confidence * 100).toFixed(0)}%):** ${top.analysis.actionSuggestion}`);
    }
  }

  if (result.failed.length > 0) {
    parts.push(`\n*Failed:* ${result.failed.map((f) => f.model).join(", ")}`);
  }

  // Rich disagreement breakdown
  const disagreements = buildDisagreementBreakdown(result.votes);
  if (disagreements.length > 0) {
    parts.push(`\n**Where they diverge:**`);
    for (const line of disagreements) {
      parts.push(line);
    }
  }

  if (result.votes.length === 0) {
    parts.push("All AI models failed to respond. Try again later.");
  }

  return parts.join("\n");
}

function formatCouncilCritique(result: CouncilCritiqueResult): string {
  const parts: string[] = [];

  const tag = result.majorityAssessment.toUpperCase();
  parts.push(`**Council Verdict:** ${tag} (avg score ${result.avgScore.toFixed(1)}/10)`);

  if (result.opinions.length <= 3) {
    for (const o of result.opinions) {
      const c = o.critique;
      parts.push("");
      parts.push(
        `**${o.model}:** ${c.overallAssessment.toUpperCase()} (${c.score}/10) — ${c.recommendation}`
      );
      if (c.issues.length > 0) {
        const top = c.issues.slice(0, 3);
        parts.push(top.map((i) => `> [${i.severity}] ${i.description}`).join("\n"));
      }
    }
  } else {
    for (const o of result.opinions) {
      const c = o.critique;
      const shortRec = c.recommendation.length > 80 ? c.recommendation.slice(0, 77) + "..." : c.recommendation;
      parts.push(`**${o.model}:** ${c.overallAssessment.toUpperCase()} ${c.score}/10 — ${shortRec}`);
    }

    const allIssues = result.opinions
      .flatMap((o) => o.critique.issues.filter((i) => i.severity === "critical" || i.severity === "high"))
      .slice(0, 5);
    if (allIssues.length > 0) {
      parts.push(`\n**Key Issues:**`);
      for (const issue of allIssues) {
        parts.push(`> [${issue.severity}] ${issue.description}`);
      }
    }
  }

  if (result.failed.length > 0) {
    parts.push(`\n*Failed:* ${result.failed.map((f) => f.model).join(", ")}`);
  }

  if (result.opinions.length === 0) {
    parts.push("All AI models failed to respond. Try again later.");
  }

  return parts.join("\n");
}

function truncate(text: string): string {
  if (text.length <= DISCORD_CHAR_LIMIT) return text;
  return text.slice(0, DISCORD_CHAR_LIMIT - 4) + " ...";
}

// ---------------------------------------------------------------------------
// Symbol question handler
// ---------------------------------------------------------------------------

async function handleSymbolQuestion(
  symbol: string,
  question: string
): Promise<string> {
  const [marketData, candles] = await Promise.all([
    fetch24hrCached(symbol),
    fetchCandlesCached(symbol, "1h", 100),
  ]);

  let technicals: TechnicalSummary | null = null;
  if (candles.length >= 14) {
    technicals = analyzeTechnicals(symbol, candles);
  }

  const priceInfo = marketData
    ? `${symbol} — $${marketData.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${marketData.changePercent24h >= 0 ? "+" : ""}${marketData.changePercent24h.toFixed(2)}% 24h)`
    : `${symbol} — price data unavailable`;

  if (isTradeProposal(question) && technicals) {
    const critique = await councilCritique(question, technicals);
    return `**${priceInfo}**\n\n${formatCouncilCritique(critique)}`;
  }

  if (technicals) {
    const analysis = await councilAnalyze(symbol, technicals);
    return `**${priceInfo}**\n\n${formatCouncilAnalysis(analysis)}`;
  }

  const context = marketData
    ? `Current ${symbol} price: $${marketData.price}. 24h change: ${marketData.changePercent24h.toFixed(2)}%.`
    : `No market data available for ${symbol}.`;

  const prompt = `${context}\n\nUser question: ${question}`;
  return await singleAIChat(SYSTEM_PROMPT, prompt);
}

// ---------------------------------------------------------------------------
// Single AI chat (for general questions without symbol data)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public exports — called by bot.ts
// ---------------------------------------------------------------------------

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

/**
 * Handle a chat message. Returns an array of response strings —
 * one per symbol when multiple are mentioned, plus any notes.
 */
export async function handleChatMessage(question: string): Promise<string[]> {
  if (!hasAnyAI()) {
    return ["No AI models are configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable chat."];
  }

  const trimmed = question.trim();
  if (!trimmed) {
    return ["You mentioned me but didn't ask anything. What do you want to know?"];
  }

  try {
    const symbols = findAllSymbols(trimmed);

    if (symbols.length > 0) {
      // Process all symbols in parallel
      const results = await Promise.allSettled(
        symbols.map((sym) => handleSymbolQuestion(sym, trimmed))
      );

      const responses: string[] = [];
      for (let i = 0; i < symbols.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled") {
          responses.push(truncate(result.value));
        } else {
          responses.push(`**${symbols[i]}** — Analysis failed. Try again in a moment.`);
        }
      }

      // Check for ticker-like patterns that aren't supported
      const unknowns = findUnknownTickers(trimmed, symbols);
      if (unknowns.length > 0) {
        responses.push(`Not supported: ${unknowns.join(", ")}. Supported symbols: ${getSupportedSymbols().join(", ")}`);
      }

      return responses;
    }

    // General trading question — single AI call
    return [truncate(await singleAIChat(SYSTEM_PROMPT, trimmed))];
  } catch (err) {
    console.error("[Chat] Error handling message:", err);
    return ["Something went wrong while processing your question. Try again in a moment."];
  }
}
