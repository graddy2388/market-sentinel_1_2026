import WebSocket from "ws";
import { EventEmitter } from "events";
import type { Tick, Candle, CandleInterval } from "./types.js";

// ---------------------------------------------------------------------------
// Host resolution — binance.com geo-blocks US IPs (HTTP 451), binance.us
// serves the identical API shape for US users. Probe once per process, prefer
// an explicit BINANCE_BASE_URL override, and cache the working host. A failed
// probe is re-tried after a cooldown so a transient outage isn't permanent.
// ---------------------------------------------------------------------------

const DEFAULT_REST_HOSTS = ["https://api.binance.com", "https://api.binance.us"];
const REST_HOSTS = process.env.BINANCE_BASE_URL
  ? [process.env.BINANCE_BASE_URL.replace(/\/$/, ""), ...DEFAULT_REST_HOSTS]
  : DEFAULT_REST_HOSTS;

const PROBE_TIMEOUT_MS = 4_000;
const FAILED_PROBE_COOLDOWN_MS = 5 * 60_000; // don't re-probe every call when all hosts are down

let resolvedHost: string | null = null;
let lastFailedProbeAt = 0;
let inFlightProbe: Promise<string | null> | null = null;

/**
 * Resolve the first reachable Binance REST host, caching the result for the
 * process lifetime. Concurrent callers share one in-flight probe. Returns null
 * when no host is reachable (callers fall back to CoinGecko).
 */
export function resolveBinanceHost(): Promise<string | null> {
  if (resolvedHost) return Promise.resolve(resolvedHost);
  if (Date.now() - lastFailedProbeAt < FAILED_PROBE_COOLDOWN_MS) return Promise.resolve(null);
  if (inFlightProbe) return inFlightProbe;

  inFlightProbe = (async () => {
    try {
      for (const host of REST_HOSTS) {
        try {
          const res = await fetch(`${host}/api/v3/ping`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          if (res.ok) {
            resolvedHost = host;
            console.log(`[Binance] Using ${host}`);
            return host;
          }
          // Non-OK (e.g. 451 geo-block) — try the next host.
        } catch {
          // Network error / timeout — try the next host.
        }
      }
      lastFailedProbeAt = Date.now();
      console.warn("[Binance] No reachable Binance host — crypto data will use CoinGecko fallback");
      return null;
    } finally {
      inFlightProbe = null;
    }
  })();

  return inFlightProbe;
}

/** Test helper: reset cached host resolution. */
export function _resetBinanceHost(): void {
  resolvedHost = null;
  lastFailedProbeAt = 0;
  inFlightProbe = null;
}

/** Map a REST host to its matching combined-stream WebSocket base. */
function wsBaseFor(host: string): string {
  // Combined streams must use /stream?streams= (frames wrapped as {stream,data}).
  return host.includes("binance.us")
    ? "wss://stream.binance.us:9443/stream?streams="
    : "wss://stream.binance.com:9443/stream?streams=";
}

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
    void this.connectAsync();
  }

  private async connectAsync(): Promise<void> {
    // Resolve the reachable host first (binance.com is geo-blocked in the US;
    // binance.us serves the same WS scheme). If nothing is reachable, retry
    // later instead of hammering a blocked endpoint.
    const host = await resolveBinanceHost();
    if (!host) {
      this.emit("error", new Error("No reachable Binance host"), "binance");
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 60_000);
      }
      return;
    }

    const streams = this.symbols.flatMap((s) => [
      `${s}usdt@ticker`,
      `${s}usdt@kline_1m`,
    ]);
    const url = `${wsBaseFor(host)}${streams.join("/")}`;

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.emit("connected", "binance");
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const parsed = JSON.parse(raw.toString());
        // Combined-stream frames wrap the payload as { stream, data };
        // fall back to the raw object for single-stream frames.
        const data = parsed.data ?? parsed;
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
  const host = await resolveBinanceHost();
  if (!host) return null;
  const pair = `${symbol.toUpperCase()}USDT`;
  const url = `${host}/api/v3/ticker/price?symbol=${pair}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
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
  quoteVolume: number;
  high: number;
  low: number;
} | null> {
  const host = await resolveBinanceHost();
  if (!host) return null;
  const pair = `${symbol.toUpperCase()}USDT`;
  const url = `${host}/api/v3/ticker/24hr?symbol=${pair}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      lastPrice: string;
      priceChange: string;
      priceChangePercent: string;
      volume: string;
      quoteVolume: string;
      highPrice: string;
      lowPrice: string;
    };
    return {
      price: parseFloat(data.lastPrice),
      change: parseFloat(data.priceChange),
      changePercent: parseFloat(data.priceChangePercent),
      // `volume` is in base units (e.g. BTC); `quoteVolume` is in USDT —
      // callers displaying "$" volume want quoteVolume.
      volume: parseFloat(data.volume),
      quoteVolume: parseFloat(data.quoteVolume),
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
  const host = await resolveBinanceHost();
  if (!host) return [];
  const pair = `${symbol.toUpperCase()}USDT`;
  const url = `${host}/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
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
