import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'product', 'engineer')),
    password_hash TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)",
  `CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('clarification', 'comment')),
    user_id INTEGER NOT NULL REFERENCES users (id),
    body TEXT NOT NULL,
    item_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS entries_item ON entries (item_id, id)",
  // The clarification record is the deliverable: it can only grow.
  `CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries
    BEGIN SELECT RAISE(ABORT, 'entries are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries
    BEGIN SELECT RAISE(ABORT, 'entries are append-only'); END`,
];

/** Opens the project database, creating the file and tables on first use. */
export async function openDatabase(path: string): Promise<Client> {
  await mkdir(dirname(path), { recursive: true });
  const client = createClient({ url: pathToFileURL(path).href });
  try {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.execute("PRAGMA foreign_keys = ON");
    await client.batch(SCHEMA, "write");
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
