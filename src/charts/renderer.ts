import sharp from "sharp";
import type { Candle } from "../data/types.js";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const WIDTH = 800;
const HEIGHT = 520;
const PAD = { top: 40, right: 70, bottom: 25, left: 10 };
const RSI_H = 100;
const GAP = 20;
const CHART_H = HEIGHT - PAD.top - PAD.bottom - RSI_H - GAP;
const CHART_TOP = PAD.top;
const RSI_TOP = CHART_TOP + CHART_H + GAP;

// ---------------------------------------------------------------------------
// Colors (dark trading terminal theme)
// ---------------------------------------------------------------------------

const C = {
  bg: "#0d1117",
  panel: "#161b22",
  grid: "#21262d",
  gridLight: "#30363d",
  text: "#8b949e",
  textBright: "#c9d1d9",
  green: "#3fb950",
  red: "#f85149",
  greenFill: "#238636",
  redFill: "#da3633",
  sma20: "#f0883e",
  sma50: "#58a6ff",
  bollingerFill: "rgba(88,166,255,0.08)",
  rsiLine: "#bc8cff",
  rsiZone: "rgba(188,140,255,0.12)",
};

// ---------------------------------------------------------------------------
// Indicator math (self-contained, no external deps)
// ---------------------------------------------------------------------------

function computeSMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

function computeRSI(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")} ${d.getHours().toString().padStart(2, "0")}:00`;
}

// ---------------------------------------------------------------------------
// Chart generation
// ---------------------------------------------------------------------------

