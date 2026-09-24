import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Discord authorization.
 *
 * The bot answers any mention in a shared server and any DM. Its tools read the
 * owner's positions (quantity and entry price), change the watchlist and
 * alerts, and spend real money on model calls — so "anyone who can see it" was
 * the wrong audience.
 */

const OWNER = "111111111111111111";
const STRANGER = "999999999999999999";

async function loadConfig(ownerIds: string | undefined) {
  vi.resetModules();
  if (ownerIds === undefined) delete process.env.DISCORD_OWNER_IDS;
  else process.env.DISCORD_OWNER_IDS = ownerIds;
  return import("../src/config.js");
}

const original = process.env.DISCORD_OWNER_IDS;
afterEach(() => {
  if (original === undefined) delete process.env.DISCORD_OWNER_IDS;
  else process.env.DISCORD_OWNER_IDS = original;
});

describe("with an allowlist configured", () => {
  it("admits the owner and refuses everyone else", async () => {
    const { isDiscordOwner, hasDiscordOwners } = await loadConfig(OWNER);

    expect(hasDiscordOwners()).toBe(true);
    expect(isDiscordOwner(OWNER)).toBe(true);
    expect(isDiscordOwner(STRANGER)).toBe(false);
    expect(isDiscordOwner("")).toBe(false);
  });

  it("accepts several ids, tolerating spaces and trailing commas", async () => {
    const { isDiscordOwner, hasDiscordOwners } = await loadConfig(` ${OWNER} , 222222222222222222 ,`);

    expect(hasDiscordOwners()).toBe(true);
    expect(isDiscordOwner(OWNER)).toBe(true);
    expect(isDiscordOwner("222222222222222222")).toBe(true);
    expect(isDiscordOwner(STRANGER)).toBe(false);
  });

  it("matches ids exactly — no prefix or substring match", async () => {
    const { isDiscordOwner } = await loadConfig(OWNER);

    expect(isDiscordOwner(OWNER.slice(0, -1))).toBe(false);
    expect(isDiscordOwner(OWNER + "1")).toBe(false);
  });
});

describe("with no allowlist configured", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("keeps working for everyone, so an upgrade doesn't lock the owner out", async () => {
    const { isDiscordOwner, hasDiscordOwners } = await loadConfig(undefined);

    expect(hasDiscordOwners()).toBe(false);
    expect(isDiscordOwner(STRANGER)).toBe(true);
  });

  it("treats an empty or comma-only value as unset", async () => {
    for (const value of ["", "   ", ",,"]) {
      const { hasDiscordOwners } = await loadConfig(value);
      expect(hasDiscordOwners(), JSON.stringify(value)).toBe(false);
    }
  });
});
