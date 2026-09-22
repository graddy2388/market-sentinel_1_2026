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

export const signalHistory = sqliteTable("signal_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  call: text("call", {
    enum: ["STRONG_BUY", "BUY", "HOLD", "SELL", "STRONG_SELL"],
  }).notNull(),
  conviction: real("conviction").notNull(),
  price: real("price").notNull(),
  entry: real("entry").notNull(),
  stop: real("stop").notNull(),
  target: real("target").notNull(),
  technicalDirection: text("technical_direction").notNull(),
  aiDirection: text("ai_direction"),
  agreement: integer("agreement", { mode: "boolean" }).notNull(),
  // Full GradedSignal JSON for flexible reads (dashboard / embeds)
  payload: text("payload").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ---------------------------------------------------------------------------
// Multi-agent decision records (Phase B: logged, never executed)
//
// One trade_proposals row per orchestrator run, with every agent's vote and
// the dialogue turns alongside. `payload` holds the full DecisionRecord JSON;
// the other columns exist so the dashboard can filter and sort without parsing.
// ---------------------------------------------------------------------------

export const tradeProposals = sqliteTable("trade_proposals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  /** BUY or SELL; null when there was nothing actionable to propose. */
  action: text("action", { enum: ["BUY", "SELL"] }),
  proposedCall: text("proposed_call"),
  status: text("status", {
    enum: ["no_action", "vetoed", "below_threshold", "eligible", "error"],
  }).notNull(),
  confidence: real("confidence"),
  preDialogueConfidence: real("pre_dialogue_confidence"),
  threshold: real("threshold").notNull(),
  entry: real("entry"),
  stop: real("stop"),
  target: real("target"),
  trigger: text("trigger").notNull(),
  vetoReason: text("veto_reason"),
  summary: text("summary").notNull(),
  payload: text("payload").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const agentVotes = sqliteTable("agent_votes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  proposalId: integer("proposal_id").notNull(),
  agent: text("agent", { enum: ["sentinel", "research", "execution"] }).notNull(),
  direction: text("direction"),
  confidence: real("confidence"),
  rationale: text("rationale").notNull(),
  isDissent: integer("is_dissent", { mode: "boolean" }).notNull(),
  veto: text("veto"),
});

export const dialogueTranscripts = sqliteTable("dialogue_transcripts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  proposalId: integer("proposal_id").notNull(),
  round: integer("round").notNull(),
  agent: text("agent", { enum: ["sentinel", "research"] }).notNull(),
  message: text("message").notNull(),
  confidenceBefore: real("confidence_before"),
  confidenceAfter: real("confidence_after"),
});
