import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, runRetention } from '../db.mjs';
import { backupDb } from '../backup.mjs';

// Ретенция — гигиена БД: чистим только то, что заведомо завершено и старо.
// Ожидания по дням заданы в тесте, не в коде под тестом.

function seed(db) {
  db.prepare(`INSERT INTO users (id, login, name, role, active, password, created_at)
              VALUES ('u1','ops','Опс','admin',1,'x','2020-01-01')`).run();
  // токены: истёкший 10 дней назад (удалить) и 1 день назад (оставить)
  db.prepare(`INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at)
              VALUES ('old','u1',?,'2020-01-01')`).run(daysAgoIso(10));
  db.prepare(`INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at)
              VALUES ('fresh','u1',?,'2020-01-01')`).run(daysAgoIso(-1));
  // приглашения: использованное 40 дней назад (удалить), использованное 10 дней назад (оставить),
  // активное будущее (оставить), просто истёкшее 40 дней назад (удалить — непригодно в любом случае)
  db.prepare(`INSERT INTO invites (id, role, token_hash, expires_at, used_at, created_by, created_at)
              VALUES ('i-old','operator','h1',?,?,'u1','2020-01-01')`).run(daysAgoIso(40), daysAgoIso(41));
  db.prepare(`INSERT INTO invites (id, role, token_hash, expires_at, used_at, created_by, created_at)
              VALUES ('i-recent','operator','h2',?,?,'u1','2020-01-01')`).run(daysAgoIso(10), daysAgoIso(11));
  db.prepare(`INSERT INTO invites (id, role, token_hash, expires_at, created_by, created_at)
              VALUES ('i-active','operator','h3',?,'u1','2020-01-01')`).run(daysAgoIso(-1));
  db.prepare(`INSERT INTO invites (id, role, token_hash, expires_at, created_by, created_at)
              VALUES ('i-stale','operator','h4',?,'u1','2020-01-01')`).run(daysAgoIso(40));
  // сеансы: завершённый 100 дней назад (удалить при 90), завершённый 10 дней назад (оставить)
  seedSession(db, 's-old', 100);
  seedSession(db, 's-recent', 10);
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function seedSession(db, id, endedDaysAgo) {
  db.prepare(`INSERT INTO sessions (id, password_hash, host_token_hash, state, created_at, lease_expires_at, ended_at, end_reason)
              VALUES (?, 'h','h','ended','2020-01-01','2020-01-01',?, 'ended')`)
    .run(id, daysAgoIso(endedDaysAgo));
}

test('retention: старые токены/приглашения/сеансы удаляются, свежее — остаётся', () => {
  const db = openDb(':memory:');
  seed(db);

  const r = runRetention(db, { retentionDays: 90 });
  assert.ok(r.tokens === 1 && r.invites === 2 && r.sessions === 1, JSON.stringify(r));

  assert.equal(db.prepare("SELECT count(*) c FROM auth_tokens WHERE token_hash='old'").get().c, 0);
  assert.equal(db.prepare("SELECT count(*) c FROM auth_tokens WHERE token_hash='fresh'").get().c, 1);
  assert.equal(db.prepare("SELECT count(*) c FROM invites WHERE id='i-old'").get().c, 0);
  assert.equal(db.prepare("SELECT count(*) c FROM invites WHERE id='i-stale'").get().c, 0, 'истёкшее неиспользованное приглашение тоже непригодно');
  assert.equal(db.prepare("SELECT count(*) c FROM invites WHERE id='i-recent'").get().c, 1);
  assert.equal(db.prepare("SELECT count(*) c FROM invites WHERE id='i-active'").get().c, 1);
  assert.equal(db.prepare("SELECT count(*) c FROM sessions WHERE id='s-old'").get().c, 0);
  assert.equal(db.prepare("SELECT count(*) c FROM sessions WHERE id='s-recent'").get().c, 1);
  db.close();
});

test('retention: retentionDays=0 — сеансы хранятся вечно, остальная гигиена работает', () => {
  const db = openDb(':memory:');
  seed(db);
  const r = runRetention(db, { retentionDays: 0 });
  assert.equal(r.sessions, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 2);
  assert.equal(r.tokens, 1, 'токены чистятся независимо от ретенции сеансов');
  db.close();
});

test('retention: живой (незавершённый) сеанс не удаляется даже если он старше лимита', () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO sessions (id, password_hash, host_token_hash, state, created_at, lease_expires_at)
              VALUES ('s-live','h','h','approved','2020-01-01','2020-01-01')`).run();
  const r = runRetention(db, { retentionDays: 90 });
  assert.equal(r.sessions, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 1);
  db.close();
});

test('backup: VACUUM INTO создаёт читаемый дамп, ретенция выметает старые', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-bak-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const dbPath = path.join(dir, 'src.db');
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO users (id, login, name, role, active, password, created_at)
              VALUES ('u1','ops','Опс','admin',1,'x','2020-01-01')`).run();
  db.close();

  // два старых дампа — при keep=2 (свежий + один) старейший должен уйти
  fs.writeFileSync(path.join(dir, 'enotdesk-2020-01-01T000000Z.db'), 'x');
  fs.writeFileSync(path.join(dir, 'enotdesk-2021-01-01T000000Z.db'), 'x');

  const r = backupDb(dbPath, dir, { keep: 2, stamp: new Date('2026-01-02T03:04:05Z') });
  assert.equal(path.basename(r.file), 'enotdesk-2026-01-02T030405Z.db');
  assert.deepEqual(r.removed, ['enotdesk-2020-01-01T000000Z.db']);

  // дамп — полноценная база: открывается и содержит данные
  const copy = openDb(r.file);
  assert.equal(copy.prepare('SELECT count(*) c FROM users').get().c, 1);
  copy.close();
});
