import { DatabaseSync } from 'node:sqlite';

// Схема hub.db — собственная БД хаба, независимая от enotdesk.db.
export const SCHEMA_VERSION = 3;

// Версионированные шаги схемы (тот же паттерн, что server/db.mjs): каждая база
// проходит недостающие шаги по порядку, шаги идемпотентны.
const MIGRATIONS = [
  {
    // Каркас: SSO-сессии хаба. sid хранится только хешем (sha256), bearer —
    // шифротекстом AES-256-GCM от ENOT_SECRET_KEY (см. hub/auth.mjs; без ключа —
    // как webhook-секрет в server/: хранится как есть, но не покидает модуль auth).
    // user_json — внешний объект пользователя EnotDesk {id,login,name,role,...}.
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS hub_sessions (
          sid_hash TEXT PRIMARY KEY,
          bearer TEXT NOT NULL,
          user_json TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Тикеты (T02): контакты, треды (channel chat|email|manual; status
    // open|pending|resolved), сообщения (author contact|agent|system; type
    // text|card|note), canned-ответы (#шорткат, приватные и общие), присутствие
    // агентов. Секретов нет — тексты посетителей, индексы под инбокс-фильтры.
    // rating — оценка чата контактом (1..5), UI-виджет — T03.
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          visitor_id TEXT,
          email TEXT,
          name TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL CHECK (channel IN ('chat','email','manual')),
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved')),
          subject TEXT NOT NULL,
          contact_id TEXT REFERENCES contacts(id),
          assignee_id TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          rating INTEGER,
          last_activity_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_threads_status_activity ON threads(status, last_activity_at DESC);
        CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel, last_activity_at DESC);
        CREATE INDEX IF NOT EXISTS idx_threads_assignee ON threads(assignee_id, last_activity_at DESC);
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id),
          author TEXT NOT NULL CHECK (author IN ('contact','agent','system')),
          type TEXT NOT NULL CHECK (type IN ('text','card','note')),
          body TEXT NOT NULL,
          agent_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at, id);
        CREATE TABLE IF NOT EXISTS canned (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('private','shared')),
          shortcut TEXT NOT NULL,
          text TEXT NOT NULL,
          agent_id TEXT,
          created_at TEXT NOT NULL
        );
        -- уникальность шортката: в shared — глобально, в private — у одного агента
        CREATE UNIQUE INDEX IF NOT EXISTS idx_canned_shared ON canned(shortcut) WHERE scope = 'shared';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_canned_private ON canned(shortcut, agent_id) WHERE scope = 'private';
        CREATE TABLE IF NOT EXISTS agent_presence (
          agent_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('online','away','offline')),
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Виджет (T03): настройки виджета (allowlist origins, consent-гейт, ссылка
    // на политику) — одна строка key='widget', JSON; факт согласия посетителя
    // (GDPR) — consent_at в контактах. Секретов нет: origins и ссылка не тайна.
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS hub_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.exec('ALTER TABLE contacts ADD COLUMN consent_at TEXT');
    },
  },
];

function schemaVersion(db) {
  try {
    const row = db.prepare('SELECT version FROM schema_version').get();
    return row ? row.version : 0;
  } catch { return 0; }
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

export function openHubDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}
