/**
 * Signal monitor.
 *
 * Every SWEEP_INTERVAL_MS it reads the watchlist and re-scores each crypto
 * symbol's graded signal. If a live DataManager is supplied, its ticks are
 * forwarded to the event bus for the dashboard.
 *
 * Why a sweep and not the Binance stream: evaluation used to fire on each
 * closed 1-minute candle from the stream, whose symbol list is fixed at
 * startup. Coins without a Binance pair (VVV) were never scored at all, and
 * coins added later weren't scored until a restart. The sweep reads the
 * watchlist every time and uses the provider router, so any coin with candle
 * data — Binance or CoinGecko — is covered. Posting is throttled to hourly
 * anyway (see hasSignalChanged), so 1-minute evaluation bought nothing.
 *
 * Stocks are left out: Finnhub's candle endpoint is premium-gated on the free
 * plan, so there's nothing to score them from yet.
 *
 * Cost control:
 * - The technical read is recomputed each sweep (cheap, local).
 * - The AI council is refreshed at most once per COUNCIL_TTL_MS per symbol; a
 *   fresher cached council is reused. A council that returns zero votes (all
 *   providers failed) is treated as absent.
 * - A per-symbol in-flight guard prevents overlapping evaluations, and symbols
 *   within a sweep are staggered so a long watchlist doesn't burst providers.
 * - Pushes are gated by hasSignalChanged.
 */
import type { DataManager } from "../data/manager.js";
import type { Tick } from "../data/types.js";
import { fetchCandlesCached } from "../data/providers.js";
import { analyzeTechnicals } from "../analysis/signals.js";
import { councilAnalyze } from "../ai/council.js";
import { hasAnyAI } from "../config.js";
import { scoreSignal } from "./scorer.js";
import { getLatestSignal, insertSignal, hasSignalChanged } from "./store.js";
import { isWatched, listWatchlist } from "../state/watchlist.js";
import { bus } from "../events/bus.js";
import type { CouncilAnalysisResult } from "../ai/types.js";
import type { TechnicalSummary } from "../analysis/types.js";
import type { GradedSignal } from "./scorer.js";

/** Refresh the AI council at most this often per symbol. */
export const COUNCIL_TTL_MS = 15 * 60_000; // 15 minutes

/** Minimum 1h candles needed for a technical read. */
const MIN_CANDLES = 14;

/** How often every watched crypto symbol is re-scored. */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Gap between symbols within one sweep. */
const SWEEP_STAGGER_MS = 2_000;

interface CachedCouncil {
  result: CouncilAnalysisResult;
  at: number;
}

const lastCouncilBySymbol = new Map<string, CachedCouncil>();
const inFlight = new Set<string>();

let unsubscribers: Array<() => void> = [];
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** A fresh Sentinel read: the graded signal plus what it was built from. */
export interface SentinelAssessment {
  signal: GradedSignal;
  technical: TechnicalSummary;
  council?: CouncilAnalysisResult;
}

/**
 * Score a symbol right now, without persisting or posting anything. Shares
 * the council cache with the sweep, so an on-demand read right after a sweep
 * costs no extra AI calls. Returns null when there isn't enough candle data.
 */
export async function assessSymbol(symbol: string): Promise<SentinelAssessment | null> {
  const sym = symbol.toUpperCase();

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

  return { signal: scoreSignal(technical, council), technical, council };
}

/**
 * Re-score a single symbol and, if the signal meaningfully changed, persist it
 * and emit it on the bus. Returns the new signal when a push occurred, else null.
 *
 * Guarded by a per-symbol in-flight lock so overlapping evaluations of the
 * same symbol can't launch duplicate council calls.
 */
export async function evaluateSymbol(symbol: string): Promise<GradedSignal | null> {
  const sym = symbol.toUpperCase();
  if (inFlight.has(sym)) return null;
  inFlight.add(sym);

  try {
    // Checked before any work, so removing a coin from the watchlist takes
    // effect on the next sweep — and skips the council spend.
    if (!(await isWatched(sym))) return null;

    const assessment = await assessSymbol(sym);
    if (!assessment) return null;
    const { signal } = assessment;

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
 * Re-score every crypto symbol currently on the watchlist, one at a time.
 * Returns the signals that were pushed. Never throws; a sweep already in
 * progress makes this a no-op rather than a second concurrent pass.
 */
export async function runSweep(
  opts: { staggerMs?: number } = {}
): Promise<GradedSignal[]> {
  if (sweeping) return [];
  sweeping = true;
  const staggerMs = opts.staggerMs ?? SWEEP_STAGGER_MS;

  try {
    const symbols = (await listWatchlist())
      .filter((entry) => entry.market === "crypto")
      .map((entry) => entry.symbol);

    const pushed: GradedSignal[] = [];
    for (let i = 0; i < symbols.length; i++) {
      // evaluateSymbol catches its own errors, so one bad symbol can't end the sweep.
      const signal = await evaluateSymbol(symbols[i]);
      if (signal) pushed.push(signal);
      if (staggerMs > 0 && i < symbols.length - 1) await sleep(staggerMs);
    }
    return pushed;
  } catch (err) {
    console.error("[Monitor] Sweep failed:", err);
    return [];
  } finally {
    sweeping = false;
  }
}

/**
 * Start the monitor: a sweep now, then every SWEEP_INTERVAL_MS. Pass the live
 * DataManager, if there is one, to forward its ticks to the dashboard.
 */
export function startSignalMonitor(dataManager?: DataManager | null): void {
  stopSignalMonitor();

  if (dataManager) {
    const onTick = (tick: Tick) => {
      // Forward live ticks for the dashboard.
      bus.emitTick(tick);
    };
    dataManager.on("tick", onTick);
    unsubscribers = [() => dataManager.off("tick", onTick)];
  }

  void runSweep();
  sweepTimer = setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  console.log(
    `[Monitor] Signal monitor started — sweeping the crypto watchlist every ${SWEEP_INTERVAL_MS / 60_000} min`
  );
}

/** Stop the monitor and clear subscriptions + caches. */
export function stopSignalMonitor(): void {
  for (const unsub of unsubscribers) unsub();
  unsubscribers = [];
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  lastCouncilBySymbol.clear();
  inFlight.clear();
}

/** Test helper: clear internal council cache + in-flight state. */
export function _resetMonitorState(): void {
  lastCouncilBySymbol.clear();
  inFlight.clear();
  sweeping = false;
}
