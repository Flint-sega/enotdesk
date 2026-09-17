import { DatabaseSync } from 'node:sqlite';

// Последняя версия схемы; растёт с каждым версионированным шагом (A01 и далее).
export const SCHEMA_VERSION = 2;

// Версионированные шаги схемы (A01): каждая база — старая или новая — проходит
// недостающие шаги по порядку, версия хранится в таблице schema_version.
// Шаги идемпотентны (CREATE IF NOT EXISTS / ALTER в try), поэтому базы,
// созданные до введения версий, поднимаются без потери данных.
const MIGRATIONS = [
  {
    version: 1,
    up: (db) => {
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
      // миграция для существующих баз: адрес создателя регистрации (потолок waiting-сессий на IP)
      try { db.exec('ALTER TABLE sessions ADD COLUMN created_ip TEXT'); } catch { /* колонка уже есть */ }
    },
  },
  {
    // A01: unattended-машины — onboarding-коды, группа строкой, PIN;
    // сеансы получают связь с машиной (host-токен сеанса = токен машины).
    // PIN и токен машины хранятся ТОЛЬКО хешами.
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS machines (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          group_name TEXT NOT NULL DEFAULT '',
          os TEXT NOT NULL DEFAULT '',
          agent_version TEXT NOT NULL DEFAULT '',
          pin_hash TEXT,
          onboarding_code_hash TEXT UNIQUE,
          onboarding_expires_at TEXT NOT NULL,
          onboarding_used_at TEXT,
          agent_token_hash TEXT UNIQUE,
          revoked_at TEXT,
          last_seen_at TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          created_by TEXT,
          created_at TEXT NOT NULL
        );
      `);
      try { db.exec('ALTER TABLE sessions ADD COLUMN machine_id TEXT'); } catch { /* колонка уже есть */ }
    },
  },
];

function schemaVersion(db) {
  try {
    const row = db.prepare('SELECT version FROM schema_version').get();
    return row ? row.version : 0;
  } catch { return 0; } // базы до A01: таблицы версий ещё нет
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  for (const step of MIGRATIONS) {
    if (step.version <= schemaVersion(db)) continue;
    db.exec('BEGIN');
    try {
      step.up(db);
      db.prepare('DELETE FROM schema_version').run();
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(step.version);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // регистронезависимый поиск по кириллице: встроенный LIKE/LOWER знают только ASCII
  db.function('ulower', (s) => (s == null ? '' : String(s).toLowerCase()));
  migrate(db);
  return db;
}

export function endLiveSessions(db, reason) {
  const now = new Date().toISOString();
  const r = db.prepare(
    "UPDATE sessions SET state='ended', ended_at=?, end_reason=? WHERE state != 'ended'"
  ).run(now, reason);
  return r.changes;
}

// Ретенция (гигиена): истёкшие токены старше 7 дней, приглашения, истёкшие
// более 30 дней назад (использованные, отозванные или просто истёкшие — они
// непригодны в любом случае), завершённые сеансы старше retentionDays.
// Вызывается домом-уборщиком раз в час и тестируется напрямую.
export function runRetention(db, { retentionDays = 90, nowMs = Date.now() } = {}) {
  const cut = (days) => new Date(nowMs - days * 86_400_000).toISOString();
  const tokens = db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(cut(7)).changes;
  const invites = db.prepare('DELETE FROM invites WHERE expires_at <= ?').run(cut(30)).changes;
  let sessions = 0;
  if (retentionDays > 0) {
    sessions = db.prepare("DELETE FROM sessions WHERE state='ended' AND ended_at < ?").run(cut(retentionDays)).changes;
  }
  return { tokens, invites, sessions };
}

export function auditLog(db, actorId, action, targetId, detail = {}) {
  db.prepare(
    'INSERT INTO audit (actor_id, action, target_id, detail, created_at) VALUES (?,?,?,?,?)'
  ).run(actorId, action, targetId, JSON.stringify(detail), new Date().toISOString());
}
