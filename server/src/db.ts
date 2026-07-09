import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DB_PATH = process.env.SHITTY_CHAT_DB ?? join(process.cwd(), "data", "shitty-chat.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS user_account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  google_sub TEXT,
  login_token TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  auth_token_hash TEXT UNIQUE NOT NULL,
  master_identity_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_agent (
  room_id TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  display_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (room_id, identity_hash)
);
CREATE TABLE IF NOT EXISTS room_usage (
  room_id TEXT NOT NULL,
  day TEXT NOT NULL,
  asks INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, day)
);
`);

export interface UserRow {
  id: number;
  email: string;
  google_sub: string | null;
  login_token: string;
}

export interface RoomRow {
  id: string;
  user_id: number;
  name: string;
  auth_token_hash: string;
  master_identity_hash: string | null;
  created_at: number;
}

export interface RoomAgentRow {
  room_id: string;
  identity_hash: string;
  display_id: string;
  name: string;
  platform: string;
  state: string;
  last_seen: number;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function bumpUsage(roomId: string, asks: number, bytes: number) {
  db.prepare(
    `INSERT INTO room_usage (room_id, day, asks, bytes) VALUES (?, ?, ?, ?)
     ON CONFLICT(room_id, day) DO UPDATE SET asks = asks + excluded.asks, bytes = bytes + excluded.bytes`,
  ).run(roomId, today(), asks, bytes);
}

export function asksToday(roomId: string): number {
  const row = db
    .prepare(`SELECT asks FROM room_usage WHERE room_id = ? AND day = ?`)
    .get(roomId, today()) as { asks: number } | undefined;
  return row?.asks ?? 0;
}
