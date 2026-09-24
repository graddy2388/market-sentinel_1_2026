import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";

/**
 * Dashboard request handling under hostile input.
 *
 * The headline case: `Cookie: ms_dash=%` made decodeURIComponent throw out of
 * an async HTTP handler with nothing to catch it, which takes the whole Node
 * process down — before any auth check, so no token needed.
 */

const TOKEN = "dashboard-token-16chars";

vi.mock("../src/config.js", () => ({
  appConfig: { DASHBOARD_TOKEN: TOKEN, DEFAULT_WATCHLIST: [] },
  hasDashboard: () => true,
}));
vi.mock("../src/data/providers.js", () => ({ fetch24hrCached: vi.fn(async () => null) }));
vi.mock("../src/state/db.js", () => ({ getDb: vi.fn(async () => ({ select: () => ({ from: () => ({ all: () => [] }) }) })) }));
vi.mock("../src/signals/store.js", () => ({ getAllLatestSignals: vi.fn(async () => []) }));
vi.mock("../src/interfaces/discord/chat.js", () => ({ handleChatMessage: vi.fn(async () => []) }));

const { handleDashboardRequest } = await import("../src/interfaces/web/dashboard.js");

interface Captured {
  status?: number;
  headers: Record<string, string | string[]>;
  body: string;
}

function mockReq(opts: { cookie?: string; method?: string; headers?: Record<string, string> } = {}) {
  return {
    method: opts.method ?? "GET",
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
    socket: {},
    on: () => {},
  } as unknown as IncomingMessage;
}

function mockRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { headers: {}, body: "" };
  const res = {
    writeHead: (status: number, headers?: Record<string, string | string[]>) => {
      captured.status = status;
      Object.assign(captured.headers, headers ?? {});
    },
    setHeader: (k: string, v: string) => {
      captured.headers[k] = v;
    },
    end: (chunk?: string) => {
      if (chunk) captured.body += chunk;
    },
    write: () => true,
    headersSent: false,
  } as unknown as ServerResponse;
  return { res, captured };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("malformed input can't take the process down", () => {
  it("survives a cookie with broken percent-encoding", async () => {
    const { res, captured } = mockRes();

    await expect(
      handleDashboardRequest(mockReq({ cookie: "ms_dash=%" }), res, new URL("http://x/api/snapshot"))
    ).resolves.toBe(true);

    expect(captured.status).toBe(401); // rejected, not crashed
  });

  it("survives other malformed encodings and junk cookies", async () => {
    for (const cookie of ["ms_dash=%E0%A4%A", "ms_dash=%ZZ", "=; ;;", "ms_dash", "a=%C0%80"]) {
      const { res } = mockRes();
      await expect(
        handleDashboardRequest(mockReq({ cookie }), res, new URL("http://x/api/snapshot"))
      ).resolves.toBe(true);
    }
  });

  it("still authorizes a valid cookie that needs decoding", async () => {
    const { res, captured } = mockRes();
    await handleDashboardRequest(
      mockReq({ cookie: `ms_dash=${encodeURIComponent(TOKEN)}` }),
      res,
      new URL("http://x/api/snapshot")
    );
    expect(captured.status).toBe(200);
  });
});

describe("authorization", () => {
  it("refuses API, events, and dashboard routes without a cookie", async () => {
    for (const path of ["/api/snapshot", "/events", "/dashboard", "/dashboard/app.js"]) {
      const { res, captured } = mockRes();
      await handleDashboardRequest(mockReq(), res, new URL(`http://x${path}`));
      expect(captured.status, path).toBe(401);
    }
  });

  it("refuses a token that is close but not equal", async () => {
    const { res, captured } = mockRes();
    await handleDashboardRequest(
      mockReq({ cookie: `ms_dash=${TOKEN.slice(0, -1)}x` }),
      res,
      new URL("http://x/api/snapshot")
    );
    expect(captured.status).toBe(401);
  });
});

describe("cookie flags", () => {
  it("is HttpOnly and SameSite=Strict, and omits Secure on plain HTTP", async () => {
    const { res, captured } = mockRes();
    await handleDashboardRequest(mockReq(), res, new URL(`http://x/dashboard?token=${TOKEN}`));
    const cookie = String(captured.headers["Set-Cookie"]);

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // Secure on plain HTTP would stop the browser sending it at all.
    expect(cookie).not.toContain("Secure");
  });

  it("adds Secure when the request arrived over TLS", async () => {
    const { res, captured } = mockRes();
    await handleDashboardRequest(
      mockReq({ headers: { "x-forwarded-proto": "https" } }),
      res,
      new URL(`http://x/dashboard?token=${TOKEN}`)
    );
    expect(String(captured.headers["Set-Cookie"])).toContain("Secure");
  });
});

describe("static file serving", () => {
  const authed = { cookie: `ms_dash=${TOKEN}` };

  // Note: the URL parser collapses "../" before the handler sees it, so these
  // mostly fall through to the main 404 rather than reaching the file code.
  // Asserted on the outcome that matters: no file content is ever returned.
  it("never serves anything outside the web directory", async () => {
    const attempts = [
      "../../../etc/passwd.html",
      "..%2f..%2fsecrets.html",
      "%2e%2e%2f%2e%2e%2fsecrets.html",
      "../package.json",
      "../public-evil/app.js",
      "....//....//secrets.html",
    ];
    for (const attempt of attempts) {
      const { res, captured } = mockRes();
      const handled = await handleDashboardRequest(
        mockReq(authed),
        res,
        new URL(`http://x/dashboard/${attempt}`)
      );
      if (handled) expect([403, 404], attempt).toContain(captured.status);
      expect(captured.status, attempt).not.toBe(200);
      expect(captured.body, attempt).not.toContain("root:");
    }
  });

  it("serves a whitelisted asset that stays inside the directory", async () => {
    const { res, captured } = mockRes();
    await handleDashboardRequest(mockReq(authed), res, new URL("http://x/dashboard/app.js"));
    expect(captured.status).toBe(200);
    expect(String(captured.headers["Content-Type"])).toContain("javascript");
  });

  it("refuses file types that aren't whitelisted assets", async () => {
    const { res, captured } = mockRes();
    await handleDashboardRequest(mockReq(authed), res, new URL("http://x/dashboard/data.db"));
    expect(captured.status).toBe(404);
  });
});
