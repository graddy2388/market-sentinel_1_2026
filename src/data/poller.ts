import { fetch24hr } from "./providers.js";
import { cache } from "./cache.js";

const POLL_INTERVAL_MS = 15_000; // 15 seconds
const MAX_BATCH_SIZE = 5; // Stay well under CoinGecko's 10 req/min free-tier limit
const STAGGER_DELAY_MS = 2_000; // 2 seconds between batches

let pollTimer: ReturnType<typeof setInterval> | null = null;
let watchedSymbols: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll all watched symbols, batching requests and staggering
 * to respect CoinGecko's free-tier rate limit (10 req/min).
 *
 * CoinGecko's /coins/{id} endpoint (used by fetch24hr) only accepts
 * one coin at a time, so we stagger individual requests in batches.
 */
async function pollAll(): Promise<void> {
  const symbols = [...watchedSymbols];
  if (symbols.length === 0) return;

  for (let i = 0; i < symbols.length; i += MAX_BATCH_SIZE) {
    const batch = symbols.slice(i, i + MAX_BATCH_SIZE);

    // Fire all requests in this batch concurrently
    const results = await Promise.allSettled(
      batch.map(async (sym) => {
        const data = await fetch24hr(sym);
        if (data) {
          cache.setPrice(sym, data);
        }
      })
    );

    // Log any failures (non-fatal)
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "rejected") {
        console.warn(`[Poller] Failed to fetch ${batch[j]}: ${r.reason}`);
      }
    }

    // Stagger before the next batch to avoid rate-limit bursts
    if (i + MAX_BATCH_SIZE < symbols.length) {
      await sleep(STAGGER_DELAY_MS);
    }
  }
}

/**
 * Start the background price poller for the given symbols.
 * If the poller is already running, it replaces the watched symbols
 * and restarts the interval.
 */
export function startPoller(symbols: string[]): void {
  stopPoller();

  watchedSymbols = symbols.map((s) => s.toUpperCase());
  if (watchedSymbols.length === 0) {
    console.log("[Poller] No symbols to watch — poller not started.");
    return;
  }

  console.log(
    `[Poller] Starting background poller for ${watchedSymbols.length} symbol(s): ${watchedSymbols.join(", ")}`
  );

  // Fire an initial poll immediately (don't await — let it run in the background)
  pollAll().catch((err) =>
    console.error("[Poller] Initial poll error:", err)
  );

  pollTimer = setInterval(() => {
    pollAll().catch((err) =>
      console.error("[Poller] Poll cycle error:", err)
    );
  }, POLL_INTERVAL_MS);
}

/** Stop the background poller. */
export function stopPoller(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log("[Poller] Stopped.");
  }
  watchedSymbols = [];
}
