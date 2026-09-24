import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * MCP endpoint authorization.
 *
 * Before this, /mcp was open to the whole network: from another machine on the
 * LAN, with no credentials, you could list the tools, read the owner's alerts
 * and positions, write to the database, and fire the 7-model council 120 times
 * a minute. The image listens on 0.0.0.0, so "it's only my home network" was
 * the only thing standing in the way.
 */

const TOKEN = "s3cret-token-at-least-16";
let configuredToken: string | undefined = TOKEN;

vi.mock("../src/config.js", () => ({
  get appConfig() {
    return { MCP_AUTH_TOKEN: configuredToken };
  },
  hasMcpAuth: () => !!configuredToken,
}));

const { isMcpAuthorized, isLoopback } = await import("../src/interfaces/mcp/auth.js");

const LAN = "192.168.4.55";

describe("with MCP_AUTH_TOKEN set", () => {
  beforeEach(() => {
    configuredToken = TOKEN;
  });

  it("accepts the right bearer token from anywhere", () => {
    expect(isMcpAuthorized(`Bearer ${TOKEN}`, LAN)).toBe(true);
  });

  it("accepts the scheme case-insensitively, as RFC 7235 requires", () => {
    expect(isMcpAuthorized(`bearer ${TOKEN}`, LAN)).toBe(true);
    expect(isMcpAuthorized(`BEARER ${TOKEN}`, LAN)).toBe(true);
  });

  it("refuses a missing, empty, or malformed header", () => {
    expect(isMcpAuthorized(undefined, LAN)).toBe(false);
    expect(isMcpAuthorized("", LAN)).toBe(false);
    expect(isMcpAuthorized("Bearer", LAN)).toBe(false);
    expect(isMcpAuthorized("Bearer ", LAN)).toBe(false);
    expect(isMcpAuthorized(TOKEN, LAN)).toBe(false); // no scheme
    expect(isMcpAuthorized(`Basic ${TOKEN}`, LAN)).toBe(false);
  });

  it("refuses a wrong token, including a prefix of the real one", () => {
    expect(isMcpAuthorized("Bearer wrong-token-16chars", LAN)).toBe(false);
    expect(isMcpAuthorized(`Bearer ${TOKEN.slice(0, -1)}`, LAN)).toBe(false);
    expect(isMcpAuthorized(`Bearer ${TOKEN}x`, LAN)).toBe(false);
  });

  it("requires the token even from loopback, once one is configured", () => {
    expect(isMcpAuthorized(undefined, "127.0.0.1")).toBe(false);
  });
});

describe("with no token configured", () => {
  beforeEach(() => {
    configuredToken = undefined;
  });

  it("allows the container to talk to itself", () => {
    expect(isMcpAuthorized(undefined, "127.0.0.1")).toBe(true);
    expect(isMcpAuthorized(undefined, "::1")).toBe(true);
    expect(isMcpAuthorized(undefined, "::ffff:127.0.0.1")).toBe(true);
  });

  it("refuses everyone else — an unconfigured deployment is closed, not open", () => {
    expect(isMcpAuthorized(undefined, LAN)).toBe(false);
    expect(isMcpAuthorized(`Bearer ${TOKEN}`, LAN)).toBe(false);
    expect(isMcpAuthorized(undefined, undefined)).toBe(false);
  });
});

describe("isLoopback", () => {
  it("recognises loopback forms and nothing else", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    // Not loopback: addresses that merely start the same way.
    expect(isLoopback("127.0.0.10")).toBe(false);
    expect(isLoopback("192.168.4.32")).toBe(false);
    expect(isLoopback("::ffff:192.168.4.32")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
