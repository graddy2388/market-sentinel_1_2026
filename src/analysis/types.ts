export interface IndicatorResult {
  rsi: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema12: number | null;
  ema26: number | null;
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
  } | null;
  atr: number | null;
}

export type SignalDirection = "bullish" | "bearish" | "neutral";

export interface Signal {
  name: string;
  direction: SignalDirection;
  strength: number; // 0-1
  description: string;
}

export interface TechnicalSummary {
  symbol: string;
  price: number;
  indicators: IndicatorResult;
  signals: Signal[];
  overallDirection: SignalDirection;
  overallStrength: number;
  timestamp: number;
}
