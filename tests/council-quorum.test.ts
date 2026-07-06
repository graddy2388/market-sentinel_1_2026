import { describe, it, expect } from "vitest";
import { z } from "zod";
import { settleWithQuorum, parseJson } from "../src/ai/council.js";

function delayed<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
function delayedReject(ms: number, msg = "boom"): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

describe("settleWithQuorum", () => {
  it("returns all results when everything settles before the deadline", async () => {
    const results = await settleWithQuorum(
      [delayed("a", 5), delayed("b", 10), delayed("c", 15)],
      200
    );
    expect(results).toHaveLength(3);
    expect(results.every((r) => r?.status === "fulfilled")).toBe(true);
  });

  it("drops a straggler once the deadline passes with a quorum in hand", async () => {
    const start = Date.now();
    const results = await settleWithQuorum(
      [delayed("fast1", 5), delayed("fast2", 10), delayed("slow", 5_000)],
      60
    );
    const elapsed = Date.now() - start;

    // Should resolve shortly after the 60ms deadline, not after 5s.
    expect(elapsed).toBeLessThan(1_000);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("fulfilled");
    expect(results[2]).toBeNull(); // dropped
  });

  it("waits past the deadline until a quorum is reached", async () => {
    // Quorum of 2 (ceil(3/2)); second success lands at 120ms, after the 40ms deadline.
    const start = Date.now();
    const results = await settleWithQuorum(
      [delayed("fast", 5), delayed("medium", 120), delayed("slow", 5_000)],
      40
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1_000);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("fulfilled");
    expect(results[2]).toBeNull();
  });

  it("rejections settle but do not count toward the quorum", async () => {
    // 3 tasks, quorum 2. One fulfills fast, one rejects fast, one fulfills at 120ms.
    // The rejection must not trigger early exit at the 40ms deadline with only 1 vote.
    const results = await settleWithQuorum(
      [delayed("ok", 5), delayedReject(10), delayed("late-ok", 120)],
      40
    );
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    expect(results[2]?.status).toBe("fulfilled"); // waited for it
  });

  it("returns rejections as rejected results, not nulls", async () => {
    const results = await settleWithQuorum([delayedReject(5, "nope"), delayed("ok", 10)], 200);
    expect(results[0]?.status).toBe("rejected");
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(results[1]?.status).toBe("fulfilled");
  });

  it("handles an empty task list", async () => {
    expect(await settleWithQuorum([], 50)).toEqual([]);
  });

  it("never produces unhandled rejections from dropped tasks", async () => {
    // A task that rejects AFTER the early exit — the pre-attached handler
    // must swallow it. If it didn't, vitest would fail the run.
    const results = await settleWithQuorum(
      [delayed("a", 5), delayedReject(80, "late failure")],
      30
    );
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toBeNull();
    // Give the late rejection time to fire while handlers are attached.
    await new Promise((r) => setTimeout(r, 120));
  });
});

const testSchema = z.object({ direction: z.string(), confidence: z.number() });

describe("parseJson", () => {
  it("parses plain JSON", () => {
    const out = parseJson('{"direction":"bullish","confidence":0.8}', testSchema);
    expect(out.direction).toBe("bullish");
  });

  it("strips markdown code fences", () => {
    const raw = '```json\n{"direction":"bearish","confidence":0.6}\n```';
    expect(parseJson(raw, testSchema).direction).toBe("bearish");
  });

  it("extracts JSON wrapped in prose", () => {
    const raw = 'Sure! Here is my analysis:\n{"direction":"neutral","confidence":0.5}\nHope that helps!';
    expect(parseJson(raw, testSchema).direction).toBe("neutral");
  });

  it("handles fenced JSON with prose around it", () => {
    const raw = 'Analysis below.\n```json\n{"direction":"bullish","confidence":0.9}\n```\nLet me know.';
    expect(parseJson(raw, testSchema).confidence).toBe(0.9);
  });

  it("throws when no JSON object is present", () => {
    expect(() => parseJson("no json here at all", testSchema)).toThrow();
  });

  it("throws when the JSON does not match the schema", () => {
    expect(() => parseJson('{"wrong":"shape"}', testSchema)).toThrow();
  });
});
