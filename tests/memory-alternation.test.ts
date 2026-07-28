import { describe, it, expect, beforeEach } from "vitest";
import { recordTurn, getHistory, clearAllSessions } from "../src/ai/memory.js";

/**
 * The Anthropic Messages API requires strictly alternating user/assistant roles,
 * with the first message being 'user'. History that violates this is rejected
 * outright — and because the bad history persists, every later message in that
 * channel fails too. These tests pin the invariant.
 */
function assertWellFormed(history: Array<{ role: string }>): void {
  if (history.length === 0) return;
  expect(history[0].role).toBe("user");
  for (let i = 1; i < history.length; i++) {
    expect(history[i].role).not.toBe(history[i - 1].role);
  }
}

beforeEach(() => {
  clearAllSessions();
});

describe("history role alternation", () => {
  it("stays well-formed for normal paired exchanges", () => {
    for (let i = 0; i < 8; i++) {
      recordTurn("c", "user", `q${i}`);
      recordTurn("c", "assistant", `a${i}`);
    }
    assertWellFormed(getHistory("c"));
  });

  it("stays well-formed when a model returns empty content", () => {
    // OpenAI returns "" when choices[0].message.content is null.
    recordTurn("c", "user", "first question");
    recordTurn("c", "assistant", ""); // dropped by the empty guard
    recordTurn("c", "user", "second question");

    // Without a fix this yields [user, user] and Anthropic rejects the request.
    assertWellFormed(getHistory("c"));
  });

  it("never begins with an assistant turn after trimming", () => {
    // Fill past MAX_TURNS so the window slides, then verify the boundary.
    for (let i = 0; i < 20; i++) {
      recordTurn("c", "user", `q${i}`);
      recordTurn("c", "assistant", `a${i}`);
    }
    assertWellFormed(getHistory("c"));
  });

  it("stays well-formed when an assistant turn is dropped mid-conversation", () => {
    recordTurn("c", "user", "q1");
    recordTurn("c", "assistant", "a1");
    recordTurn("c", "user", "q2");
    recordTurn("c", "assistant", "   "); // whitespace-only → dropped
    recordTurn("c", "user", "q3");
    recordTurn("c", "assistant", "a3");

    assertWellFormed(getHistory("c"));
  });
});
