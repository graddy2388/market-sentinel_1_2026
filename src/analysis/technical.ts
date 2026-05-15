import { RSI, MACD, SMA, EMA, BollingerBands, ATR } from "trading-signals";
import type { Candle } from "../data/types.js";
import type { IndicatorResult } from "./types.js";

export function computeIndicators(candles: Candle[]): IndicatorResult {
  const result: IndicatorResult = {
    rsi: null,
    macd: null,
    sma20: null,
    sma50: null,
    sma200: null,
    ema12: null,
    ema26: null,
    bollingerBands: null,
    atr: null,
  };

  if (candles.length < 2) return result;

  const rsi = new RSI(14);
  const macd = new MACD({ indicator: EMA, longInterval: 26, shortInterval: 12, signalInterval: 9 });
  const sma20 = new SMA(20);
  const sma50 = new SMA(50);
  const sma200 = new SMA(200);
  const ema12 = new EMA(12);
  const ema26 = new EMA(26);
  const bb = new BollingerBands(20, 2);
  const atr = new ATR(14);

  for (const candle of candles) {
    try { rsi.update(candle.close, false); } catch { /* not enough data */ }
    try { macd.update(candle.close, false); } catch { /* not enough data */ }
    try { sma20.update(candle.close, false); } catch { /* not enough data */ }
    try { sma50.update(candle.close, false); } catch { /* not enough data */ }
    try { sma200.update(candle.close, false); } catch { /* not enough data */ }
    try { ema12.update(candle.close, false); } catch { /* not enough data */ }
    try { ema26.update(candle.close, false); } catch { /* not enough data */ }
    try { bb.update(candle.close, false); } catch { /* not enough data */ }
    try {
      atr.update({ high: candle.high, low: candle.low, close: candle.close }, false);
    } catch { /* not enough data */ }
  }

  try { result.rsi = Number(rsi.getResult()); } catch { /* not ready */ }
  try {
    const m = macd.getResult();
    if (m) {
      result.macd = {
        macd: Number(m.macd),
        signal: Number(m.signal),
        histogram: Number(m.histogram),
      };
    }
  } catch { /* not ready */ }
  try { result.sma20 = Number(sma20.getResult()); } catch { /* not ready */ }
  try { result.sma50 = Number(sma50.getResult()); } catch { /* not ready */ }
  try { result.sma200 = Number(sma200.getResult()); } catch { /* not ready */ }
  try { result.ema12 = Number(ema12.getResult()); } catch { /* not ready */ }
  try { result.ema26 = Number(ema26.getResult()); } catch { /* not ready */ }
  try {
    const b = bb.getResult();
    if (b) {
      result.bollingerBands = {
        upper: Number(b.upper),
        middle: Number(b.middle),
        lower: Number(b.lower),
      };
    }
  } catch { /* not ready */ }
  try { result.atr = Number(atr.getResult()); } catch { /* not ready */ }

  return result;
}
