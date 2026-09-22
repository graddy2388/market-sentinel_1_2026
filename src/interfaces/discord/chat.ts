import { chatWithClaudeVision } from "../../ai/claude.js";
import { chatWithOpenAIVision } from "../../ai/openai.js";
import { hasClaude, hasOpenAI, hasAnyAI } from "../../config.js";
import {
  getHistory,
  recordTurn,
  clearSession,
  getActiveSymbols,
  setActiveSymbols,
} from "../../ai/memory.js";
import { runToolConversation } from "../../ai/tool-loop.js";
import { getRecentSignals } from "../../signals/store.js";
import { MIN_REWARD_RISK, formatLevel, type GradedSignal } from "../../signals/scorer.js";

/** A chat response — text content with an optional chart image. */
export interface ChatResponse {
  content: string;
  chart?: Buffer;
  symbol?: string;
}

const DISCORD_CHAR_LIMIT = 2000;

// ---------------------------------------------------------------------------
// System prompt
//
// The bot has real tools now, so the prompt no longer asserts blanket data
// access. It previously claimed "You have access to real-time crypto market
// data" even on paths where no data was attached, which is how the model ended
// up both hallucinating actions ("added to your daily briefing") and denying
// capabilities it did have. The rule below is the guard against that.
// ---------------------------------------------------------------------------

const BASE_SYSTEM_PROMPT = [
  "You are Market Sentinel, a seasoned trading advisor on Discord.",
  "You're direct and honest — you don't sugarcoat — but you care about the person you're talking to.",
  "Think of yourself as a mentor who's seen a lot of cycles.",
  "",
  "You have tools for live market data, council analysis, the watchlist, alerts, and positions.",
  "Use them rather than guessing. The watchlist drives the daily briefing, so a request to",
  '"add X to my daily briefing" means calling manage_watchlist with action "add".',
  "",
  "CRITICAL: never claim you performed an action unless the corresponding tool call returned",
  "success. If a tool fails or you could not call it, say so plainly. Never invent prices,",
  "indicators, or confirmations — if you don't have data, fetch it or admit you don't have it.",
  "",
  "When a tool reports unavailable sources, tell the user which ones and the reason given",
  '(e.g. "news isn\'t connected", "CoinGecko rate-limited us"). A source we couldn\'t reach',
  "is a gap in OUR data, not evidence about the asset — never blame the asset being small",
  "or obscure for it. If you offer possible explanations for a move without data behind",
  "them, label them clearly as guesses.",
  "",
  "Be concise — this is Discord, not an essay. Match the user's energy: a one-word question",
  "gets a short answer. Don't list every indicator unless asked.",
  "You can see recent messages in this conversation — use them to resolve follow-ups and",
  'pronouns ("it", "that one") instead of asking the user to repeat themselves.',
].join("\n");

// ---------------------------------------------------------------------------
// Question depth detection
//
// No longer used to branch — the model decides whether to call run_analysis.
// It only nudges the prompt, so an explicit "analyze X" still reliably gets the
// full council rather than a quick price check.
// ---------------------------------------------------------------------------

export type QuestionDepth = "quick" | "deep";

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

/**
 * Classify whether a message warrants deep analysis or a quick answer.
 */
