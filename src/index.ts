#!/usr/bin/env node
import { preloadSecrets } from "./secrets/preload.js";

async function main(): Promise<void> {
  // Resolve 1Password references (if configured) before any config-dependent
  // import. With the default "env" provider this is a no-op.
  await preloadSecrets();

  // Dynamic imports so config.ts reads the environment only after secrets land.
  const { Command } = await import("commander");
  const { registerCommands } = await import("./interfaces/cli/commands.js");
  const { closeDb } = await import("./state/db.js");

  const program = new Command();

  program
    .name("market-sentinel")
    .description("AI-powered trading advisor with dual-model analysis")
    .version("0.1.0");

  registerCommands(program);

  program.hook("postAction", () => {
    closeDb();
  });

  await program.parseAsync(process.argv);
}

main().catch(async (err) => {
  console.error(err);
  // Best-effort flush without importing config at top level.
  try {
    const { closeDb } = await import("./state/db.js");
    closeDb();
  } catch {
    // ignore
  }
  process.exit(1);
});
