import { describe, it, expect, vi, beforeEach } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  classifyProviderError,
  recordFailure,
  recordSuccess,
  tracked,
  onProviderAlert,
  getProviderHealth,
  BadResponseError,
  TRANSIENT_ALERT_AFTER,
  REMINDER_INTERVAL_MS,
  _resetProviderHealth,
  type ProviderAlert,
} from "../src/ai/health.js";

/**
 * Provider health: when an AI provider breaks, the operator hears about it —
 * immediately if it needs action, after a few tries if it's a blip — and hears
 * again when it recovers. Before this, failures lived only in container logs.
 */

// Real SDK errors, so classification is tested against what the SDKs throw.
const headers = new Headers();
const openaiError = (status: number, error: Record<string, unknown>) =>
  OpenAI.APIError.generate(status, { error }, undefined, headers as never);
const anthropicError = (status: number, type: string, message: string) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, undefined, headers as never);

let alerts: ProviderAlert[] = [];

beforeEach(() => {
  _resetProviderHealth();
  alerts = [];
  onProviderAlert((a) => alerts.push(a));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("classifyProviderError", () => {
  it("OpenAI: rejected key → auth", () => {
    const err = openaiError(401, { message: "Incorrect API key provided", code: "invalid_api_key" });
    expect(classifyProviderError(err)).toBe("auth");
  });

  it("OpenAI: empty balance is a 429 but means quota, not rate limit", () => {
    const err = openaiError(429, { message: "You exceeded your current quota", code: "insufficient_quota" });
    expect(classifyProviderError(err)).toBe("quota");
  });

  it("OpenAI: plain 429 → rate_limit", () => {
    const err = openaiError(429, { message: "Rate limit reached for gpt-4o" });
    expect(classifyProviderError(err)).toBe("rate_limit");
  });

  it("OpenAI: retired model → model_unavailable", () => {
    const err = openaiError(404, { message: "The model `gpt-4o` does not exist", code: "model_not_found" });
    expect(classifyProviderError(err)).toBe("model_unavailable");
  });

  it("Anthropic: invalid key → auth", () => {
    expect(classifyProviderError(anthropicError(401, "authentication_error", "invalid x-api-key"))).toBe("auth");
  });

  it("Anthropic: low credit balance is a 400 but means quota", () => {
    const err = anthropicError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.");
    expect(classifyProviderError(err)).toBe("quota");
  });

  it("Anthropic: overloaded (529) → provider_down", () => {
    expect(classifyProviderError(anthropicError(529, "overloaded_error", "Overloaded"))).toBe("provider_down");
  });

  it("server errors → provider_down", () => {
    expect(classifyProviderError(openaiError(503, { message: "Service unavailable" }))).toBe("provider_down");
  });

  it("our own timeout abort → timeout", () => {
    expect(classifyProviderError(new OpenAI.APIUserAbortError())).toBe("timeout");
    expect(classifyProviderError(new OpenAI.APIConnectionTimeoutError())).toBe("timeout");
  });

  it("garbled replies → bad_response", () => {
    expect(classifyProviderError(new BadResponseError("Unparseable reply after retry"))).toBe("bad_response");
    expect(classifyProviderError(new SyntaxError("Unexpected token < in JSON"))).toBe("bad_response");
  });

  it("anything else → unknown", () => {
    expect(classifyProviderError(new Error("something odd"))).toBe("unknown");
  });
});

describe("alert policy", () => {
  it("alerts on the FIRST failure when it needs action (bad key)", () => {
    recordFailure("OpenAI", openaiError(401, { message: "Incorrect API key", code: "invalid_api_key" }));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ provider: "OpenAI", status: "failing", kind: "auth" });
    expect(alerts[0].advice).toContain("OPENAI_API_KEY");
  });

  it("stays quiet for a transient blip, then alerts once it persists", () => {
    const outage = openaiError(503, { message: "Service unavailable" });
    for (let i = 1; i < TRANSIENT_ALERT_AFTER; i++) recordFailure("Gemini", outage);
    expect(alerts).toHaveLength(0);

    recordFailure("Gemini", outage);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("provider_down");
  });

  it("a success resets the streak, so scattered blips never alert", () => {
    const outage = openaiError(503, { message: "Service unavailable" });
    for (let round = 0; round < 5; round++) {
      recordFailure("Groq", outage);
      recordFailure("Groq", outage);
      recordSuccess("Groq");
    }
    expect(alerts).toHaveLength(0);
  });

  it("doesn't repeat itself during an ongoing outage", () => {
    const err = anthropicError(401, "authentication_error", "invalid x-api-key");
    const t0 = Date.UTC(2026, 8, 22, 12);
    recordFailure("Claude", err, t0);
    recordFailure("Claude", err, t0 + 60_000);
    recordFailure("Claude", err, t0 + 3_600_000);

    expect(alerts).toHaveLength(1);
  });

  it("sends a reminder once the reminder interval passes", () => {
    const err = anthropicError(401, "authentication_error", "invalid x-api-key");
    const t0 = Date.UTC(2026, 8, 22, 12);
    recordFailure("Claude", err, t0);
    recordFailure("Claude", err, t0 + REMINDER_INTERVAL_MS);

    expect(alerts).toHaveLength(2);
    expect(alerts[1].reminder).toBe(true);
  });

  it("announces recovery — but only if it had alerted", () => {
    recordFailure("Mistral", openaiError(503, { message: "down" }));
    recordSuccess("Mistral"); // one blip, never alerted
    expect(alerts).toHaveLength(0);

    recordFailure("OpenAI", openaiError(401, { message: "bad key", code: "invalid_api_key" }));
    recordSuccess("OpenAI");
    expect(alerts.map((a) => a.status)).toEqual(["failing", "recovered"]);
  });

  it("names the providers still working, and says so when none are", () => {
    recordSuccess("Claude");
    recordSuccess("Gemini");
    recordFailure("OpenAI", openaiError(401, { message: "bad key", code: "invalid_api_key" }));
    expect(alerts[0].healthyOthers?.sort()).toEqual(["Claude", "Gemini"]);

    _resetProviderHealth();
    alerts = [];
    onProviderAlert((a) => alerts.push(a));
    recordFailure("Claude", anthropicError(401, "authentication_error", "invalid x-api-key"));
    recordFailure("OpenAI", openaiError(401, { message: "bad key", code: "invalid_api_key" }));
    expect(alerts[1].healthyOthers).toEqual([]);
  });

  it("a throwing listener can't break the call path", () => {
    onProviderAlert(() => {
      throw new Error("discord down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      recordFailure("OpenAI", openaiError(401, { message: "bad key", code: "invalid_api_key" }))
    ).not.toThrow();
  });
});

describe("tracked()", () => {
  it("records success and passes the result through", async () => {
    expect(await tracked("DeepSeek", async () => 42)).toBe(42);
    expect(getProviderHealth()).toEqual([
      expect.objectContaining({ provider: "DeepSeek", healthy: true }),
    ]);
  });

  it("records failure and rethrows the original error, so fallbacks still work", async () => {
    const err = openaiError(401, { message: "bad key", code: "invalid_api_key" });
    await expect(tracked("OpenAI", async () => { throw err; })).rejects.toBe(err);
    expect(getProviderHealth()[0]).toMatchObject({ healthy: false, lastFailure: "API key rejected" });
  });
});
