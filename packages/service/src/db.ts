import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * SQLite persistence for the event indexer.
 *
 * Schema notes:
 * - `events` holds one row per indexed log. The UNIQUE(block_hash, log_index)
 *   constraint makes re-scanning the same block range idempotent: the indexer
 *   uses INSERT OR IGNORE, so a crash/restart or overlapping tick never
 *   duplicates events.
 * - `deal_id` is NULL for deal-agnostic admin events (TreasuryUpdated,
 *   FeeBpsUpdated); per-deal queries simply filter it out.
 * - `indexer_meta` keeps the last fully-scanned block so the indexer resumes
 *   where it left off across restarts.
 */
export function openDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id INTEGER,
      milestone_index INTEGER,
      event_name TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      args TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      UNIQUE (block_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_events_deal ON events (deal_id, block_number, log_index);
    CREATE TABLE IF NOT EXISTS indexer_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export interface StoredEvent {
  name: string;
  args: Record<string, unknown>;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  indexedAt: string;
}

/**
 * JSON.stringify throws on BigInt ("Do not know how to serialize a BigInt"),
 * and decoded event args are BigInt-heavy (uint256 scalars and uint256[]
 * arrays like milestoneAmounts). Emit BigInt as decimal strings at the insert
 * boundary so every arg round-trips through the TEXT `args` column losslessly
 * for JSON clients, regardless of which caller produced the event.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function insertEvent(db: Database.Database, ev: StoredEvent): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO events
        (deal_id, milestone_index, event_name, block_number, block_hash, tx_hash, log_index, args, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ev.args.dealId === undefined ? null : Number(ev.args.dealId),
      ev.args.milestoneIndex === undefined ? null : Number(ev.args.milestoneIndex),
      ev.name,
      ev.blockNumber,
      ev.blockHash,
      ev.txHash,
      ev.logIndex,
      JSON.stringify(ev.args, bigintReplacer),
      ev.indexedAt
    );
  return info.changes > 0;
}

export function listDealEvents(db: Database.Database, dealId: string): StoredEvent[] {
  const rows = db
    .prepare(
      `SELECT event_name, args, block_number, block_hash, tx_hash, log_index, indexed_at
       FROM events WHERE deal_id = ? ORDER BY block_number, log_index`
    )
    .all(Number(dealId)) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    name: row.event_name as string,
    args: JSON.parse(row.args as string) as Record<string, unknown>,
    blockNumber: row.block_number as number,
    blockHash: row.block_hash as string,
    txHash: row.tx_hash as string,
    logIndex: row.log_index as number,
    indexedAt: row.indexed_at as string,
  }));
}

export function getLastScannedBlock(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM indexer_meta WHERE key = 'last_scanned_block'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : -1;
}

export function setLastScannedBlock(db: Database.Database, block: number): void {
  db.prepare(
    `INSERT INTO indexer_meta (key, value) VALUES ('last_scanned_block', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(block));
}
