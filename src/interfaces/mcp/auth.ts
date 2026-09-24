/**
 * MCP endpoint authorization.
 *
 * Extracted from server.ts so it can be tested directly: importing server.ts
 * starts the server.
 */
import { timingSafeEqual } from "node:crypto";
import { appConfig, hasMcpAuth } from "../../config.js";

// ---------------------------------------------------------------------------
// MCP authentication
//
// The image listens on 0.0.0.0 and compose publishes 3100, so /mcp is reachable
// from the whole network. Its tools read the portfolio, write to the database,
// and each analysis fires the full model council — so it must not be open.
//
// With MCP_AUTH_TOKEN set, every /mcp request needs "Authorization: Bearer
// <token>". Without it, only the container itself (loopback) may call /mcp, so
// an unconfigured deployment is closed rather than exposed. /health stays open
// for Docker's healthcheck.
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopback(address: string | undefined): boolean {
  return !!address && LOOPBACK.has(address);
}

/** Constant-time bearer comparison; length is checked first (lengths aren't secret). */
function bearerMatches(header: string | undefined): boolean {
  const secret = appConfig.MCP_AUTH_TOKEN;
  if (!secret) return false;
  const prefix = "bearer ";
  if (!header || header.length <= prefix.length) return false;
  if (header.slice(0, prefix.length).toLowerCase() !== prefix) return false;
  const supplied = Buffer.from(header.slice(prefix.length).trim());
  const expected = Buffer.from(secret);
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

/** Whether this request may use /mcp. */
export function isMcpAuthorized(
  authHeader: string | undefined,
  remoteAddress: string | undefined
): boolean {
  if (hasMcpAuth()) return bearerMatches(authHeader);
  // No token configured: the container may talk to itself, nobody else may.
  return isLoopback(remoteAddress);
}
