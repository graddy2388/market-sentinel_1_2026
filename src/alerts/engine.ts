import { eq } from "drizzle-orm";
import { getDb, saveDb } from "../state/db.js";
import { alerts } from "../state/schema.js";
import { fetchPrice, fetch24hr, fetchCandles } from "../data/coingecko.js";
import { analyzeTechnicals } from "../analysis/signals.js";

export interface TriggeredAlert {
  id: number;
  symbol: string;
  conditionType: string;
  threshold: number;
  createdAt: string;
  triggeredAt: string;
}

type AlertCallback = (alert: TriggeredAlert, currentPrice: number) => void;

const POLL_INTERVAL_MS = 30_000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

async function evaluateAlerts(onAlert: AlertCallback): Promise<void> {
  const db = await getDb();
  const activeAlerts = db.select().from(alerts).where(eq(alerts.active, true)).all();

  if (activeAlerts.length === 0) return;

  // Group alerts by symbol to avoid duplicate fetches
  const bySymbol = new Map<string, typeof activeAlerts>();
  for (const alert of activeAlerts) {
    const sym = alert.symbol.toUpperCase();
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym)!.push(alert);
  }

  for (const [symbol, symbolAlerts] of bySymbol) {
    let currentPrice: number | null = null;
    let changePercent24h: number | null = null;
    let rsi: number | null = null;

    // Check which data we need
    const needsPrice = symbolAlerts.some(
      (a) =>
        a.conditionType === "price_above" ||
        a.conditionType === "price_below"
    );
    const needsPctChange = symbolAlerts.some(
      (a) => a.conditionType === "pct_change"
    );
    const needsRsi = symbolAlerts.some(
      (a) => a.conditionType === "rsi_above" || a.conditionType === "rsi_below"
    );

    // For pct_change we need the full 24hr data; for price alerts a simple price fetch suffices
    if (needsPctChange) {
      try {
        const overview = await fetch24hr(symbol);
        if (overview) {
          currentPrice = overview.price;
          changePercent24h = overview.changePercent24h;
        }
      } catch (err) {
        console.error(`[Alert Engine] Failed to fetch 24hr for ${symbol}:`, err);
      }
    } else if (needsPrice) {
      try {
        const tick = await fetchPrice(symbol);
        if (tick) currentPrice = tick.price;
      } catch (err) {
        console.error(`[Alert Engine] Failed to fetch price for ${symbol}:`, err);
      }
    }

    if (needsRsi) {
      // If we don't have a price yet, get one from candles
      try {
        const candles = await fetchCandles(symbol, "1h", 100);
        if (candles.length >= 14) {
          const technicals = analyzeTechnicals(symbol, candles);
          if (technicals) {
            rsi = technicals.indicators.rsi;
            if (currentPrice === null) {
              currentPrice = technicals.price;
            }
          }
        }
      } catch (err) {
        console.error(`[Alert Engine] Failed to fetch candles for ${symbol}:`, err);
      }
    }

    for (const alert of symbolAlerts) {
      let triggered = false;

      switch (alert.conditionType) {
        case "price_above":
          if (currentPrice !== null && currentPrice >= alert.threshold) {
            triggered = true;
          }
          break;

        case "price_below":
          if (currentPrice !== null && currentPrice <= alert.threshold) {
            triggered = true;
          }
          break;

        case "pct_change":
          if (changePercent24h !== null && Math.abs(changePercent24h) >= alert.threshold) {
            triggered = true;
          }
          break;

        case "rsi_above":
          if (rsi !== null && rsi >= alert.threshold) {
            triggered = true;
          }
          break;

        case "rsi_below":
          if (rsi !== null && rsi <= alert.threshold) {
            triggered = true;
          }
          break;
      }

      if (triggered) {
        const now = new Date().toISOString();
        db.update(alerts)
          .set({ active: false, triggeredAt: now })
          .where(eq(alerts.id, alert.id))
          .run();
        saveDb();

        const triggeredAlert: TriggeredAlert = {
          id: alert.id,
          symbol: alert.symbol,
          conditionType: alert.conditionType,
          threshold: alert.threshold,
          createdAt: alert.createdAt,
          triggeredAt: now,
        };

        const price = currentPrice ?? 0;
        console.log(
          `[Alert Engine] TRIGGERED: ${alert.symbol} ${alert.conditionType} ${alert.threshold} (current: ${price})`
        );

        try {
          onAlert(triggeredAlert, price);
        } catch (err) {
          console.error("[Alert Engine] Callback error:", err);
        }
      }
    }
  }
}

export function startAlertEngine(onAlert: AlertCallback): void {
  if (running) {
    console.warn("[Alert Engine] Already running");
    return;
  }

  running = true;
  console.log("[Alert Engine] Started — polling every 30s");

  // Run immediately on start, then on interval
  evaluateAlerts(onAlert).catch((err) =>
    console.error("[Alert Engine] Evaluation error:", err)
  );

  intervalHandle = setInterval(() => {
    evaluateAlerts(onAlert).catch((err) =>
      console.error("[Alert Engine] Evaluation error:", err)
    );
  }, POLL_INTERVAL_MS);
}

export function stopAlertEngine(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  running = false;
  console.log("[Alert Engine] Stopped");
}
