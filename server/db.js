import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, remote_id TEXT NOT NULL, name TEXT NOT NULL,
      secret TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'connected', checked_at TEXT,
      UNIQUE(provider, remote_id)
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), text TEXT NOT NULL,
      media_id TEXT, state TEXT NOT NULL DEFAULT 'draft', scheduled_at TEXT, timezone TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      remote_id TEXT, remote_url TEXT, container_id TEXT, error_code TEXT, error_message TEXT,
      claimed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS posts_due ON posts(state, scheduled_at);
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id), started_at TEXT NOT NULL,
      finished_at TEXT, outcome TEXT NOT NULL, error_code TEXT
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, scopes TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth (
      hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, expires INTEGER NOT NULL, candidates TEXT
    );
    CREATE TABLE IF NOT EXISTS requests (
      principal TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL,
      PRIMARY KEY(principal, key)
    );
  `);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
