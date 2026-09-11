import { DatabaseSync } from 'node:sqlite';

export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // регистронезависимый поиск по кириллице: встроенный LIKE/LOWER знают только ASCII
  db.function('ulower', (s) => (s == null ? '' : String(s).toLowerCase()));
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      login TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','operator','auditor')),
      active INTEGER NOT NULL DEFAULT 1,
      password TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('admin','operator','auditor')),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      host_token_hash TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting',
      contact_id TEXT,
      operator_id TEXT,
      claim_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      end_reason TEXT,
      lease_expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT,
      action TEXT NOT NULL,
      target_id TEXT,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

export function endLiveSessions(db, reason) {
  const now = new Date().toISOString();
  const r = db.prepare(
    "UPDATE sessions SET state='ended', ended_at=?, end_reason=? WHERE state != 'ended'"
  ).run(now, reason);
  return r.changes;
}

export function auditLog(db, actorId, action, targetId, detail = {}) {
  db.prepare(
    'INSERT INTO audit (actor_id, action, target_id, detail, created_at) VALUES (?,?,?,?,?)'
  ).run(actorId, action, targetId, JSON.stringify(detail), new Date().toISOString());
}
