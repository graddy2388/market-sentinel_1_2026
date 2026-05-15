import WebSocket from "ws";
import { EventEmitter } from "events";
import type { Tick, Candle, CandleInterval } from "./types.js";

const BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws";

interface BinanceTickerMsg {
  e: "24hrTicker";
  s: string;
  c: string; // close price
  v: string; // volume
  h: string; // high
  l: string; // low
  o: string; // open
  E: number; // event time
}

interface BinanceKlineMsg {
  e: "kline";
  s: string;
  k: {
    t: number; // start time
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    i: string; // interval
    x: boolean; // is closed
  };
}

export class BinanceDataSource extends EventEmitter {
  private ws: WebSocket | null = null;
  private symbols: string[];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  constructor(symbols: string[]) {
    super();
    this.symbols = symbols.map((s) => s.toLowerCase());
  }

  connect(): void {
    const streams = this.symbols.flatMap((s) => [
      `${s}usdt@ticker`,
      `${s}usdt@kline_1m`,
    ]);
    const url = `${BINANCE_WS_BASE}/${streams.join("/")}`;

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.emit("connected", "binance");
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.e === "24hrTicker") {
          this.handleTicker(data as BinanceTickerMsg);
        } else if (data.e === "kline") {
          this.handleKline(data as BinanceKlineMsg);
        }
      } catch (err) {
        this.emit("error", err as Error, "binance");
      }
    });

    this.ws.on("close", () => {
      this.emit("disconnected", "binance");
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    this.ws.on("error", (err: Error) => {
      this.emit("error", err, "binance");
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  private handleTicker(msg: BinanceTickerMsg): void {
    const symbol = msg.s.replace("USDT", "");
    const tick: Tick = {
      symbol,
      market: "crypto",
      price: parseFloat(msg.c),
      volume: parseFloat(msg.v),
      timestamp: msg.E,
    };
    this.emit("tick", tick);
  }

  private handleKline(msg: BinanceKlineMsg): void {
    if (!msg.k.x) return; // only emit closed candles

    const symbol = msg.s.replace("USDT", "");
    const candle: Candle = {
      symbol,
      market: "crypto",
      open: parseFloat(msg.k.o),
      high: parseFloat(msg.k.h),
      low: parseFloat(msg.k.l),
      close: parseFloat(msg.k.c),
      volume: parseFloat(msg.k.v),
      timestamp: msg.k.t,
      interval: msg.k.i as CandleInterval,
    };
    this.emit("candle", candle);
  }
}

export async function fetchBinancePrice(symbol: string): Promise<Tick | null> {
  const pair = `${symbol.toUpperCase()}USDT`;
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { symbol: string; price: string };
    return {
      symbol: symbol.toUpperCase(),
      market: "crypto",
      price: parseFloat(data.price),
      volume: 0,
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function fetchBinance24hr(
  symbol: string
): Promise<{
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
} | null> {
  const pair = `${symbol.toUpperCase()}USDT`;
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      lastPrice: string;
      priceChange: string;
      priceChangePercent: string;
      volume: string;
      highPrice: string;
      lowPrice: string;
    };
    return {
      price: parseFloat(data.lastPrice),
      change: parseFloat(data.priceChange),
      changePercent: parseFloat(data.priceChangePercent),
      volume: parseFloat(data.volume),
      high: parseFloat(data.highPrice),
      low: parseFloat(data.lowPrice),
    };
  } catch {
    return null;
  }
}

export async function fetchBinanceKlines(
  symbol: string,
  interval: CandleInterval = "1h",
  limit = 100
): Promise<Candle[]> {
  const pair = `${symbol.toUpperCase()}USDT`;
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as (string | number)[][];
    return data.map((k) => ({
      symbol: symbol.toUpperCase(),
      market: "crypto" as const,
      timestamp: k[0] as number,
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
      interval,
    }));
  } catch {
    return [];
  }
}
