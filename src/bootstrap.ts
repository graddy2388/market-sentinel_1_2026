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

async function main(): Promise<void> {
  await preloadSecrets();
  // Dynamic import so config.ts reads the environment only after secrets land.
  await import("./interfaces/mcp/server.js");
}

main().catch((err) => {
  console.error("[bootstrap] Startup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
