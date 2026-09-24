#!/usr/bin/env node
/**
 * Server entrypoint.
 *
 * Resolves secrets (if SECRETS_PROVIDER=onepassword) into process.env BEFORE
 * the MCP server — and its transitive config.ts import — evaluates. With the
 * default "env" provider this is a near-instant no-op, so behavior is identical
 * to running the server directly.
 */
import { preloadSecrets } from "./secrets/preload.js";

// Defence in depth for the request path: Node kills the process on an
// unhandled rejection, so a single bad request used to be a remote restart.
// Handlers are in place before anything can throw.
process.on("unhandledRejection", (reason) => {
  console.error("[bootstrap] Unhandled rejection:", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  // State may be inconsistent after this, so exit and let the container restart
  // — but say why first, instead of dying silently.
  console.error("[bootstrap] Uncaught exception:", err instanceof Error ? err.stack : err);
  process.exit(1);
});

async function main(): Promise<void> {
  await preloadSecrets();
  // Dynamic import so config.ts reads the environment only after secrets land.
  await import("./interfaces/mcp/server.js");
}

main().catch((err) => {
  console.error("[bootstrap] Startup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
