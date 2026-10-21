import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startServer, api, adminLogin, tmpDb } from './util.mjs';
import { openDb, runRetention, setSetting, auditLog, isSecurityAction, SCHEMA_VERSION } from '../db.mjs';

// ADR 0034: сроки хранения, очистка журнала и истории, выключатель журнала, архив приглашений.

async function setup(t) {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  const join = async (role, login) => {
    const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role } });
    await api(base, 'POST', '/invites/accept', { body: { token: inv.json.token, login, name: login, password: `пароль-${login}-123` } });
    return (await api(base, 'POST', '/auth/login', { body: { login, password: `пароль-${login}-123` } })).json;
  };
  const op = await join('operator', 'опер');
  const aud = await join('auditor', 'аудитор');
  return { base, dbPath, admin, op, aud };
}

const actions = async (base, token) =>
  (await api(base, 'GET', '/audit?limit=100', { token })).json.items.map((a) => a.action);

test('retention settings: чтение admin/auditor, запись только admin, проверка значений', async (t) => {
  const { base, admin, op, aud } = await setup(t);

  const def = await api(base, 'GET', '/settings/retention', { token: aud.token });
  assert.equal(def.status, 200);
  assert.deepEqual(
    { auditEnabled: def.json.auditEnabled, auditDays: def.json.auditDays, historyDays: def.json.historyDays },
    { auditEnabled: true, auditDays: 0, historyDays: 90 },
  );
  assert.ok(def.json.choices.includes(365));
  assert.equal((await api(base, 'GET', '/settings/retention', { token: op.token })).status, 403);

  for (const token of [op.token, aud.token]) {
    assert.equal((await api(base, 'POST', '/settings/retention', { token, body: { auditDays: 30 } })).status, 403);
    assert.equal((await api(base, 'POST', '/audit/purge', { token, body: { olderThanDays: 0 } })).status, 403);
    assert.equal((await api(base, 'POST', '/history/purge', { token, body: { olderThanDays: 0 } })).status, 403);
    assert.equal((await api(base, 'POST', '/invites/purge', { token, body: {} })).status, 403);
  }
  assert.equal((await api(base, 'POST', '/settings/retention', { token: admin.token, body: { auditDays: 13 } })).status, 400);
  assert.equal((await api(base, 'POST', '/settings/retention', { token: admin.token, body: { auditEnabled: 'no' } })).status, 400);
  assert.equal((await api(base, 'POST', '/audit/purge', { token: admin.token, body: { olderThanDays: -1 } })).status, 400);

  const set = await api(base, 'POST', '/settings/retention', { token: admin.token, body: { auditDays: 365, historyDays: 30 } });
  assert.equal(set.status, 200);
  assert.equal(set.json.auditDays, 365);
  assert.equal(set.json.historyDays, 30);
  assert.ok((await actions(base, admin.token)).includes('retention.config'));
});

test('выключенный журнал: рутина не пишется, события безопасности пишутся всегда', async (t) => {
  const { base, admin, op } = await setup(t);
  const off = await api(base, 'POST', '/settings/retention', { token: admin.token, body: { auditEnabled: false } });
  assert.equal(off.json.auditEnabled, false);

  await api(base, 'POST', '/contacts', { token: op.token, body: { name: 'Клиент' } });
  await api(base, 'POST', '/sessions');
  await api(base, 'POST', '/auth/login', { body: { login: 'опер', password: 'неверный-пароль' } });

  const list = await actions(base, admin.token);
  assert.ok(!list.includes('contact.create'), 'контакт не должен попасть в выключенный журнал');
  assert.ok(!list.includes('session.create'), 'сеанс не должен попасть в выключенный журнал');
  assert.ok(list.includes('login.failure'), 'неудачный вход пишется всегда');

  await api(base, 'POST', '/settings/retention', { token: admin.token, body: { auditEnabled: true } });
  await api(base, 'POST', '/contacts', { token: op.token, body: { name: 'Снова' } });
  assert.ok((await actions(base, admin.token)).includes('contact.create'));
});