export function detectQuestionDepth(text: string): QuestionDepth {
  const lower = text.toLowerCase().trim();

  // Explicit requests for brevity → quick (always honored)
  if (/\b(one word|1 word|quick|short|brief|tldr|tl;dr|simple|just tell me)\b/i.test(lower)) {
    return "quick";
  }

  // Trade proposals warrant the full council — check BEFORE the length
  // heuristic so "should I sell BTC at 70k?" isn't shortcut to quick.
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

  // Very short questions → quick
  if (lower.length < 60) {
    return "quick";
  }

  return lower.length > 120 ? "deep" : "quick";
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recent signal posts
//
// The signal engine posts embeds to the channel, but those never enter chat
// memory — so "why is the entry and target the same?" got "which signal?"
// back, from the bot that had just posted it. The last day's posts ride along
// in the system prompt so questions about them resolve without a ticker.
// ---------------------------------------------------------------------------

const RECENT_SIGNAL_WINDOW_MS = 24 * 3_600_000;
const RECENT_SIGNAL_LIMIT = 5;

function formatAgo(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function describeRecentSignals(signals: GradedSignal[], now = Date.now()): string[] {
  if (signals.length === 0) return [];
  return [
    "",
    "Signals the automated signal engine recently posted to the channel, newest first. " +
      "Users may ask about these without naming the asset (\"why is the target so close?\"):",
    ...signals.map((s) => {
      const levels =
        s.call === "HOLD"
          ? "no levels (HOLD)"
          : `entry ${formatLevel(s.entry)}, stop ${formatLevel(s.stop)}, target ${formatLevel(s.target)}`;
      return `- ${s.symbol} ${s.call.replace("_", " ")} @ ${Math.round(s.conviction * 100)}%, ` +
        `${formatAgo(s.timestamp, now)}: price ${formatLevel(s.price)}, ${levels}. ${s.rationale}`;
    }),
    "How levels are set: entry is the price when the signal fired. The stop sits at the " +
      "AI council's support (resistance for shorts) or 1.5x ATR away; the target at council " +
      `resistance (support for shorts) or 3x ATR away, and must pay at least ${MIN_REWARD_RISK}:1 ` +
      "against the stop. Signals posted before that rule existed may not meet it — say so plainly " +
      "if one doesn't.",
  ];
}

/**
 * Build the per-message system prompt: base rules, a depth hint, the
 * conversation's active symbols so bare follow-ups ("yes pull current") have
 * something concrete to resolve against, and the channel's recent signal posts.
 */
function buildSystemPrompt(
  activeSymbols: string[],
  depth: QuestionDepth,
  recentSignals: GradedSignal[] = []
): string {
  const parts = [BASE_SYSTEM_PROMPT];

  if (activeSymbols.length > 0) {
    parts.push(
      "",
      `Active context: this conversation is currently about ${activeSymbols.join(", ")}. ` +
        "If the user's message doesn't name an asset, assume they mean these."
    );
  }

  parts.push(...describeRecentSignals(recentSignals));

  parts.push(
    "",
    depth === "deep"
      ? "The user seems to want depth — run_analysis is likely the right tool."
      : "The user wants a quick answer — prefer get_market_data over run_analysis."
  );

  return parts.join("\n");
}

function truncate(text: string): string {
  if (text.length <= DISCORD_CHAR_LIMIT) return text;
  return text.slice(0, DISCORD_CHAR_LIMIT - 4) + " ...";
}

// ---------------------------------------------------------------------------
// Public exports — called by bot.ts and the web dashboard
// ---------------------------------------------------------------------------

const VISION_PROMPT =
  "You are Market Sentinel, a seasoned trading advisor analyzing a screenshot. " +
  "Identify what's shown (chart, order book, portfolio, positions, P&L, etc.) and give your take. " +
  "Call out red flags and opportunities — be honest but not harsh. " +
  "Keep it concise, this is Discord. Talk like a mentor, not a textbook.";

export async function handleImageMessage(
  question: string,
  imageUrl: string,
  sessionId?: string
): Promise<string> {
  if (!hasAnyAI()) {
    return "No AI models are configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable image analysis.";
  }

  const prompt = question.trim() || "What do you see in this image? Analyze it from a trading perspective.";

  try {
    let response: string;
    if (hasClaude()) {
      try {
        response = await chatWithClaudeVision(VISION_PROMPT, prompt, imageUrl);
      } catch (err) {
        // Fall back to OpenAI vision if Claude fails (invalid key, outage).
        if (!hasOpenAI()) throw err;
        console.error("[Chat] Claude vision failed, falling back to OpenAI:", err instanceof Error ? err.message : err);
        response = await chatWithOpenAIVision(VISION_PROMPT, prompt, imageUrl);
      }
    } else {
      response = await chatWithOpenAIVision(VISION_PROMPT, prompt, imageUrl);
    }
    const answer = truncate(response);
    // Record so follow-ups about the screenshot ("what's the risk there?") work.
    if (sessionId) {
      recordTurn(sessionId, "user", `[shared a screenshot] ${prompt}`);
      recordTurn(sessionId, "assistant", answer);
    }
    return answer;
  } catch (err) {
    console.error("[Chat] Vision error:", err);
    return "Failed to analyze the image. Make sure it's a valid image format (PNG, JPG, GIF, WebP).";
  }
}

/**
 * Handle a chat message.
 *
 * The model drives via tools: it fetches market data, runs council analysis, or
 * modifies the watchlist as needed. Code no longer guesses intent, and the bot
 * can't confirm an action that didn't actually happen.
 *
 * @param sessionId Conversation key (Discord channel/DM id, or "dashboard").
 *                  Supplies prior turns and the active-symbol context so
 *                  follow-ups resolve without repeating the ticker.
 */
export async function handleChatMessage(
  question: string,
  sessionId?: string
): Promise<ChatResponse[]> {
  if (!hasAnyAI()) {
    return [{ content: "No AI models are configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable chat." }];
  }

  const trimmed = question.trim();
  if (!trimmed) {
    return [{ content: "You mentioned me but didn't ask anything. What do you want to know?" }];
  }

  // Let users explicitly wipe context.
  if (sessionId && /^(reset|forget|clear|new chat|start over)$/i.test(trimmed)) {
    clearSession(sessionId);
    return [{ content: "Cleared our conversation history. Starting fresh — what's on your mind?" }];
  }

  try {
    const activeSymbols = sessionId ? getActiveSymbols(sessionId) : [];
    const history = sessionId
      ? getHistory(sessionId).map((t) => ({ role: t.role, content: t.content }))
      : [];
    // Context, not a requirement — a DB hiccup must not take chat down with it.
    const recentSignals = await getRecentSignals(
      Date.now() - RECENT_SIGNAL_WINDOW_MS,
      RECENT_SIGNAL_LIMIT
    ).catch(() => [] as GradedSignal[]);

    const result = await runToolConversation({
      system: buildSystemPrompt(activeSymbols, detectQuestionDepth(trimmed), recentSignals),
      history,
      userMessage: trimmed,
    });

    const answer = result.text.trim() || "I couldn't put together an answer for that. Try rephrasing?";

    // Symbols the tools actually touched become the new active context, so the
    // next bare follow-up resolves to whatever we really looked at.
    const touched = [
      ...new Set(
        result.artifacts
          .map((a) => a.symbol)
          .filter((s): s is string => typeof s === "string" && s.length > 0)
      ),
    ];
    if (sessionId && touched.length > 0) {
      setActiveSymbols(sessionId, touched);
    }

    if (sessionId) {
      recordTurn(sessionId, "user", trimmed);
      recordTurn(sessionId, "assistant", answer);
    }

    // Charts ride along with the reply; the first one attaches to the answer.
    const charts = result.artifacts.filter((a) => a.chart);
    const responses: ChatResponse[] = [
      {
        content: truncate(answer),
        chart: charts[0]?.chart,
        symbol: charts[0]?.symbol ?? touched[0],
      },
    ];
    for (const extra of charts.slice(1)) {
      responses.push({
        content: `${extra.symbol ?? "Chart"}`,
        chart: extra.chart,
        symbol: extra.symbol,
      });
    }

    return responses;
  } catch (err) {
    console.error("[Chat] Error handling message:", err);
    return [{ content: "Something went wrong while processing your question. Try again in a moment." }];
  }
}
