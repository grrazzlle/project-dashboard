import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind        TEXT NOT NULL DEFAULT 'web',
      url         TEXT NOT NULL DEFAULT '',
      repo_url    TEXT NOT NULL DEFAULT '',
      command     TEXT NOT NULL DEFAULT '',
      cwd         TEXT NOT NULL DEFAULT '',
      emoji       TEXT NOT NULL DEFAULT '',
      tags        TEXT NOT NULL DEFAULT '',
      notes       TEXT NOT NULL DEFAULT '',
      pinned      INTEGER NOT NULL DEFAULT 0,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_run_at TEXT
    );
  `);
  return db;
}
