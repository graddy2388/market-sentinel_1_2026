import { fetch24hrCached, fetchCandlesCached, getSupportedSymbols, isSymbolAvailable } from "../../data/providers.js";
import { isFinnhubAvailable } from "../../data/finnhub.js";
import { analyzeTechnicals } from "../../analysis/signals.js";
import { councilAnalyze, councilCritique } from "../../ai/council.js";
import { chatWithClaude, chatWithClaudeVision } from "../../ai/claude.js";
import { chatWithOpenAI, chatWithOpenAIVision } from "../../ai/openai.js";
import { hasClaude, hasOpenAI, hasAnyAI } from "../../config.js";
import { renderChart } from "../../charts/renderer.js";
import type { CouncilAnalysisResult, CouncilCritiqueResult, ModelVote } from "../../ai/types.js";
import type { TechnicalSummary } from "../../analysis/types.js";

/** A chat response — text content with an optional chart image. */
export interface ChatResponse {
  content: string;
  chart?: Buffer;
  symbol?: string;
}

const DISCORD_CHAR_LIMIT = 2000;

// ---------------------------------------------------------------------------
// System prompts — mentor/advisor tone
// ---------------------------------------------------------------------------

/**
 * Default system prompt for general and deep-analysis questions.
 * Mentor voice: direct, honest, but not cold. Like a trading buddy
 * who's been at it for years and genuinely wants you to do well.
 */
const SYSTEM_PROMPT =
  "You are Market Sentinel, a seasoned trading advisor. " +
  "You're direct and honest — you don't sugarcoat — but you care about the person you're talking to. " +
  "Think of yourself as a mentor who's seen a lot of cycles. " +
  "You have access to real-time crypto market data. " +
  "Be concise — this is Discord, not an essay. " +
  "If the user asks about a specific asset without naming it, ask them to specify.";

/**
 * System prompt for quick questions (buy/sell, bull/bear, one-word, etc.).
 * The AI should match the user's energy and keep it short.
 */
const QUICK_SYSTEM_PROMPT =
  "You are Market Sentinel, a seasoned trading advisor on Discord. " +
  "The user wants a SHORT answer — match their energy. " +
  "If they ask for one word, give them one word and maybe a one-sentence reason. " +
  "If they ask buy or sell, just tell them and briefly say why. " +
  "Don't dump data they didn't ask for. Be direct but not robotic — " +
  "you're a mentor who respects people's time. " +
  "Use the market data provided to inform your answer but don't list every indicator.";

// ---------------------------------------------------------------------------
// Question depth detection
// ---------------------------------------------------------------------------

export type QuestionDepth = "quick" | "deep";

/**
 * Classify whether a message warrants a full council analysis or a quick
 * AI-powered answer with market context.
 */
export function detectQuestionDepth(text: string): QuestionDepth {
  const lower = text.toLowerCase().trim();

  // Explicit requests for brevity → quick (always honored)
  if (/\b(one word|1 word|quick|short|brief|tldr|tl;dr|simple|just tell me)\b/i.test(lower)) {
    return "quick";
  }

  // Trade proposals always get the full council treatment — check BEFORE
  // the length heuristic so "should I sell BTC at 70k?" isn't shortcut to quick
  if (isTradeProposal(text)) {
    return "deep";
  }

  // Explicit requests for depth → deep
  if (/\b(analy[sz]e|breakdown|technicals|full|detailed|deep dive|in.?depth|signals|indicators|compare)\b/i.test(lower)) {
    return "deep";
  }

  // "Buy or sell?" / "bull or bear?" style questions → quick
  if (/\b(buy|sell|hold|bull|bear)\b.*\b(or)\b.*\b(buy|sell|hold|bull|bear)\b/i.test(lower)) {
    return "quick";
  }

  // Very short questions with a symbol (< 60 chars) → quick
  // e.g. "is BTC a buy?" "how's ETH?" "XRP thoughts?"
  if (lower.length < 60) {
    return "quick";
  }

  // Default: if the message is moderately long, go deep; otherwise quick
  return lower.length > 120 ? "deep" : "quick";
}

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
    /\b(should i|thinking about|planning to|gonna|going to|want to)\b.*\b(buy|buying|sell|selling|long|longing|short|shorting|enter|exit|trade|trading|swap|dca|ape)\b/i,
    /\b(buy|buying|sell|selling|long|short|enter|exit|trade|trading|swap|dca|ape)\b.*\b(good idea|bad idea|smart|dumb|worth|risky)\b/i,
    /\b(critique|review|rate|evaluate)\b.*\b(trade|position|entry|plan)\b/i,
  ];
  return patterns.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Compact market context for quick answers
// ---------------------------------------------------------------------------

/**
 * Build a concise market snapshot string that gives the AI enough context
 * to answer a quick question without running the full council.
 */
