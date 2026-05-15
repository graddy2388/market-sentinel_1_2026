import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { DB_PATH } from "../config.js";
import * as schema from "./schema.js";

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlDb: SqlJsDatabase | null = null;

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL CHECK(market IN ('crypto', 'stock', 'commodity')),
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  quantity REAL NOT NULL,
  entry_price REAL NOT NULL,
  entry_date TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  condition_type TEXT NOT NULL CHECK(condition_type IN ('price_above', 'price_below', 'pct_change', 'rsi_above', 'rsi_below')),
  threshold REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  triggered_at TEXT
);

CREATE TABLE IF NOT EXISTS analysis_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  claude_response TEXT,
  openai_response TEXT,
  indicators_snapshot TEXT
);

CREATE TABLE IF NOT EXISTS price_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export async function getDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const fileBuffer = readFileSync(DB_PATH);
    _sqlDb = new SQL.Database(fileBuffer);
  } else {
    _sqlDb = new SQL.Database();
  }

  _sqlDb.run(INIT_SQL);
  saveDb();

  _db = drizzle(_sqlDb, { schema });
  return _db;
}

export function saveDb() {
  if (!_sqlDb) return;
  const data = _sqlDb.export();
  const buffer = Buffer.from(data);
  writeFileSync(DB_PATH, buffer);
}

export function closeDb() {
  if (_sqlDb) {
    saveDb();
    _sqlDb.close();
    _sqlDb = null;
    _db = null;
  }
}
