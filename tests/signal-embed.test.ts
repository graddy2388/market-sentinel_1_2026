import { describe, it, expect, vi } from "vitest";
import type { GradedSignal } from "../src/signals/scorer.js";

/**
 * What the channel actually sees. Two past failures live here: HOLD posts
 * printed fictional (even inverted) levels, and $1-$10 prices rounded to two
 * decimals made distinct levels print identically.
 */

vi.mock("../src/ai/council.js", () => ({ getActiveModelNames: () => [] }));
vi.mock("../src/data/providers.js", () => ({
  getCryptoSymbols: () => [],
  getStockSymbols: () => [],
}));
vi.mock("../src/data/finnhub.js", () => ({ isFinnhubAvailable: () => false }));

const { signalEmbed, providerAlertEmbed, shadowProposalEmbed } = await import("../src/interfaces/discord/embeds.js");

function signal(overrides: Partial<GradedSignal> = {}): GradedSignal {
  return {
    symbol: "XRP", call: "STRONG_BUY", conviction: 0.81, price: 1.5781,
    entry: 1.5781, stop: 1.53, target: 1.6504,
    rationale: "test",
    components: { technical: "bullish", ai: "bullish", agreement: true },
    timestamp: Date.now(),
    ...overrides,
  };
}

function fields(s: GradedSignal): Record<string, string> {
  const json = signalEmbed(s).toJSON();
  return Object.fromEntries((json.fields ?? []).map((f) => [f.name, f.value]));
}

describe("signalEmbed", () => {
  it("prints $1-$10 levels to four decimals, with the dollar sign", () => {
    const f = fields(signal());
    expect(f.Entry).toBe("$1.5781");
    expect(f.Stop).toBe("$1.5300");
    expect(f.Target).toBe("$1.6504");
  });

  it("keeps levels a fraction of a cent apart distinguishable", () => {
    const f = fields(signal({ entry: 1.5849, stop: 1.5759 }));
    expect(f.Entry).not.toBe(f.Stop);
  });

  it("formats large prices with separators and two decimals", () => {
    const f = fields(signal({ symbol: "BTC", price: 65432.1, entry: 65432.1, stop: 64000, target: 68000 }));
    expect(f.Entry).toBe("$65,432.10");
  });

  it("formats sub-dollar prices to four significant figures", () => {
    const f = fields(signal({ symbol: "DOGE", price: 0.123456, entry: 0.123456, stop: 0.12, target: 0.13 }));
    expect(f.Entry).toBe("$0.1235");
  });

  it("shows no entry/stop/target for a HOLD", () => {
    const f = fields(signal({ call: "HOLD", conviction: 0.1, stop: 1.6, target: 1.5 }));
    expect(f.Entry).toBeUndefined();
    expect(f.Stop).toBeUndefined();
    expect(f.Target).toBeUndefined();
    expect(f.Levels).toContain("no trade");
  });
});

describe("providerAlertEmbed", () => {
  const failing = {
    provider: "OpenAI", status: "failing" as const, kind: "auth" as const,
    label: "API key rejected",
    advice: "The API key was rejected. Rotate OPENAI_API_KEY in the Portainer stack and repull.",
    consecutiveFailures: 1, failingSince: Date.UTC(2026, 8, 22, 12), timestamp: Date.UTC(2026, 8, 22, 12),
  };
  const embedFields = (a: Parameters<typeof providerAlertEmbed>[0]) =>
    Object.fromEntries((providerAlertEmbed(a).toJSON().fields ?? []).map((f) => [f.name, f.value]));

  it("says what broke and exactly what to do", () => {
    const json = providerAlertEmbed({ ...failing, healthyOthers: ["Claude"] }).toJSON();
    expect(json.title).toBe("⚠️ OpenAI — API key rejected");
    expect(embedFields({ ...failing, healthyOthers: ["Claude"] })["What to do"]).toContain("OPENAI_API_KEY");
  });

  it("names what still works", () => {
    expect(embedFields({ ...failing, healthyOthers: ["Claude", "Gemini"] }).Meanwhile).toContain("Claude, Gemini");
  });

  it("says plainly when nothing else is working", () => {
    expect(embedFields({ ...failing, healthyOthers: [] }).Meanwhile).toContain("down until one recovers");
  });

  it("marks reminders", () => {
    expect(providerAlertEmbed({ ...failing, reminder: true }).toJSON().title).toContain("Still failing");
  });

  it("announces recovery", () => {
    const json = providerAlertEmbed({ provider: "OpenAI", status: "recovered", failingSince: failing.failingSince, timestamp: Date.now() }).toJSON();
    expect(json.title).toBe("✅ OpenAI is working again");
  });
});

