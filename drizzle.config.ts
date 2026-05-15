import { defineConfig } from "drizzle-kit";
import { join } from "path";
import { homedir } from "os";

export default defineConfig({
  schema: "./src/state/schema.ts",
  out: "./src/state/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: join(homedir(), ".market-sentinel", "data.db"),
  },
});
