import { EventEmitter } from "events";
import { BinanceDataSource } from "./binance.js";
import type { Tick, Candle, MarketType, CandleInterval } from "./types.js";

interface LatestData {
  tick: Tick;
  candles: Map<CandleInterval, Candle[]>;
}

export class DataManager extends EventEmitter {
  private binance: BinanceDataSource | null = null;
  private latest = new Map<string, LatestData>();
  private cryptoSymbols: string[];

  constructor(cryptoSymbols: string[] = ["BTC", "ETH"]) {
    super();
    this.cryptoSymbols = cryptoSymbols;
  }

  start(): void {
    this.binance = new BinanceDataSource(this.cryptoSymbols);

    this.binance.on("tick", (tick: Tick) => {
      this.updateLatestTick(tick);
      this.emit("tick", tick);
    });

    this.binance.on("candle", (candle: Candle) => {
      this.storeCandle(candle);
      this.emit("candle", candle);
    });

    this.binance.on("connected", (source: string) => {
      this.emit("connected", source);
    });

    this.binance.on("disconnected", (source: string) => {
      this.emit("disconnected", source);
    });

    this.binance.on("error", (err: Error, source: string) => {
      this.emit("error", err, source);
    });

    this.binance.connect();
  }

  stop(): void {
    this.binance?.disconnect();
  }

  getLatestPrice(symbol: string): number | null {
    return this.latest.get(symbol.toUpperCase())?.tick.price ?? null;
  }

  getLatestTick(symbol: string): Tick | null {
    return this.latest.get(symbol.toUpperCase())?.tick ?? null;
  }

  getCandles(symbol: string, interval: CandleInterval): Candle[] {
    return (
      this.latest.get(symbol.toUpperCase())?.candles.get(interval) ?? []
    );
  }

  getTrackedSymbols(): string[] {
    return Array.from(this.latest.keys());
  }

  private updateLatestTick(tick: Tick): void {
    const key = tick.symbol.toUpperCase();
    if (!this.latest.has(key)) {
      this.latest.set(key, {
        tick,
        candles: new Map(),
      });
    } else {
      this.latest.get(key)!.tick = tick;
    }
  }

  private storeCandle(candle: Candle): void {
    const key = candle.symbol.toUpperCase();
    if (!this.latest.has(key)) {
      this.latest.set(key, {
        tick: {
          symbol: candle.symbol,
          market: candle.market,
          price: candle.close,
          volume: candle.volume,
          timestamp: candle.timestamp,
        },
        candles: new Map(),
      });
    }

    const data = this.latest.get(key)!;
    if (!data.candles.has(candle.interval)) {
      data.candles.set(candle.interval, []);
    }

    const candles = data.candles.get(candle.interval)!;
    candles.push(candle);
    if (candles.length > 200) {
      candles.splice(0, candles.length - 200);
    }
  }
}
