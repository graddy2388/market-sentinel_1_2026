import type { IndicatorResult, Signal, SignalDirection, TechnicalSummary } from "./types.js";
import type { Candle } from "../data/types.js";
import { computeIndicators } from "./technical.js";

export function generateSignals(indicators: IndicatorResult, price: number): Signal[] {
  const signals: Signal[] = [];

  if (indicators.rsi !== null) {
    if (indicators.rsi > 70) {
      signals.push({
        name: "RSI Overbought",
        direction: "bearish",
        strength: Math.min((indicators.rsi - 70) / 30, 1),
        description: `RSI at ${indicators.rsi.toFixed(1)} — overbought territory`,
      });
    } else if (indicators.rsi < 30) {
      signals.push({
        name: "RSI Oversold",
        direction: "bullish",
        strength: Math.min((30 - indicators.rsi) / 30, 1),
        description: `RSI at ${indicators.rsi.toFixed(1)} — oversold territory`,
      });
    }
  }

  if (indicators.macd) {
    const { histogram } = indicators.macd;
    if (histogram > 0) {
      signals.push({
        name: "MACD Bullish",
        direction: "bullish",
        strength: Math.min(Math.abs(histogram) / price * 100, 1),
        description: `MACD histogram positive (${histogram.toFixed(2)})`,
      });
    } else if (histogram < 0) {
      signals.push({
        name: "MACD Bearish",
        direction: "bearish",
        strength: Math.min(Math.abs(histogram) / price * 100, 1),
        description: `MACD histogram negative (${histogram.toFixed(2)})`,
      });
    }
  }

  if (indicators.sma20 !== null && indicators.sma50 !== null) {
    if (indicators.sma20 > indicators.sma50) {
      signals.push({
        name: "SMA Golden Cross (20/50)",
        direction: "bullish",
        strength: 0.6,
        description: "20 SMA above 50 SMA — short-term uptrend",
      });
    } else {
      signals.push({
        name: "SMA Death Cross (20/50)",
        direction: "bearish",
        strength: 0.6,
        description: "20 SMA below 50 SMA — short-term downtrend",
      });
    }
  }

  if (indicators.sma50 !== null && indicators.sma200 !== null) {
    if (indicators.sma50 > indicators.sma200) {
      signals.push({
        name: "Golden Cross (50/200)",
        direction: "bullish",
        strength: 0.8,
        description: "50 SMA above 200 SMA — major uptrend",
      });
    } else {
      signals.push({
        name: "Death Cross (50/200)",
        direction: "bearish",
        strength: 0.8,
        description: "50 SMA below 200 SMA — major downtrend",
      });
    }
  }

  if (indicators.bollingerBands) {
    const { upper, lower } = indicators.bollingerBands;
    if (price > upper) {
      signals.push({
        name: "Bollinger Upper Break",
        direction: "bearish",
        strength: 0.5,
        description: `Price above upper Bollinger Band ($${upper.toFixed(2)})`,
      });
    } else if (price < lower) {
      signals.push({
        name: "Bollinger Lower Break",
        direction: "bullish",
        strength: 0.5,
        description: `Price below lower Bollinger Band ($${lower.toFixed(2)})`,
      });
    }

    const bandwidth = (upper - lower) / indicators.bollingerBands.middle;
    if (bandwidth < 0.02) {
      signals.push({
        name: "Bollinger Squeeze",
        direction: "neutral",
        strength: 0.7,
        description: "Bollinger Bands squeezing — expect breakout",
      });
    }
  }

  if (indicators.sma200 !== null) {
    if (price > indicators.sma200) {
      signals.push({
        name: "Above 200 SMA",
        direction: "bullish",
        strength: 0.4,
        description: "Price above 200 SMA — long-term uptrend",
      });
    } else {
      signals.push({
        name: "Below 200 SMA",
        direction: "bearish",
        strength: 0.4,
        description: "Price below 200 SMA — long-term downtrend",
      });
    }
  }

  return signals;
}

export function summarizeSignals(signals: Signal[]): { direction: SignalDirection; strength: number } {
  if (signals.length === 0) return { direction: "neutral", strength: 0 };

  let bullishScore = 0;
  let bearishScore = 0;

  for (const signal of signals) {
    if (signal.direction === "bullish") bullishScore += signal.strength;
    else if (signal.direction === "bearish") bearishScore += signal.strength;
  }

  const total = bullishScore + bearishScore;
  if (total === 0) return { direction: "neutral", strength: 0 };

  const netScore = (bullishScore - bearishScore) / total;

  let direction: SignalDirection;
  if (netScore > 0.15) direction = "bullish";
  else if (netScore < -0.15) direction = "bearish";
  else direction = "neutral";

  return { direction, strength: Math.abs(netScore) };
}

export function analyzeTechnicals(symbol: string, candles: Candle[]): TechnicalSummary | null {
  if (candles.length < 14) return null;

  const currentPrice = candles[candles.length - 1].close;
  const indicators = computeIndicators(candles);
  const signals = generateSignals(indicators, currentPrice);
  const { direction, strength } = summarizeSignals(signals);

  return {
    symbol,
    price: currentPrice,
    indicators,
    signals,
    overallDirection: direction,
    overallStrength: strength,
    timestamp: Date.now(),
  };
}
