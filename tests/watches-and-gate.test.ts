import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { rmSync } from "fs";

/**
 * Watches and the delivery gate, against a real (temporary) database.
 *
 * The behaviour being locked down: nothing pings unless you asked for it, what
 * you asked for expires on its own, and nothing wakes you overnight — but
 * nothing is silently dropped either.
 */

const TEST_DB_PATH = vi.hoisted(() => {
  const dir = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return `${dir}/ms-watches-${process.pid}-${Date.now()}.db`;
});

vi.mock("../src/config.js", () => ({
  DB_PATH: TEST_DB_PATH,
  hasAnyAI: () => true,
  appConfig: { QUIET_HOURS_START: 0, QUIET_HOURS_END: 8, BRIEFING_TZ_OFFSET: -4 },
}));

const {
  startWatch, stopWatch, listActiveWatches, isBeingWatched, collectExpiredWatches,
  DEFAULT_WATCH_MINUTES,
} = await import("../src/state/watches.js");
const {
  deliver, isQuietHour, localHour, takeHeldNotices, countHeldNotices, _clearHeldNotices,
} = await import("../src/notifications/gate.js");

const MINUTE = 60_000;
const HOUR = 3_600_000;

afterAll(() => {
  try { rmSync(TEST_DB_PATH, { force: true }); } catch { /* best effort */ }
});

beforeEach(async () => {
  for (const w of await listActiveWatches()) await stopWatch(w.symbol);
  await _clearHeldNotices();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("starting and stopping a watch", () => {
  it("defaults to four hours", async () => {
    const now = Date.UTC(2026, 8, 23, 15);
    const watch = await startWatch("XRP", { now });

    expect(watch.symbol).toBe("XRP");
    expect(watch.expiresAt).toBe(now + DEFAULT_WATCH_MINUTES * MINUTE);
    expect(await isBeingWatched("xrp", now)).toBe(true);
  });

  it("watches indefinitely when asked", async () => {
    const watch = await startWatch("BTC", { durationMinutes: null });
    expect(watch.expiresAt).toBeNull();
    // Still watched a year later.
    expect(await isBeingWatched("BTC", Date.now() + 365 * 24 * HOUR)).toBe(true);
  });

  it("extends an existing watch instead of stacking duplicates", async () => {
    const now = Date.now();
    await startWatch("ETH", { durationMinutes: 30, now });
    const second = await startWatch("ETH", { durationMinutes: 120, now });

    expect(second.replaced).toBe(true);
    const active = await listActiveWatches(now);
    expect(active.filter((w) => w.symbol === "ETH")).toHaveLength(1);
    expect(second.expiresAt).toBe(now + 120 * MINUTE);
  });

  it("stops early when asked", async () => {
    await startWatch("SOL", { durationMinutes: 240 });

    expect(await stopWatch("sol")).toBe(true);
    expect(await isBeingWatched("SOL")).toBe(false);
    // Stopping again reports that there was nothing to stop.
    expect(await stopWatch("SOL")).toBe(false);
  });

  it("expires on its own — this is what stops alerts running forever", async () => {
    const now = Date.now();
    await startWatch("DOGE", { durationMinutes: 60, now });

    expect(await isBeingWatched("DOGE", now + 59 * MINUTE)).toBe(true);
    expect(await isBeingWatched("DOGE", now + 61 * MINUTE)).toBe(false);
  });

  it("reports expired watches once, so the channel is told the pings stopped", async () => {
    const now = Date.now();
    await startWatch("ADA", { durationMinutes: 10, now });

    const later = now + 20 * MINUTE;
    const first = await collectExpiredWatches(later);
    expect(first.map((w) => w.symbol)).toContain("ADA");

    // Already reported — not repeated on the next pass.
    expect((await collectExpiredWatches(later)).map((w) => w.symbol)).not.toContain("ADA");
  });
});

describe("quiet hours", () => {
  const offsetHours = -4;
  const atLocalHour = (hour: number) => Date.UTC(2026, 8, 23, (hour - offsetHours + 24) % 24);

  it("is quiet between midnight and 8am local", () => {
    for (const hour of [0, 3, 7]) {
      expect(isQuietHour(atLocalHour(hour), { start: 0, end: 8, offsetHours })).toBe(true);
    }
    for (const hour of [8, 12, 23]) {
      expect(isQuietHour(atLocalHour(hour), { start: 0, end: 8, offsetHours })).toBe(false);
    }
  });

  it("converts to local time using the briefing's offset", () => {
    // 04:00 UTC is midnight in UTC-4.
    expect(localHour(Date.UTC(2026, 8, 23, 4), -4)).toBe(0);
  });

  it("handles a window that wraps midnight", () => {
    const wrap = { start: 22, end: 7, offsetHours };
    expect(isQuietHour(atLocalHour(23), wrap)).toBe(true);
    expect(isQuietHour(atLocalHour(3), wrap)).toBe(true);
    expect(isQuietHour(atLocalHour(8), wrap)).toBe(false);
  });

  it("is disabled when start equals end", () => {
    expect(isQuietHour(atLocalHour(3), { start: 0, end: 0, offsetHours })).toBe(false);
  });
});

describe("deliver", () => {
  // 3pm local — outside quiet hours.
  const daytime = Date.UTC(2026, 8, 23, 19);
  // 3am local — inside them.
  const overnight = Date.UTC(2026, 8, 23, 7);

  it("says nothing about a symbol nobody asked to watch", async () => {
    const send = vi.fn(async () => {});

    const result = await deliver("signal", "XRP", "BUY @ 61%", send, { now: daytime });

    expect(result).toBe("not_watched");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends when the symbol is watched and it isn't quiet hours", async () => {
    await startWatch("XRP", { durationMinutes: 240, now: daytime });
    const send = vi.fn(async () => {});

    const result = await deliver("signal", "XRP", "BUY @ 61%", send, { now: daytime });

    expect(result).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
  });

  it("holds overnight instead of waking you — and doesn't drop it", async () => {
    await startWatch("XRP", { durationMinutes: 600, now: overnight });
    const send = vi.fn(async () => {});

    const result = await deliver("signal", "XRP", "STRONG BUY @ 81%", send, { now: overnight });

    expect(result).toBe("held");
    expect(send).not.toHaveBeenCalled();
    expect(await countHeldNotices()).toBe(1);
  });

  it("delivers held notices once, then considers them done", async () => {
    await startWatch("XRP", { durationMinutes: 600, now: overnight });
    await deliver("signal", "XRP", "first", vi.fn(async () => {}), { now: overnight });
    await deliver("signal", "XRP", "second", vi.fn(async () => {}), { now: overnight });

    const delivered = await takeHeldNotices();
    expect(delivered.map((n) => n.summary)).toEqual(["first", "second"]);
    expect(await takeHeldNotices()).toEqual([]);
    expect(await countHeldNotices()).toBe(0);
  });

  it("lets a watch-expiry notice through, since the watch is over by then", async () => {
    const send = vi.fn(async () => {});

    const result = await deliver("watch_expired", "XRP", "Watch expired", send, {
      requireWatch: false,
      now: daytime,
    });

    expect(result).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
  });

  it("reports a failed send without throwing into the signal pipeline", async () => {
    await startWatch("XRP", { durationMinutes: 240, now: daytime });
    const send = vi.fn(async () => {
      throw new Error("discord down");
    });

    await expect(deliver("signal", "XRP", "BUY", send, { now: daytime })).resolves.toBe("failed");
  });
});
