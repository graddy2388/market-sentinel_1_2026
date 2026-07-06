export type MarketType = "crypto" | "stock" | "commodity";

export interface Tick {
  symbol: string;
  market: MarketType;
  price: number;
  volume: number;
  timestamp: number;
}

export interface Candle {
  symbol: string;
  market: MarketType;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
  interval: CandleInterval;
}

export type CandleInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export interface MarketOverview {
  symbol: string;
  market: MarketType;
  price: number;
  change24h: number;
  changePercent24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
}

export interface DataSourceEvents {
  tick: (tick: Tick) => void;
  candle: (candle: Candle) => void;
  error: (error: Error, source: string) => void;
  connected: (source: string) => void;
  disconnected: (source: string) => void;
}
