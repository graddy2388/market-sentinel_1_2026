import { describe, it, expect, beforeEach } from "vitest";
import {
  recordTurn,
  getHistory,
  clearSession,
  clearAllSessions,
  sessionCount,
  MAX_TURNS,
  MAX_TURN_CHARS,
  MAX_SESSIONS,
} from "../src/ai/memory.js";

beforeEach(() => {
  clearAllSessions();
});

describe("recordTurn / getHistory", () => {
  it("returns empty history for an unknown session", () => {
    expect(getHistory("nope")).toEqual([]);
  });

  it("records and returns turns oldest-first", () => {
    recordTurn("chan1", "user", "what about XRP?");
    recordTurn("chan1", "assistant", "XRP looks weak here.");
    recordTurn("chan1", "user", "why?");

    const history = getHistory("chan1");
    expect(history).toHaveLength(3);
    expect(history[0].content).toBe("what about XRP?");
    expect(history[0].role).toBe("user");
    expect(history[2].content).toBe("why?");
  });

  it("keeps sessions isolated from each other", () => {
    recordTurn("chanA", "user", "BTC?");
    recordTurn("chanB", "user", "ETH?");

    expect(getHistory("chanA")).toHaveLength(1);
    expect(getHistory("chanA")[0].content).toBe("BTC?");
    expect(getHistory("chanB")[0].content).toBe("ETH?");
  });

  it("ignores empty or whitespace-only content", () => {
    recordTurn("chan1", "user", "");
    recordTurn("chan1", "user", "   ");
    expect(getHistory("chan1")).toEqual([]);
  });

  it("ignores an empty session id", () => {
    recordTurn("", "user", "hello");
    expect(sessionCount()).toBe(0);
  });

  it("trims turns beyond MAX_TURNS, keeping the most recent", () => {
    // Realistic usage: alternating user/assistant pairs.
    const pairs = MAX_TURNS; // 2x MAX_TURNS messages total
    for (let i = 0; i < pairs; i++) {
      recordTurn("chan1", "user", `q${i}`);
      recordTurn("chan1", "assistant", `a${i}`);
    }
    const history = getHistory("chan1");
    expect(history).toHaveLength(MAX_TURNS);
    // The oldest retained turn is the user half of the 7th-from-last pair.
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe(`q${pairs - MAX_TURNS / 2}`);
    expect(history[history.length - 1].content).toBe(`a${pairs - 1}`);
  });

  it("clamps very long turns", () => {
    recordTurn("chan1", "user", "x".repeat(MAX_TURN_CHARS + 500));
    const [turn] = getHistory("chan1");
    expect(turn.content.length).toBe(MAX_TURN_CHARS);
    expect(turn.content.endsWith("...")).toBe(true);
  });

  it("returns a copy — callers cannot mutate stored history", () => {
    recordTurn("chan1", "user", "original");
    const history = getHistory("chan1");
    history.push({ role: "user", content: "injected", timestamp: Date.now() });
    expect(getHistory("chan1")).toHaveLength(1);
  });
});

describe("clearSession", () => {
  it("forgets one session without touching others", () => {
    recordTurn("chanA", "user", "hi");
    recordTurn("chanB", "user", "hi");

    expect(clearSession("chanA")).toBe(true);
    expect(getHistory("chanA")).toEqual([]);
    expect(getHistory("chanB")).toHaveLength(1);
  });

  it("returns false for an unknown session", () => {
    expect(clearSession("never-existed")).toBe(false);
  });
});

describe("session capacity", () => {
  it("evicts the least-recently-used session past MAX_SESSIONS", () => {
    for (let i = 0; i < MAX_SESSIONS + 10; i++) {
      recordTurn(`chan${i}`, "user", "hello");
    }
    expect(sessionCount()).toBeLessThanOrEqual(MAX_SESSIONS);
    // The earliest sessions should have been evicted.
    expect(getHistory("chan0")).toEqual([]);
    // The most recent should survive.
    expect(getHistory(`chan${MAX_SESSIONS + 9}`)).toHaveLength(1);
  });
});