test('очистка журнала оставляет одну запись о себе; история не трогает живые сеансы', async (t) => {
  const { base, admin, op } = await setup(t);
  await api(base, 'POST', '/contacts', { token: op.token, body: { name: 'Клиент' } });

  const purge = await api(base, 'POST', '/audit/purge', { token: admin.token, body: { olderThanDays: 0 } });
  assert.equal(purge.status, 200);
  assert.ok(purge.json.deleted > 0);
  const after = (await api(base, 'GET', '/audit', { token: admin.token })).json;
  assert.equal(after.total, 1);
  assert.equal(after.items[0].action, 'audit.purge');
  assert.equal(after.items[0].detail.deleted, purge.json.deleted);

  const live = await api(base, 'POST', '/sessions');
  const done = await api(base, 'POST', '/sessions');
  await api(base, 'POST', `/sessions/${done.json.sessionId}/end`, { token: done.json.hostToken, body: {} });
  const h = await api(base, 'POST', '/history/purge', { token: admin.token, body: { olderThanDays: 0 } });
  assert.equal(h.json.deleted, 1);
  const rest = (await api(base, 'GET', '/history', { token: admin.token })).json;
  assert.deepEqual(rest.items.map((s) => s.id), [live.json.sessionId]);
  assert.ok((await actions(base, admin.token)).includes('history.purge'));
});

test('приглашения: активные и архив отдельно, новые сверху; очистка удаляет только архив', async (t) => {
  const { base, admin } = await setup(t); // в setup два приглашения уже использованы
  const a1 = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'operator' } });
  const a2 = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'auditor' } });
  const r = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'operator' } });
  await api(base, 'DELETE', `/invites/${r.json.invite.id}`, { token: admin.token });

  const active = (await api(base, 'GET', '/invites?status=active', { token: admin.token })).json;
  assert.deepEqual(active.items.map((i) => i.id), [a2.json.invite.id, a1.json.invite.id]);
  assert.equal(active.total, 2);
  const archive = (await api(base, 'GET', '/invites?status=archive', { token: admin.token })).json;
  assert.equal(archive.total, 3);
  assert.equal(archive.items[0].id, r.json.invite.id);
  assert.equal((await api(base, 'GET', '/invites?status=junk', { token: admin.token })).status, 400);

  const purge = await api(base, 'POST', '/invites/purge', { token: admin.token, body: {} });
  assert.equal(purge.json.deleted, 3);
  const all = (await api(base, 'GET', '/invites', { token: admin.token })).json;
  assert.equal(all.total, 2);
  assert.ok((await actions(base, admin.token)).includes('invite.purge'));
});

test('runRetention: журнал чистится по сроку из настроек, 0 — хранить всегда', () => {
  const db = openDb(':memory:');
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  db.prepare("INSERT INTO audit (actor_id, action, target_id, detail, created_at) VALUES (NULL,'contact.create',NULL,'{}',?)").run(old);
  auditLog(db, null, 'contact.create', null, {});
  assert.equal(runRetention(db).audit, 0, 'по умолчанию журнал хранится всегда');
  setSetting(db, 'audit.retentionDays', 30);
  assert.equal(runRetention(db).audit, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM audit').get().c, 1);
  setSetting(db, 'history.retentionDays', 0);
  db.prepare(`INSERT INTO sessions (id, password_hash, host_token_hash, state, created_at, lease_expires_at, ended_at)
              VALUES ('s1','h','h','ended',?,?,?)`).run(old, old, old);
  assert.equal(runRetention(db, { retentionDays: 7 }).sessions, 0, 'срок из панели главнее ENOT_RETENTION_DAYS');
  db.close();
});

test('схема v10: таблица настроек создаётся и переживает повторное открытие', (t) => {
  const file = tmpDb(t);
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
  raw.close();
  const db = openDb(file); // база проходит все шаги, включая v10
  assert.equal(db.prepare('SELECT version FROM schema_version').get().version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 10);
  setSetting(db, 'audit.enabled', '0');
  db.close();
  const again = openDb(file);
  assert.equal(again.prepare("SELECT value FROM settings WHERE key='audit.enabled'").get().value, '0');
  again.close();
});

test('isSecurityAction: доступ и права пишутся всегда, рутина — нет', () => {
  for (const a of ['login.success', 'login.failure', 'logout', 'password.change', 'totp.enable', 'member.delete',
    'invite.create', 'audit.purge', 'history.purge', 'retention.config', 'machine.claim', 'machine.claim.deny', 'machine.revoke']) {
    assert.ok(isSecurityAction(a), a);
  }
  for (const a of ['session.create', 'session.end', 'contact.create', 'machine.wol', 'machine.toast', 'term.close']) {
    assert.ok(!isSecurityAction(a), a);
  }
});
