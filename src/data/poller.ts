import { fetch24hr, getCryptoSource } from "./providers.js";
import { cache } from "./cache.js";

const POLL_INTERVAL_MS = 15_000; // 15 seconds
const MAX_BATCH_SIZE = 5; // Only Binance/Finnhub symbols reach here; both are generous
const STAGGER_DELAY_MS = 2_000; // 2 seconds between batches

let pollTimer: ReturnType<typeof setInterval> | null = null;
let symbolSource: () => Promise<string[]> = async () => [];
let polling = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a symbol should be fetched this cycle, given where its data comes from.
 *
 * CoinGecko-backed coins (no Binance pair — VVV, LEO, ...) are never polled.
 * This loop only pre-warms a 15-second price cache, which isn't worth
 * CoinGecko's budget: the free Demo plan allows 10,000 calls a MONTH, and
 * polling one such coin even every 5 minutes would spend ~8,600 of them. Their
 * prices are fetched on demand instead, and the signal monitor keeps its own
 * slower schedule for them.
 */
export function isDueForPoll(symbol: string): boolean {
  // An unknown source is polled once, which is how its source gets learned.
  return getCryptoSource(symbol) !== "coingecko";
}

/**
 * Poll every due symbol, batching requests and staggering between batches.
 *
 * The symbol list is re-read each cycle, so watchlist changes take effect
 * without a restart. Overlapping cycles are skipped rather than stacked.
 */
export async function pollOnce(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    let symbols: string[];
    try {
      symbols = (await symbolSource()).map((s) => s.toUpperCase());
    } catch (err) {
      console.warn("[Poller] Could not read symbols:", err instanceof Error ? err.message : err);
      return;
    }

    const due = symbols.filter((s) => isDueForPoll(s));

    for (let i = 0; i < due.length; i += MAX_BATCH_SIZE) {
      const batch = due.slice(i, i + MAX_BATCH_SIZE);

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
      if (i + MAX_BATCH_SIZE < due.length) {
        await sleep(STAGGER_DELAY_MS);
      }
    }
  } finally {
    polling = false;
  }
}

/**
 * Start the background price poller.
 *
 * Takes a function rather than a list: the list used to be captured at
 * startup, so coins added to the watchlist afterwards were never polled and
 * removed ones kept being polled until a restart.
 */
export function startPoller(getSymbols: () => Promise<string[]>): void {
  stopPoller();
  symbolSource = getSymbols;

  console.log("[Poller] Starting background poller (watchlist re-read each cycle)");

  // Fire an initial poll immediately (don't await — let it run in the background)
  pollOnce().catch((err) => console.error("[Poller] Initial poll error:", err));

  pollTimer = setInterval(() => {
    pollOnce().catch((err) => console.error("[Poller] Poll cycle error:", err));
  }, POLL_INTERVAL_MS);
}

/** Stop the background poller. */
export function stopPoller(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log("[Poller] Stopped.");
  }
  symbolSource = async () => [];
}
