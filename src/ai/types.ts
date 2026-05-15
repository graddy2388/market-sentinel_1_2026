import { z } from "zod";

export const analysisResponseSchema = z.object({
  direction: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  risks: z.array(z.string()),
  keyLevels: z.object({
    support: z.number().optional(),
    resistance: z.number().optional(),
  }),
  timeframe: z.string(),
  actionSuggestion: z.string(),
});

export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;

export const critiqueResponseSchema = z.object({
  overallAssessment: z.enum(["good", "risky", "bad"]),
  score: z.number().min(0).max(10),
  issues: z.array(
    z.object({
      type: z.string(),
      severity: z.enum(["low", "medium", "high", "critical"]),
      description: z.string(),
    })
  ),
  recommendation: z.string(),
});

export type CritiqueResponse = z.infer<typeof critiqueResponseSchema>;

export interface DualAnalysisResult {
  symbol: string;
  timestamp: number;
  openai: AnalysisResponse | null;
  claude: AnalysisResponse | null;
  disagreements: string[];
  consensus: string | null;
}

export interface ModelVote {
  model: string;
  analysis: AnalysisResponse;
}

export interface ModelCritique {
  model: string;
  critique: CritiqueResponse;
}

export interface ModelError {
  model: string;
  error: string;
}

export interface CouncilAnalysisResult {
  symbol: string;
  timestamp: number;
  votes: ModelVote[];
  failed: ModelError[];
  majorityDirection: "bullish" | "bearish" | "neutral";
  directionBreakdown: { bullish: number; bearish: number; neutral: number };
  avgConfidence: number;
  disagreements: string[];
  consensus: string | null;
}

export interface CouncilCritiqueResult {
  opinions: ModelCritique[];
  failed: ModelError[];
  avgScore: number;
  majorityAssessment: "good" | "risky" | "bad";
}