describe("shadowProposalEmbed", () => {
  const vote = (agent: string, direction: string | null, confidence: number | null, extra = {}) => ({
    agent, direction, confidence, rationale: `${agent} rationale`, isDissent: false, veto: null, evaluated: true, ...extra,
  });
  const record = (votes: unknown[]) => ({
    id: 42, symbol: "XRP", trigger: "signal", status: "eligible", action: "BUY", proposedCall: "STRONG_BUY",
    sentinel: { entry: 1.5781, stop: 1.53, target: 1.6504 }, research: null,
    dialogue: { ran: true, skippedReason: null, turns: [{}, {}, {}, {}] },
    votes, preDialogueConfidence: 0.78,
    confidence: { confidence: 0.72, threshold: 0.65, sentinelConviction: 0.8, researchSupport: 0.64,
      agreementFactor: 1, freshnessFactor: 1, base: 0.72, researchStance: "aligned" },
    vetoReason: null, errors: [], summary: "", createdAt: Date.now(),
  }) as never;
  const fieldsOf = (r: never) =>
    Object.fromEntries((shadowProposalEmbed(r).toJSON().fields ?? []).map((f) => [f.name, f.value]));

  const unanimous = [
    vote("sentinel", "bullish", 0.8),
    vote("research", "bullish", 0.64),
    vote("execution", null, null, { evaluated: false }),
  ];

  it("is unmistakably shadow mode", () => {
    const json = shadowProposalEmbed(record(unanimous)).toJSON();
    expect(json.title).toBe("🧪 Shadow proposal: STRONG BUY XRP");
    expect(json.description).toContain("no order is placed");
    expect(json.footer?.text).toContain("#42");
  });

  it("says 'Unanimous' outright — never an empty or missing dissent field", () => {
    expect(fieldsOf(record(unanimous)).Dissent).toContain("Unanimous");
  });

  it("shows the dissenting agent's reasoning verbatim when there is dissent", () => {
    const split = [
      vote("sentinel", "bullish", 0.8),
      vote("research", "neutral", 0.6, { isDissent: true, rationale: "Token unlock of 5% supply on Friday." }),
      vote("execution", null, null, { evaluated: false }),
    ];
    const f = fieldsOf(record(split));
    expect(f.Dissent).toContain("Token unlock of 5% supply on Friday.");
    expect(f.Votes).toContain("⚠️ dissent");
  });

  it("shows the confidence math and the dialogue's effect", () => {
    const f = fieldsOf(record(unanimous));
    expect(f.Confidence).toContain("72%");
    expect(f.Confidence).toContain("gate 65%");
    expect(f.Dialogue).toContain("78% → 72%");
    expect(f.Votes).toContain("Execution** — not evaluated yet");
  });

  it("stays within Discord's 1024-char field limit even with long dissent", () => {
    const long = [
      vote("sentinel", "bullish", 0.8, { isDissent: true, rationale: "s".repeat(3000) }),
      vote("research", "bearish", 0.6, { isDissent: true, rationale: "r".repeat(3000) }),
      vote("execution", null, null, { evaluated: false }),
    ];
    for (const value of Object.values(fieldsOf(record(long)))) {
      expect((value as string).length).toBeLessThanOrEqual(1024);
    }
  });
});
