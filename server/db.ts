// SQLite on the volume, through node:sqlite. One file, one process, WAL so pages read while a run writes.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, wallet TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce TEXT PRIMARY KEY, wallet TEXT NOT NULL, created_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  maker TEXT NOT NULL,
  sentence TEXT NOT NULL,
  spec TEXT,
  tests TEXT,
  status TEXT NOT NULL,
  fee_sig TEXT,
  ai_spent INTEGER NOT NULL DEFAULT 0,
  ai_budget INTEGER NOT NULL DEFAULT 0,
  runs_used INTEGER NOT NULL DEFAULT 0,
  last_run_id TEXT,
  agent_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  parent_id TEXT,
  remix TEXT,
  improve TEXT
);
CREATE INDEX IF NOT EXISTS drafts_maker ON drafts(maker, updated_at);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  maker TEXT,
  status TEXT NOT NULL,
  example INTEGER NOT NULL DEFAULT 0,
  spec TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  test_run_id TEXT,
  draft_id TEXT,
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pause_reason TEXT,
  coin_mint TEXT,
  coin_symbol TEXT,
  coin_name TEXT,
  coin_launch_sig TEXT,
  coin_launched_at INTEGER,
  coin_curve TEXT,
  buyback_bps INTEGER NOT NULL DEFAULT 0,
  has_image INTEGER NOT NULL DEFAULT 0,
  sentence TEXT,
  parent_id TEXT,
  royalty_bps INTEGER NOT NULL DEFAULT 0,
  fee_floor INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agents_maker ON agents(maker);

CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  draft_id TEXT,
  agent_id TEXT,
  spec_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  safety_total INTEGER NOT NULL DEFAULT 0,
  safety_passed INTEGER NOT NULL DEFAULT 0,
  task_total INTEGER NOT NULL DEFAULT 0,
  task_passed INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  publishable INTEGER NOT NULL DEFAULT 0,
  results TEXT NOT NULL DEFAULT '[]',
  ai_cost INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS quotes (
  nonce TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  agent_id TEXT,
  maker TEXT,
  meta TEXT,
  input_hash TEXT,
  total INTEGER NOT NULL,
  maker_amt INTEGER NOT NULL,
  ai_amt INTEGER NOT NULL,
  platform_amt INTEGER NOT NULL,
  recipients TEXT NOT NULL,
  ip TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_sig TEXT UNIQUE,
  claimed_at INTEGER,
  royalty_amt INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS quotes_expiry ON quotes(expires_at);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  quote_nonce TEXT UNIQUE NOT NULL,
  tx_sig TEXT UNIQUE NOT NULL,
  payer TEXT NOT NULL,
  total INTEGER NOT NULL,
  maker_amt INTEGER NOT NULL,
  ai_amt INTEGER NOT NULL,
  platform_amt INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  output TEXT,
  error TEXT,
  retry_token TEXT,
  retry_used INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  ai_cost INTEGER NOT NULL DEFAULT 0,
  slot INTEGER,
  server_sig TEXT NOT NULL DEFAULT '',
  buyback_bps INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  royalty_amt INTEGER NOT NULL DEFAULT 0,
  royalty_to TEXT,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS receipts_agent ON receipts(agent_id, created_at);
CREATE INDEX IF NOT EXISTS receipts_payer ON receipts(agent_id, payer);

CREATE TABLE IF NOT EXISTS ai_spend (
  day TEXT NOT NULL, scope TEXT NOT NULL, micros INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, scope)
);

CREATE TABLE IF NOT EXISTS buys (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  agent_id TEXT,
  mint TEXT NOT NULL,
  swap_sig TEXT UNIQUE NOT NULL,
  usdc_spent INTEGER NOT NULL,
  tokens_bought TEXT NOT NULL,
  burned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS burns (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  agent_id TEXT,
  mint TEXT NOT NULL,
  swap_sig TEXT,
  burn_sig TEXT UNIQUE NOT NULL,
  usdc_spent INTEGER NOT NULL DEFAULT 0,
  tokens_burned TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Every version an agent has had, as it was tested, with its signed test report. Rows are never changed afterwards.
CREATE TABLE IF NOT EXISTS agent_versions (
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  spec TEXT NOT NULL,
  test_run_id TEXT,
  draft_id TEXT,
  kind TEXT NOT NULL,
  sentence TEXT,
  summary TEXT,
  base_version INTEGER,
  changes TEXT NOT NULL DEFAULT '[]',
  maker TEXT,
  report_sig TEXT NOT NULL DEFAULT '',
  report_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, version)
);

-- The changelog: which version went live when, by publishing or by a rollback.
CREATE TABLE IF NOT EXISTS version_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  from_version INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS version_events_agent ON version_events(agent_id, at);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT
);
`;

// Columns added after the first release. A database made before them gets them on open; CREATE TABLE above
// already has them for a new one. Only ever add to this list, with a default, so old rows stay valid.
const ADDED: [table: string, column: string, decl: string][] = [
  ['agents', 'parent_id', 'TEXT'],
  ['agents', 'royalty_bps', 'INTEGER NOT NULL DEFAULT 0'],
  ['agents', 'fee_floor', 'INTEGER NOT NULL DEFAULT 0'],
  ['drafts', 'parent_id', 'TEXT'],
  ['drafts', 'remix', 'TEXT'],
  ['quotes', 'royalty_amt', 'INTEGER NOT NULL DEFAULT 0'],
  ['receipts', 'royalty_amt', 'INTEGER NOT NULL DEFAULT 0'],
  ['receipts', 'royalty_to', 'TEXT'],
  ['drafts', 'improve', 'TEXT'],
  ['quotes', 'version', 'INTEGER NOT NULL DEFAULT 0'],
  ['receipts', 'version', 'INTEGER NOT NULL DEFAULT 0'],
];

export function migrate(db: DB) {
  for (const [table, column, decl] of ADDED) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS agents_parent ON agents(parent_id);');
}

export function openDb(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'fabrica.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function openMemoryDb(): DB {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function kvGet(db: DB, k: string): string | null {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  return row?.v ?? null;
}

export function kvSet(db: DB, k: string, v: string) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

export function audit(db: DB, actor: string, action: string, detail: unknown) {
  db.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)').run(Date.now(), actor, action, JSON.stringify(detail ?? null));
}

export const now = () => Date.now();
export const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
