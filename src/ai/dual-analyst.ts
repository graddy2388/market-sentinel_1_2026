import { openaiAnalyze, openaiCritique } from "./openai.js";
import { claudeAnalyze, claudeCritique } from "./claude.js";
import { hasOpenAI, hasClaude } from "../config.js";
import { buildAnalysisPrompt, buildCritiquePrompt } from "./prompts.js";
import type { TechnicalSummary } from "../analysis/types.js";
import type {
  AnalysisResponse,
  CritiqueResponse,
  DualAnalysisResult,
} from "./types.js";

function findDisagreements(
  a: AnalysisResponse | null,
  b: AnalysisResponse | null
): string[] {
  if (!a || !b) return [];
  const disagreements: string[] = [];

  if (a.direction !== b.direction) {
    disagreements.push(
      `Direction: OpenAI says ${a.direction}, Claude says ${b.direction}`
    );
  }

  const confDelta = Math.abs(a.confidence - b.confidence);
  if (confDelta > 0.3) {
    disagreements.push(
      `Confidence gap: OpenAI ${(a.confidence * 100).toFixed(0)}% vs Claude ${(b.confidence * 100).toFixed(0)}%`
    );
  }

  const aRisks = new Set(a.risks.map((r) => r.toLowerCase()));
  const bRisks = new Set(b.risks.map((r) => r.toLowerCase()));
  for (const risk of bRisks) {
    let found = false;
    for (const aRisk of aRisks) {
      if (aRisk.includes(risk.slice(0, 20)) || risk.includes(aRisk.slice(0, 20))) {
        found = true;
        break;
      }
    }
    if (!found) {
      disagreements.push(`Claude flagged a risk OpenAI missed: "${risk}"`);
    }
  }

  return disagreements;
}

function buildConsensus(
  a: AnalysisResponse | null,
  b: AnalysisResponse | null
): string | null {
  if (!a && !b) return null;
  if (!a) return `Only Claude available: ${b!.direction} (${(b!.confidence * 100).toFixed(0)}% confidence)`;
  if (!b) return `Only OpenAI available: ${a.direction} (${(a.confidence * 100).toFixed(0)}% confidence)`;

  if (a.direction === b.direction) {
    const avgConf = (a.confidence + b.confidence) / 2;
    return `Both models agree: ${a.direction} (avg ${(avgConf * 100).toFixed(0)}% confidence)`;
  }

  return null;
}

export async function dualAnalyze(
  symbol: string,
  technicals: TechnicalSummary
): Promise<DualAnalysisResult> {
  const prompt = buildAnalysisPrompt(symbol, technicals);

  const promises: [
    Promise<AnalysisResponse | null>,
    Promise<AnalysisResponse | null>,
  ] = [
    hasOpenAI()
      ? openaiAnalyze(prompt).catch((err) => {
          console.error(`OpenAI analysis failed: ${err.message}`);
          return null;
        })
      : Promise.resolve(null),
    hasClaude()
      ? claudeAnalyze(prompt).catch((err) => {
          console.error(`Claude analysis failed: ${err.message}`);
          return null;
        })
      : Promise.resolve(null),
  ];

  const [openaiResult, claudeResult] = await Promise.allSettled(promises).then(
    (results) =>
      results.map((r) => (r.status === "fulfilled" ? r.value : null)) as [
        AnalysisResponse | null,
        AnalysisResponse | null,
      ]
  );

  return {
    symbol,
    timestamp: Date.now(),
    openai: openaiResult,
    claude: claudeResult,
    disagreements: findDisagreements(openaiResult, claudeResult),
    consensus: buildConsensus(openaiResult, claudeResult),
  };
}

export async function dualCritique(
  tradeDescription: string,
  technicals: TechnicalSummary | null
): Promise<{
  openai: CritiqueResponse | null;
  claude: CritiqueResponse | null;
}> {
  const prompt = buildCritiquePrompt(tradeDescription, technicals);

  const [openaiResult, claudeResult] = await Promise.allSettled([
    hasOpenAI()
      ? openaiCritique(prompt).catch((err) => {
          console.error(`OpenAI critique failed: ${err.message}`);
          return null;
        })
      : Promise.resolve(null),
    hasClaude()
      ? claudeCritique(prompt).catch((err) => {
          console.error(`Claude critique failed: ${err.message}`);
          return null;
        })
      : Promise.resolve(null),
  ]).then(
    (results) =>
      results.map((r) => (r.status === "fulfilled" ? r.value : null)) as [
        CritiqueResponse | null,
        CritiqueResponse | null,
      ]
  );

  return { openai: openaiResult, claude: claudeResult };
}
