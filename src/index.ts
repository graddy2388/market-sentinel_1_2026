#!/usr/bin/env node
import { Command } from "commander";
import { registerCommands } from "./interfaces/cli/commands.js";
import { closeDb } from "./state/db.js";

const program = new Command();

program
  .name("market-sentinel")
  .description("AI-powered trading advisor with dual-model analysis")
  .version("0.1.0");

registerCommands(program);

program.hook("postAction", () => {
  closeDb();
});

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  closeDb();
  process.exit(1);
});