export async function renderChart(
  candles: Candle[],
  symbol: string,
  currentPrice?: number,
  change24h?: number,
): Promise<Buffer> {
  const n = candles.length;
  if (n < 5) throw new Error("Need at least 5 candles to render");

  const closes = candles.map((c) => c.close);

  // Indicators
  const sma20 = computeSMA(closes, Math.min(20, Math.floor(n / 2)));
  const sma50 = n >= 50 ? computeSMA(closes, 50) : null;
  const rsi = computeRSI(closes, 14);

  // Price range
  const allPrices = candles.flatMap((c) => [c.high, c.low]);
  const smaVals = [...sma20, ...(sma50 ?? [])].filter((v): v is number => v !== null);
  if (smaVals.length) allPrices.push(...smaVals);
  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);
  const range = maxP - minP || 1;
  const padP = range * 0.06;
  const lo = minP - padP;
  const hi = maxP + padP;

  // Scale helpers
  const chartW = WIDTH - PAD.left - PAD.right;
  const candleStep = chartW / n;
  const candleW = Math.max(1, candleStep * 0.65);
  const x = (i: number) => PAD.left + candleStep * i + candleStep / 2;
  const yPrice = (p: number) => CHART_TOP + CHART_H - ((p - lo) / (hi - lo)) * CHART_H;
  const yRsi = (v: number) => RSI_TOP + RSI_H - (v / 100) * RSI_H;

  // Build SVG
  const lines: string[] = [];
  const add = (s: string) => lines.push(s);

  add(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">`);
  add(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${C.bg}"/>`);

  // Panel backgrounds
  add(`<rect x="${PAD.left}" y="${CHART_TOP}" width="${chartW}" height="${CHART_H}" fill="${C.panel}" rx="4"/>`);
  add(`<rect x="${PAD.left}" y="${RSI_TOP}" width="${chartW}" height="${RSI_H}" fill="${C.panel}" rx="4"/>`);

  // --- Header ---
  const price = currentPrice ?? candles[n - 1].close;
  const changeStr = change24h != null ? ` (${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%)` : "";
  const headerColor = change24h != null ? (change24h >= 0 ? C.green : C.red) : C.textBright;
  add(`<text x="${PAD.left + 8}" y="24" fill="${C.textBright}" font-family="monospace" font-size="16" font-weight="bold">${esc(symbol)}</text>`);
  add(`<text x="${PAD.left + 8 + symbol.length * 10 + 12}" y="24" fill="${headerColor}" font-family="monospace" font-size="16">$${formatPrice(price)}${esc(changeStr)}</text>`);
  add(`<text x="${WIDTH - PAD.right - 4}" y="24" fill="${C.text}" font-family="monospace" font-size="11" text-anchor="end">${esc(candles[0].interval)} candles</text>`);

  // --- Price grid lines (5 levels) ---
  const gridLevels = 5;
  for (let i = 0; i <= gridLevels; i++) {
    const p = lo + (hi - lo) * (i / gridLevels);
    const py = yPrice(p);
    add(`<line x1="${PAD.left}" y1="${py}" x2="${WIDTH - PAD.right}" y2="${py}" stroke="${C.grid}" stroke-dasharray="2,4"/>`);
    add(`<text x="${WIDTH - PAD.right + 6}" y="${py + 4}" fill="${C.text}" font-family="monospace" font-size="10">${formatPrice(p)}</text>`);
  }

  // --- Time labels (every ~20% of candles) ---
  const timeStep = Math.max(1, Math.floor(n / 5));
  for (let i = 0; i < n; i += timeStep) {
    const cx = x(i);
    add(`<line x1="${cx}" y1="${CHART_TOP}" x2="${cx}" y2="${CHART_TOP + CHART_H}" stroke="${C.grid}" stroke-dasharray="2,4"/>`);
    add(`<text x="${cx}" y="${CHART_TOP + CHART_H + 14}" fill="${C.text}" font-family="monospace" font-size="9" text-anchor="middle">${formatTime(candles[i].timestamp)}</text>`);
  }

  // --- SMA lines ---
  const drawLine = (data: (number | null)[], color: string, label: string) => {
    const points: string[] = [];
    for (let i = 0; i < n; i++) {
      if (data[i] != null) points.push(`${x(i).toFixed(1)},${yPrice(data[i]!).toFixed(1)}`);
    }
    if (points.length > 1) {
      add(`<polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`);
      // Label at last point
      let last: number | null = null;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] != null) { last = data[i]; break; }
      }
      if (last != null) {
        const ly = yPrice(last);
        add(`<text x="${WIDTH - PAD.right + 6}" y="${ly + 3}" fill="${color}" font-family="monospace" font-size="9">${label}</text>`);
      }
    }
  };

  drawLine(sma20, C.sma20, "SMA20");
  if (sma50) drawLine(sma50, C.sma50, "SMA50");

  // --- Candlesticks ---
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const cx = x(i);
    const isGreen = c.close >= c.open;
    const color = isGreen ? C.green : C.red;
    const fill = isGreen ? C.greenFill : C.redFill;

    // Wick
    add(`<line x1="${cx}" y1="${yPrice(c.high)}" x2="${cx}" y2="${yPrice(c.low)}" stroke="${color}" stroke-width="1"/>`);

    // Body
    const bodyTop = yPrice(Math.max(c.open, c.close));
    const bodyBot = yPrice(Math.min(c.open, c.close));
    const bodyH = Math.max(1, bodyBot - bodyTop);
    add(`<rect x="${cx - candleW / 2}" y="${bodyTop}" width="${candleW}" height="${bodyH}" fill="${fill}" stroke="${color}" stroke-width="0.5" rx="0.5"/>`);
  }

  // --- Current price line ---
  const cpY = yPrice(price);
  add(`<line x1="${PAD.left}" y1="${cpY}" x2="${WIDTH - PAD.right}" y2="${cpY}" stroke="${headerColor}" stroke-width="0.8" stroke-dasharray="4,3"/>`);

  // --- RSI subplot ---
  // Grid and labels
  add(`<line x1="${PAD.left}" y1="${yRsi(70)}" x2="${WIDTH - PAD.right}" y2="${yRsi(70)}" stroke="${C.red}" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.5"/>`);
  add(`<line x1="${PAD.left}" y1="${yRsi(30)}" x2="${WIDTH - PAD.right}" y2="${yRsi(30)}" stroke="${C.green}" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.5"/>`);
  add(`<line x1="${PAD.left}" y1="${yRsi(50)}" x2="${WIDTH - PAD.right}" y2="${yRsi(50)}" stroke="${C.grid}" stroke-width="0.5" stroke-dasharray="2,4"/>`);
  add(`<text x="${WIDTH - PAD.right + 6}" y="${yRsi(70) + 3}" fill="${C.red}" font-family="monospace" font-size="9" opacity="0.7">70</text>`);
  add(`<text x="${WIDTH - PAD.right + 6}" y="${yRsi(30) + 3}" fill="${C.green}" font-family="monospace" font-size="9" opacity="0.7">30</text>`);
  add(`<text x="${PAD.left + 4}" y="${RSI_TOP + 12}" fill="${C.text}" font-family="monospace" font-size="10">RSI(14)</text>`);

  // Overbought/oversold zones
  add(`<rect x="${PAD.left}" y="${yRsi(100)}" width="${chartW}" height="${yRsi(70) - yRsi(100)}" fill="${C.red}" opacity="0.06"/>`);
  add(`<rect x="${PAD.left}" y="${yRsi(30)}" width="${chartW}" height="${yRsi(0) - yRsi(30)}" fill="${C.green}" opacity="0.06"/>`);

  // RSI line
  const rsiPoints: string[] = [];
  for (let i = 0; i < n; i++) {
    if (rsi[i] != null) rsiPoints.push(`${x(i).toFixed(1)},${yRsi(rsi[i]!).toFixed(1)}`);
  }
  if (rsiPoints.length > 1) {
    add(`<polyline points="${rsiPoints.join(" ")}" fill="none" stroke="${C.rsiLine}" stroke-width="1.5" stroke-linecap="round"/>`);
  }

  // RSI current value label
  let currentRsi: number | null = null;
  for (let i = rsi.length - 1; i >= 0; i--) {
    if (rsi[i] != null) { currentRsi = rsi[i]; break; }
  }
  if (currentRsi != null) {
    const rsiColor = currentRsi > 70 ? C.red : currentRsi < 30 ? C.green : C.rsiLine;
    add(`<text x="${WIDTH - PAD.right + 6}" y="${yRsi(currentRsi) + 3}" fill="${rsiColor}" font-family="monospace" font-size="10" font-weight="bold">${currentRsi.toFixed(1)}</text>`);
  }

  // --- Legend ---
  const legendY = CHART_TOP + 14;
  add(`<rect x="${PAD.left + 6}" y="${legendY - 9}" width="10" height="3" fill="${C.sma20}" rx="1"/>`);
  add(`<text x="${PAD.left + 20}" y="${legendY}" fill="${C.sma20}" font-family="monospace" font-size="9">SMA20</text>`);
  if (sma50) {
    add(`<rect x="${PAD.left + 66}" y="${legendY - 9}" width="10" height="3" fill="${C.sma50}" rx="1"/>`);
    add(`<text x="${PAD.left + 80}" y="${legendY}" fill="${C.sma50}" font-family="monospace" font-size="9">SMA50</text>`);
  }

  add("</svg>");

  // Convert SVG to PNG
  const svgBuffer = Buffer.from(lines.join("\n"));
  return sharp(svgBuffer).png().toBuffer();
}
