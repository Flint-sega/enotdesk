import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runHubRetention } from '../db.mjs';

// Ретенция хаба (аудит 12.10, P2): hub_sessions (внутри шифро-bearer) и
// email_seen росли бесконечно. Грэйс сессий — сутки после истечения TTL;
// email_seen — окно дедупа поллера (90 дней по умолчанию).

function memDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE hub_sessions (sid_hash TEXT PRIMARY KEY, bearer TEXT NOT NULL,
      user_json TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE email_seen (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  return db;
}

const iso = (ms) => new Date(ms).toISOString();

test('hub retention: истёкшие+грэйс сессии и старые email_seen удаляются, свежие живут', () => {
  const db = memDb();
  const now = Date.parse('2026-10-12T12:00:00Z');
  const ins = db.prepare('INSERT INTO hub_sessions (sid_hash, bearer, user_json, expires_at, created_at) VALUES (?,?,?,?,?)');
  ins.run('dead', 'b', '{}', iso(now - 3 * 86_400_000), iso(now - 4 * 86_400_000)); // истёк давно → вон
  ins.run('grace', 'b', '{}', iso(now - 2 * 3_600_000), iso(now - 14 * 3_600_000)); // истёк 2ч назад — в грэйсе
  ins.run('live', 'b', '{}', iso(now + 3_600_000), iso(now - 3_600_000)); // живой
  const insMail = db.prepare('INSERT INTO email_seen (message_id, thread_id, created_at) VALUES (?,?,?)');
  insMail.run('old-mail', 't1', iso(now - 100 * 86_400_000)); // > 90 дней → вон
  insMail.run('fresh-mail', 't1', iso(now - 86_400_000)); // вчера — жив

  const r = runHubRetention(db, { nowMs: now });
  assert.deepEqual(r, { sessions: 1, emails: 1 }, 'по одной строке каждого вида');
  const sids = db.prepare('SELECT sid_hash FROM hub_sessions ORDER BY sid_hash').all().map((x) => x.sid_hash);
  assert.deepEqual(sids, ['grace', 'live'], 'грэйс и живые остаются, мёртвая сессия удалена');
  const mails = db.prepare('SELECT message_id FROM email_seen').all().map((x) => x.message_id);
  assert.deepEqual(mails, ['fresh-mail'], 'старый Message-ID удалён, свежий жив');
});

test('hub retention: пустая база и дефолты не падают, грэйс/emailDays настраиваются', () => {
  const db = memDb();
  assert.deepEqual(runHubRetention(db), { sessions: 0, emails: 0 }, 'пусто — нули');
  db.prepare('INSERT INTO hub_sessions (sid_hash, bearer, user_json, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run('just-expired', 'b', '{}', iso(Date.now() - 1000), iso(Date.now() - 86_400_000));
  const strict = runHubRetention(db, { sessionGraceMs: 0 }); // без грэйса — сразу вон
  assert.equal(strict.sessions, 1, 'нулевой грэйс сносит сразу по истечении');
});