function buildQuickContext(
  symbol: string,
  price: number | null,
  change24h: number | null,
  technicals: TechnicalSummary | null
): string {
  const parts: string[] = [];

  if (price != null && change24h != null) {
    const dir = change24h >= 0 ? "up" : "down";
    parts.push(`${symbol} is at $${price.toLocaleString()} (${dir} ${Math.abs(change24h).toFixed(2)}% in 24h).`);
  } else {
    parts.push(`${symbol} — price data unavailable.`);
  }

  if (technicals) {
    const { indicators, overallDirection, overallStrength } = technicals;
    const snippets: string[] = [];

    if (indicators.rsi != null) {
      const label =
        indicators.rsi > 70 ? "overbought" : indicators.rsi < 30 ? "oversold" : "neutral zone";
      snippets.push(`RSI ${indicators.rsi.toFixed(0)} (${label})`);
    }
    if (indicators.macd) {
      const macdDir = indicators.macd.histogram > 0 ? "bullish" : "bearish";
      snippets.push(`MACD ${macdDir}`);
    }
    snippets.push(`Overall signal: ${overallDirection} (${(overallStrength * 100).toFixed(0)}% strength)`);

    parts.push(`Technicals: ${snippets.join(", ")}.`);
  }

  return parts.join(" ");
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

  // Trim reasoning to ~120 chars to keep things readable
  const reason = v.reasoning.length > 120
    ? v.reasoning.slice(0, 117) + "..."
    : v.reasoning;
  lines.push(reason);

  // Action is the most useful part — surface it prominently
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

  if (result.votes.length === 0) {
    return "All AI models failed to respond. Try again later.";
  }

  // ── Council verdict — one punchy line ──
  if (result.consensus) {
    parts.push(`**Council:** ${result.consensus}`);
  } else {
    const b = result.directionBreakdown;
    const breakdownStr = [
      b.bullish > 0 ? `${b.bullish} bullish` : null,
      b.bearish > 0 ? `${b.bearish} bearish` : null,
      b.neutral > 0 ? `${b.neutral} neutral` : null,
    ].filter(Boolean).join(" / ");
    parts.push(`**Council:** ${breakdownStr}`);
  }

  // ── Key levels (aggregated) on one compact line ──
  const supports = result.votes.map((v) => v.analysis.keyLevels.support).filter((s): s is number => s != null);
  const resistances = result.votes.map((v) => v.analysis.keyLevels.resistance).filter((r): r is number => r != null);
  const levelParts: string[] = [];
  if (supports.length > 0) {
    const avg = supports.reduce((a, b) => a + b, 0) / supports.length;
    levelParts.push(`Support ~$${avg.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }
  if (resistances.length > 0) {
    const avg = resistances.reduce((a, b) => a + b, 0) / resistances.length;
    levelParts.push(`Resistance ~$${avg.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }
  if (levelParts.length > 0) {
    parts.push(levelParts.join(" | "));
  }

  // ── Per-model breakdown ──
  if (result.votes.length <= 3) {
    for (const vote of result.votes) {
      parts.push("");
      parts.push(formatVoteDetailed(vote));
    }
  } else {
    // Compact one-liner per model
    parts.push("");
    parts.push(result.votes.map(formatVoteCompact).join(" | "));

    // Surface the top recommendation
    const top = [...result.votes].sort((a, b) => b.analysis.confidence - a.analysis.confidence)[0];
    if (top?.analysis.actionSuggestion) {
      parts.push(`> ${top.analysis.actionSuggestion} — *${top.model}*`);
    }

    // Top 3 aggregated risks (keep it tight)
    const topRisks = aggregateRisks(result.votes);
    if (topRisks.length > 0) {
      parts.push(`**Risks:** ${topRisks.slice(0, 3).join(", ")}`);
    }
  }

  // ── Disagreements — only show if there's a real directional split ──
  const directionGroups = new Map<string, string[]>();
  for (const v of result.votes) {
    const group = directionGroups.get(v.analysis.direction) ?? [];
    group.push(v.model);
    directionGroups.set(v.analysis.direction, group);
  }
  if (directionGroups.size > 1) {
    const splitParts = Array.from(directionGroups.entries())
      .map(([dir, models]) => `${models.join(", ")} → ${dir}`)
      .join(" vs ");
    parts.push(`\n⚠️ **Split:** ${splitParts}`);
  }

  if (result.failed.length > 0) {
    parts.push(`*${result.failed.length} model${result.failed.length > 1 ? "s" : ""} failed*`);
  }

  return parts.join("\n");
}

function formatCouncilCritique(result: CouncilCritiqueResult): string {
  if (result.opinions.length === 0) {
    return "All AI models failed to respond. Try again later.";
  }

  const parts: string[] = [];

  const tag = result.majorityAssessment.toUpperCase();
  const emoji = tag === "GOOD" ? "✅" : tag === "RISKY" ? "⚠️" : "🚫";
  parts.push(`${emoji} **Verdict:** ${tag} (${result.avgScore.toFixed(1)}/10)`);

  // Show recommendations — one line per model
  for (const o of result.opinions) {
    const c = o.critique;
    const shortRec = c.recommendation.length > 100 ? c.recommendation.slice(0, 97) + "..." : c.recommendation;
    parts.push(`**${o.model}** ${c.score}/10 — ${shortRec}`);
  }

  // Surface critical/high issues only
  const criticalIssues = result.opinions
    .flatMap((o) => o.critique.issues.filter((i) => i.severity === "critical" || i.severity === "high"))
    .slice(0, 3);
  if (criticalIssues.length > 0) {
    parts.push("");
    for (const issue of criticalIssues) {
      parts.push(`> ⚠️ ${issue.description}`);
    }
  }

  if (result.failed.length > 0) {
    parts.push(`*${result.failed.length} model${result.failed.length > 1 ? "s" : ""} failed*`);
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
): Promise<ChatResponse> {
  const depth = detectQuestionDepth(question);

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

  // ── Quick path: short AI answer with market context, no council ──
  if (depth === "quick") {
    const context = buildQuickContext(
      symbol,
      marketData?.price ?? null,
      marketData?.changePercent24h ?? null,
      technicals,
    );
    const prompt = `${context}\n\nUser question: ${question}`;
    const text = await singleAIChat(QUICK_SYSTEM_PROMPT, prompt);
    // No chart for quick questions — keep it snappy
    return { content: `**${priceInfo}**\n${text}`, symbol };
  }

  // ── Deep path: full council analysis with chart ──

  // Generate chart image if we have enough candles
  let chart: Buffer | undefined;
  if (candles.length >= 10) {
    try {
      chart = await renderChart(
        candles,
        symbol,
        marketData?.price,
        marketData?.changePercent24h,
      );
    } catch (err) {
      console.error(`[Chat] Chart render failed for ${symbol}:`, err);
    }
  }

  if (isTradeProposal(question) && technicals) {
    const critique = await councilCritique(question, technicals);
    return { content: `**${priceInfo}**\n\n${formatCouncilCritique(critique)}`, chart, symbol };
  }

  if (technicals) {
    const analysis = await councilAnalyze(symbol, technicals);
    return { content: `**${priceInfo}**\n\n${formatCouncilAnalysis(analysis)}`, chart, symbol };
  }

  // Not enough data for technicals — fall back to AI chat
  const context = marketData
    ? `Current ${symbol} price: $${marketData.price}. 24h change: ${marketData.changePercent24h.toFixed(2)}%.`
    : `No market data available for ${symbol}.`;

  const prompt = `${context}\n\nUser question: ${question}`;
  const text = await singleAIChat(SYSTEM_PROMPT, prompt);
  return { content: text, chart, symbol };
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
  "You are Market Sentinel, a seasoned trading advisor analyzing a screenshot. " +
  "Identify what's shown (chart, order book, portfolio, positions, P&L, etc.) and give your take. " +
  "Call out red flags and opportunities — be honest but not harsh. " +
  "Keep it concise, this is Discord. Talk like a mentor, not a textbook.";

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
 * Handle a chat message. Returns an array of ChatResponse objects —
 * one per symbol when multiple are mentioned, plus any notes.
 * Each response includes text content and an optional chart image buffer.
 */
export async function handleChatMessage(question: string): Promise<ChatResponse[]> {
  if (!hasAnyAI()) {
    return [{ content: "No AI models are configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable chat." }];
  }

  const trimmed = question.trim();
  if (!trimmed) {
    return [{ content: "You mentioned me but didn't ask anything. What do you want to know?" }];
  }

  try {
    const symbols = findAllSymbols(trimmed);

    // Also pick up unknown tickers and try them as stock symbols (if Finnhub is up)
    const unknowns = findUnknownTickers(trimmed, symbols);
    const resolvedStocks: string[] = [];
    const trueUnknowns: string[] = [];

    if (unknowns.length > 0 && isFinnhubAvailable()) {
      // Check unknown tickers against Finnhub in parallel
      const checks = await Promise.allSettled(
        unknowns.map(async (ticker) => {
          const available = await isSymbolAvailable(ticker);
          return { ticker, available };
        })
      );
      for (const check of checks) {
        if (check.status === "fulfilled" && check.value.available) {
          resolvedStocks.push(check.value.ticker);
        } else if (check.status === "fulfilled") {
          trueUnknowns.push(check.value.ticker);
        }
      }
    } else {
      trueUnknowns.push(...unknowns);
    }

    const allSymbols = [...symbols, ...resolvedStocks];

    if (allSymbols.length > 0) {
      // Process all symbols in parallel
      const results = await Promise.allSettled(
        allSymbols.map((sym) => handleSymbolQuestion(sym, trimmed))
      );

      const responses: ChatResponse[] = [];
      for (let i = 0; i < allSymbols.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled") {
          const r = result.value;
          responses.push({ content: truncate(r.content), chart: r.chart, symbol: r.symbol });
        } else {
          responses.push({ content: `**${allSymbols[i]}** — Analysis failed. Try again in a moment.`, symbol: allSymbols[i] });
        }
      }

      if (trueUnknowns.length > 0) {
        responses.push({ content: `Couldn't find data for: ${trueUnknowns.join(", ")}` });
      }

      return responses;
    }

    // General trading question — single AI call
    return [{ content: truncate(await singleAIChat(SYSTEM_PROMPT, trimmed)) }];
  } catch (err) {
    console.error("[Chat] Error handling message:", err);
    return [{ content: "Something went wrong while processing your question. Try again in a moment." }];
  }
}
