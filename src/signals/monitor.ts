/**
 * Reactive signal monitor.
 *
 * Subscribes to the live DataManager: forwards ticks to the event bus (for the
 * dashboard) and, on each closed candle, re-scores the symbol's graded signal.
 *
 * Cost control:
 * - The technical read is recomputed on every candle close (cheap, local).
 * - The AI council is refreshed at most once per COUNCIL_TTL_MS per symbol
 *   (lazy, on candle close); a fresher cached council is reused. A council that
 *   returns zero votes (all providers failed) is treated as absent.
 * - A per-symbol in-flight guard prevents overlapping evaluations.
 * - Pushes are gated by hasSignalChanged (call change or >0.15 conviction move).
 *
 * Candles come from the unified provider router — Binance first (with
 * .com→.us host failover), CoinGecko as last resort — so the monitor keeps
 * working even when a data source is unreachable.
 */
import type { DataManager } from "../data/manager.js";
import type { Tick, Candle } from "../data/types.js";
import { fetchCandlesCached } from "../data/providers.js";
import { analyzeTechnicals } from "../analysis/signals.js";
import { councilAnalyze } from "../ai/council.js";
import { hasAnyAI } from "../config.js";
import { scoreSignal } from "./scorer.js";
import { getLatestSignal, insertSignal, hasSignalChanged } from "./store.js";
import { bus } from "../events/bus.js";
import type { CouncilAnalysisResult } from "../ai/types.js";
import type { GradedSignal } from "./scorer.js";

/** Refresh the AI council at most this often per symbol. */
export const COUNCIL_TTL_MS = 15 * 60_000; // 15 minutes

/** Minimum 1h candles needed for a technical read. */
const MIN_CANDLES = 14;

interface CachedCouncil {
  result: CouncilAnalysisResult;
  at: number;
}

const lastCouncilBySymbol = new Map<string, CachedCouncil>();
const inFlight = new Set<string>();

let unsubscribers: Array<() => void> = [];

/** Whether a cached council is still fresh enough to reuse. */
export function isCouncilFresh(at: number, now = Date.now()): boolean {
  return now - at < COUNCIL_TTL_MS;
}

/**
 * Fetch 1h candles via the unified provider router (Binance with host
 * failover, CoinGecko fallback, shared cache). 250 so SMA(200) computes.
 */
async function getHourlyCandles(symbol: string) {
  return fetchCandlesCached(symbol, "1h", 250);
}

/**
 * Re-score a single symbol and, if the signal meaningfully changed, persist it
 * and emit it on the bus. Returns the new signal when a push occurred, else null.
 *
 * Guarded by a per-symbol in-flight lock so two rapid candle events for the same
 * symbol can't launch duplicate council calls.
 */
export async function evaluateSymbol(symbol: string): Promise<GradedSignal | null> {
  const sym = symbol.toUpperCase();
  if (inFlight.has(sym)) return null;
  inFlight.add(sym);

  try {
    const candles = await getHourlyCandles(sym);
    if (candles.length < MIN_CANDLES) return null;

    const technical = analyzeTechnicals(sym, candles);
    if (!technical) return null;

    // Council gating: reuse a fresh cached council; otherwise refresh (lazily).
    let council: CouncilAnalysisResult | undefined;
    if (hasAnyAI()) {
      const cachedCouncil = lastCouncilBySymbol.get(sym);
      if (cachedCouncil && isCouncilFresh(cachedCouncil.at)) {
        council = cachedCouncil.result;
      } else {
        const fresh = await councilAnalyze(sym, technical);
        lastCouncilBySymbol.set(sym, { result: fresh, at: Date.now() });
        council = fresh;
      }
    }

    const signal = scoreSignal(technical, council);

    const previous = await getLatestSignal(sym);
    if (!hasSignalChanged(previous, signal)) return null;

    await insertSignal(signal);
    bus.emitSignal(signal);
    return signal;
  } catch (err) {
    console.error(`[Monitor] Failed to evaluate ${sym}:`, err);
    return null;
  } finally {
    inFlight.delete(sym);
  }
}

/**
 * Start the reactive monitor against a live DataManager.
 * Forwards ticks to the bus and re-scores on each closed candle.
 */
export function startSignalMonitor(dataManager: DataManager): void {
  stopSignalMonitor();

  const onTick = (tick: Tick) => {
    // Forward live ticks for the dashboard.
    bus.emitTick(tick);
  };
  const onCandle = (candle: Candle) => {
    void evaluateSymbol(candle.symbol);
  };

  dataManager.on("tick", onTick);
  dataManager.on("candle", onCandle);

  unsubscribers = [
    () => dataManager.off("tick", onTick),
    () => dataManager.off("candle", onCandle),
  ];

  console.log("[Monitor] Signal monitor started");
}

/** Stop the monitor and clear subscriptions + caches. */
export function stopSignalMonitor(): void {
  for (const unsub of unsubscribers) unsub();
  unsubscribers = [];
  lastCouncilBySymbol.clear();
  inFlight.clear();
}

/** Test helper: clear internal council cache + in-flight state. */
export function _resetMonitorState(): void {
  lastCouncilBySymbol.clear();
  inFlight.clear();
}
