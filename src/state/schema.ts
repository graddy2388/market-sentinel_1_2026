import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";

export const watchlist = sqliteTable("watchlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  market: text("market", { enum: ["crypto", "stock", "commodity"] }).notNull(),
  addedAt: text("added_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const positions = sqliteTable("positions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  quantity: real("quantity").notNull(),
  entryPrice: real("entry_price").notNull(),
  entryDate: text("entry_date")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  notes: text("notes"),
});

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  conditionType: text("condition_type", {
    enum: ["price_above", "price_below", "pct_change", "rsi_above", "rsi_below"],
  }).notNull(),
  threshold: real("threshold").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  triggeredAt: text("triggered_at"),
});

export const analysisHistory = sqliteTable("analysis_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  timestamp: text("timestamp")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  claudeResponse: text("claude_response"),
  openaiResponse: text("openai_response"),
  indicatorsSnapshot: text("indicators_snapshot"),
});

export const priceCache = sqliteTable("price_cache", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  timestamp: text("timestamp").notNull(),
  open: real("open").notNull(),
  high: real("high").notNull(),
  low: real("low").notNull(),
  close: real("close").notNull(),
  volume: real("volume").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
