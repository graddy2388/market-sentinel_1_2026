import type { TechnicalSummary } from "../analysis/types.js";

export function buildAnalysisPrompt(
  symbol: string,
  technicals: TechnicalSummary
): string {
  const signalList = technicals.signals
    .map((s) => `- ${s.name}: ${s.direction} (strength ${(s.strength * 100).toFixed(0)}%) — ${s.description}`)
    .join("\n");

  const indicators = technicals.indicators;

  return `You are a professional trading analyst. Analyze the following market data for ${symbol} and provide your assessment.

## Current Data
- **Price**: $${technicals.price.toFixed(2)}
- **RSI(14)**: ${indicators.rsi?.toFixed(1) ?? "N/A"}
- **MACD**: ${indicators.macd ? `MACD=${indicators.macd.macd.toFixed(2)}, Signal=${indicators.macd.signal.toFixed(2)}, Hist=${indicators.macd.histogram.toFixed(2)}` : "N/A"}
- **SMA(20)**: ${indicators.sma20?.toFixed(2) ?? "N/A"}
- **SMA(50)**: ${indicators.sma50?.toFixed(2) ?? "N/A"}
- **SMA(200)**: ${indicators.sma200?.toFixed(2) ?? "N/A"}
- **EMA(12)**: ${indicators.ema12?.toFixed(2) ?? "N/A"}
- **EMA(26)**: ${indicators.ema26?.toFixed(2) ?? "N/A"}
- **Bollinger Bands**: ${indicators.bollingerBands ? `Upper=${indicators.bollingerBands.upper.toFixed(2)}, Mid=${indicators.bollingerBands.middle.toFixed(2)}, Lower=${indicators.bollingerBands.lower.toFixed(2)}` : "N/A"}
- **ATR(14)**: ${indicators.atr?.toFixed(2) ?? "N/A"}

## Generated Signals
${signalList || "No signals generated yet."}

## Instructions
Respond with a JSON object containing:
- "direction": "bullish" | "bearish" | "neutral"
- "confidence": 0.0 to 1.0
- "reasoning": 1-2 short sentences, max 250 characters
- "risks": Array of key risk factors — at most 4, each under 80 characters
- "keyLevels": { "support": number or null, "resistance": number or null }
- "timeframe": Your recommended timeframe for this analysis (e.g., "short-term (1-3 days)")
- "actionSuggestion": One sentence (e.g., "Hold — wait for RSI to cool before entering")

Be direct and honest. Do not hedge excessively. If the data clearly points one direction, say so.
Keep the entire response brief — no filler.
Respond ONLY with the JSON object, no markdown formatting.`;
}

export function buildCritiquePrompt(
  tradeDescription: string,
  technicals: TechnicalSummary | null
): string {
  let techContext = "";
  if (technicals) {
    techContext = `

## Current Technical Data
- Price: $${technicals.price.toFixed(2)}
- RSI: ${technicals.indicators.rsi?.toFixed(1) ?? "N/A"}
- Overall signal: ${technicals.overallDirection} (strength: ${(technicals.overallStrength * 100).toFixed(0)}%)
- Active signals: ${technicals.signals.map((s) => `${s.name} (${s.direction})`).join(", ") || "none"}`;
  }

  return `You are a brutally honest trading risk advisor. Your job is to protect the user from bad decisions. Do NOT sugarcoat or be polite — be direct and blunt about risks.

## Proposed Trade
${tradeDescription}
${techContext}

## What to Evaluate
Look for these common mistakes:
1. **FOMO buying** — buying after a large run-up, chasing pumps
2. **Concentration risk** — putting too much into one position
3. **Catching falling knives** — buying into clear downtrends without confirmed support
4. **Ignoring technicals** — buying into overbought RSI, wrong side of moving averages
5. **Poor position sizing** — risking too much capital on a single trade
6. **Revenge trading** — increasing size after losses to "make it back"
7. **Confirmation bias** — cherry-picking bullish signals while ignoring bearish ones
8. **No exit strategy** — entering without stop-loss or target levels

## Response Format
Respond with a JSON object:
- "overallAssessment": "good" | "risky" | "bad"
- "score": 0-10 (10 = excellent trade, 0 = terrible)
- "issues": Array of { "type": string, "severity": "low"|"medium"|"high"|"critical", "description": string } — at most 4 issues, each description under 100 characters
- "recommendation": Your blunt, honest recommendation (1-2 sentences)

If it's a bad trade, say so clearly. The user wants honesty, not encouragement.
Keep the entire response brief — no filler.
Respond ONLY with the JSON object, no markdown formatting.`;
}
