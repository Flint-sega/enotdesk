import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, SCHEMA_VERSION } from '../db.mjs';
import { createMachinesStore, sanitizeInventory } from '../machines.mjs';
import { sha256 } from '../crypto.mjs';

// ---- миграция A01: версионированная схема ----
// База старой схемы (до schema_version) должна подниматься без потери данных,
// машины и связь сеансов с машинами — появиться.

function createLegacyDb(file) {
  // Схема «до A01»: те же таблицы, что были в проде, плюс ad-hoc колонка created_ip.
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      login TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','operator','auditor')),
      active INTEGER NOT NULL DEFAULT 1,
      password TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE invites (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('admin','operator','auditor')),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
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
      lease_expires_at TEXT NOT NULL,
      created_ip TEXT
    );
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT,
      action TEXT NOT NULL,
      target_id TEXT,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(`INSERT INTO users (id, login, name, role, active, password, created_at)
              VALUES ('u1','ops','Опс','admin',1,'хеш-пароля','2020-01-01')`).run();
  db.prepare(`INSERT INTO sessions (id, password_hash, host_token_hash, state, created_at, lease_expires_at, created_ip)
              VALUES ('s1','х','х','ended','2020-01-01','2020-01-01','127.0.0.1')`).run();
  db.close();
}

test('миграция A01: база старой схемы → новая, данные целы, машины работают', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  createLegacyDb(file);

  const db = openDb(file);
  assert.ok(db.prepare('SELECT version FROM schema_version').get().version >= 2, 'версия поднята минимум до A01');
  assert.equal(db.prepare('SELECT version FROM schema_version').get().version, SCHEMA_VERSION);
  // пользовательские данные пережили миграцию
  assert.equal(db.prepare("SELECT login FROM users WHERE id='u1'").get().login, 'ops');
  const s = db.prepare("SELECT * FROM sessions WHERE id='s1'").get();
  assert.equal(s.created_ip, '127.0.0.1');
  assert.equal(s.state, 'ended');
  // машины живут в мигрировавшей базе, сеанс можно привязать к машине
  db.prepare(`INSERT INTO machines (id, name, group_name, onboarding_expires_at, created_at)
              VALUES ('m1','Касса-1','филиал','2026-01-01','2020-01-01')`).run();
  db.prepare(`UPDATE sessions SET machine_id='m1' WHERE id='s1'`).run();
  assert.equal(db.prepare("SELECT machine_id FROM sessions WHERE id='s1'").get().machine_id, 'm1');
  db.close();

  // повторное открытие мигрировавшей базы не ломается и не дублирует шаги
  const again = openDb(file);
  assert.equal(again.prepare('SELECT version FROM schema_version').get().version, SCHEMA_VERSION);
  assert.equal(again.prepare('SELECT count(*) c FROM machines').get().c, 1);
  again.close();
});

test('миграция A01: свежая база сразу на последней версии', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('SELECT version FROM schema_version').get().version, SCHEMA_VERSION);
  db.close();
});

// ---- createMachinesStore ----
// Ожидания заданы вручную: код/токен возвращаются открытым текстом один раз,
// в БД лежат только их sha256; PIN сверяется, но не хранится открыто.

test('store: onboarding-код одноразовый, токен машины — только хеш в БД', () => {
  const db = openDb(':memory:');
  const store = createMachinesStore(db);

  const { machine, code, expiresAt } = store.createOnboarding({ name: 'Касса-1', groupName: 'филиал', createdBy: 'u1' });
  assert.ok(code.length >= 30, 'код высокой энтропии');
  assert.ok(expiresAt > new Date().toISOString(), 'код не просрочен при выдаче');
  assert.equal(machine.hasPin, false);
  assert.equal(machine.registered, false);
  assert.equal(machine.groupName, 'филиал');
  // sanitized-объект не несёт хешей и секретов
  for (const secret of ['pinHash', 'pin_hash', 'agentTokenHash', 'agent_token_hash', 'onboardingCodeHash', 'onboarding_code_hash']) {
    assert.ok(!(secret in machine), `нет секрета ${secret} в наружном объекте`);
  }
  // в БД — только хеш кода, не сам код
  const raw = store.get(machine.id);
  assert.equal(raw.onboarding_code_hash, sha256(code));
  assert.ok(!raw.onboarding_code_hash.includes(code.slice(10, 20)));

  // регистрация: агент меняет код на токен, код гасится
  const r1 = store.register({ code, name: 'kassa-1.local', os: 'win32', version: '1.2.3' });
  assert.ok(r1.token.length >= 30);
  assert.equal(r1.machine.name, 'kassa-1.local');
  assert.equal(r1.machine.os, 'win32');
  assert.equal(r1.machine.registered, true);
  assert.equal(r1.machine.onboardingUsedAt !== null, true);
  const rawAfter = store.get(machine.id);
  assert.equal(rawAfter.agent_token_hash, sha256(r1.token));
  assert.equal(rawAfter.onboarding_code_hash, null, 'погашенный код не хранится');

  // повторное использование кода отклонено
  assert.equal(store.register({ code, name: 'злоумышленник', os: '', version: '' }), null);
  // неизвестный код отклонён
  assert.equal(store.register({ code: 'не-код', name: 'x', os: '', version: '' }), null);
  db.close();
});

test('store: просроченный код не регистрируется', () => {
  const db = openDb(':memory:');
  const store = createMachinesStore(db);
  const { code } = store.createOnboarding({ name: 'старая', groupName: '' }, { ttlMs: -1000 });
  assert.equal(store.register({ code, name: 'x', os: '', version: '' }), null);
  db.close();
});

test('store: PIN задаётся и проверяется, снимается; revoke гасит токен, delete удаляет', () => {
  const db = openDb(':memory:');
  const store = createMachinesStore(db);
  const { machine, code } = store.createOnboarding({ name: 'СКУД', groupName: 'цех' });
  const { token } = store.register({ code, name: 'skud-1', os: 'linux', version: '9.9' });

  assert.equal(store.setPin(machine.id, '1357'), true);
  assert.equal(store.get(machine.id).pin_hash.includes('1357'), false, 'PIN не хранится открытым текстом');
  assert.equal(store.verifyPin(machine.id, '1357'), true);
  assert.equal(store.verifyPin(machine.id, '0000'), false);
  assert.equal(store.verifyPin(machine.id, undefined), false);
  assert.equal(store.setPin(machine.id, null), true, 'PIN снимается');
  assert.equal(store.verifyPin(machine.id, '1357'), false);

  assert.equal(store.machineByToken(token).id, machine.id, 'живой токен находит машину');
  assert.equal(store.machineByToken('чужой-токен'), null);
  assert.equal(store.revoke(machine.id), true);
  assert.equal(store.machineByToken(token), null, 'после отзыва токен мёртв');
  assert.equal(store.register({ code, name: 'x', os: '', version: '' }), null, 'и отложенный код тоже');
  assert.equal(store.delete(machine.id), true);
  assert.equal(store.get(machine.id), null);
  assert.equal(store.delete(machine.id), false);
  db.close();
});

test('store: touch обновляет last_seen, list пагинирует и честно показывает online', () => {
  let t = 1_700_000_000_000;
  const db = openDb(':memory:');
  const store = createMachinesStore(db, { nowMs: () => t });

  for (const name of ['м-1', 'м-2', 'м-3']) {
    store.createOnboarding({ name, groupName: 'склад' });
    t += 1000; // машины создавались в разные моменты — порядок списка по created_at
  }
  const page1 = store.list({ limit: 2, offset: 0 });
  assert.equal(page1.total, 3);
  assert.deepEqual(page1.items.map((m) => m.name), ['м-1', 'м-2']);
  assert.deepEqual(store.list({ limit: 2, offset: 2 }).items.map((m) => m.name), ['м-3']);

  const reg = store.createOnboarding({ name: 'м-онлайн', groupName: '' });
  const { token } = store.register({ code: reg.code, name: 'онлайн', os: '', version: '' });
  const machine = store.machineByToken(token);
  assert.equal(machine.last_seen_at, null);
  assert.equal(store.list({ limit: 100 }).items.find((m) => m.id === machine.id).online, false, 'без heartbeat машины нет online');

  assert.equal(store.touch(machine.id), true);
  assert.equal(store.list({ limit: 100 }).items.find((m) => m.id === machine.id).online, true, 'свежий heartbeat → online');
  t += 120_000; // окно online ушло
  assert.equal(store.list({ limit: 100 }).items.find((m) => m.id === machine.id).online, false);
  assert.equal(store.touch('нет-такой'), false);
  db.close();
});

// ---- инвентарь машин (R06): heartbeat агента → валидация → наружу ----
// Ожидания из таска: строки ограничены, числа числа, мусор отбрасывается;
// инвентарь ≤ 4 КБ; без инвентаря всё продолжает работать, прошлый не затирается.

test('sanitizeInventory: allowlist полей, строки ограничены, числа числа, мусор → null', () => {
  assert.deepEqual(
    sanitizeInventory({ os: 'linux', appVersion: '0.9.0', uptimeSec: 123.7, diskFreeGb: 42.567 }),
    { os: 'linux', appVersion: '0.9.0', uptimeSec: 123, diskFreeGb: 42.57 },
  );
  // неизвестные поля отбрасываются — наружу проходит только allowlist
  assert.deepEqual(sanitizeInventory({ os: 'win32', evil: '<script>', extra: { a: 1 } }), { os: 'win32' });
  // строки обрезаются до предела, пустые не хранятся
  assert.equal(sanitizeInventory({ os: 'о'.repeat(200) }).os.length, 60);
  assert.deepEqual(sanitizeInventory({ os: '   ' }), null);
  // не-строки и не-числа — поле отбрасывается
  assert.deepEqual(sanitizeInventory({ os: 42, uptimeSec: 'много' }), null);
  // отрицательные, NaN и нелепые величины — поле отбрасывается
  assert.deepEqual(sanitizeInventory({ uptimeSec: -5 }), null);
  assert.deepEqual(sanitizeInventory({ diskFreeGb: NaN }), null);
  assert.deepEqual(sanitizeInventory({ uptimeSec: 1e15 }), null);
  // переполнение 4 КБ — весь объект мусор
  assert.equal(sanitizeInventory({ junk: 'x'.repeat(5000) }), null);
  // вовсе не объект — мусор
  assert.equal(sanitizeInventory('строка'), null);
  assert.equal(sanitizeInventory(42), null);
  assert.equal(sanitizeInventory(null), null);
  assert.equal(sanitizeInventory(['linux']), null);
});

test('store: heartbeat с инвентарём сохраняется и отдаётся; без — старый остаётся, мусор не затирает', () => {
  const db = openDb(':memory:');
  const store = createMachinesStore(db);
  const { machine, code } = store.createOnboarding({ name: 'м-инв' });
  const { token } = store.register({ code, name: 'inv-1', os: 'linux', version: '1.0' });
  const id = machine.id;
  void token;

  assert.equal(store.out(store.get(id)).inventory, null, 'у новой машины инвентаря нет');
  const inv = sanitizeInventory({ os: 'linux', appVersion: '1.0', uptimeSec: 3600, diskFreeGb: 12.5 });
  assert.equal(store.touch(id, { inventory: inv }), true);
  assert.deepEqual(store.out(store.get(id)).inventory, { os: 'linux', appVersion: '1.0', uptimeSec: 3600, diskFreeGb: 12.5 });

  // heartbeat без инвентаря не затирает сохранённый
  assert.equal(store.touch(id), true);
  assert.deepEqual(store.out(store.get(id)).inventory, { os: 'linux', appVersion: '1.0', uptimeSec: 3600, diskFreeGb: 12.5 });
  // мусор (валидация дала null) — прошлый инвентарь сохраняется
  assert.equal(store.touch(id, { inventory: null }), true);
  assert.deepEqual(store.out(store.get(id)).inventory, { os: 'linux', appVersion: '1.0', uptimeSec: 3600, diskFreeGb: 12.5 });

  // незарегистрированная машина (токена нет) не обновляется
  const other = store.createOnboarding({ name: 'м-2' });
  assert.equal(store.touch(other.machine.id, { inventory: sanitizeInventory({ os: 'x' }) }), false);
  db.close();
});

// ---- маршруты /machines*, /agent/* (шов createServer) ----

import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';
import { RateLimiter } from '../app.mjs';

async function setup(t, extra = {}) {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath, ...extra });
  const admin = await adminLogin(dbPath, base);
  return { base, port, admin };
}

async function makeUser(base, admin, role, login) {
  const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role } });
  const password = `Пароль-${role}-123`;
  await api(base, 'POST', '/invites/accept', { body: { token: inv.json.token, login, name: `Тест ${role}`, password } });
  const res = await api(base, 'POST', '/auth/login', { body: { login, password } });
  return res.json;
}

async function onboardAndRegister(base, admin, { name = 'Касса-1', groupName = 'филиал' } = {}) {
  const created = await api(base, 'POST', '/machines', { token: admin.token, body: { name, group: groupName } });
  assert.equal(created.status, 201);
  const reg = await api(base, 'POST', '/agent/register', {
    body: { code: created.json.code, name: name.toLowerCase() + '.local', os: 'linux', version: '0.9.0' },
  });
  assert.equal(reg.status, 201);
  return { created: created.json, reg: reg.json };
}

test('machines API: RBAC — создание/удаление/PIN только админ; список оператору; пагинация', async (t) => {
  const { base, admin } = await setup(t);
  const operator = await makeUser(base, admin, 'operator', 'op-rbac');
  const auditor = await makeUser(base, admin, 'auditor', 'aud-rbac');

  assert.equal((await api(base, 'GET', '/machines')).status, 401, 'без токена нельзя');
  assert.equal((await api(base, 'POST', '/machines', { token: operator.token, body: { name: 'х' } })).status, 403);
  assert.equal((await api(base, 'DELETE', '/machines/m1', { token: operator.token })).status, 403);
  assert.equal((await api(base, 'POST', '/machines/m1/pin', { token: operator.token, body: { pin: '1234' } })).status, 403);
  assert.equal((await api(base, 'POST', '/machines/m1/revoke', { token: operator.token })).status, 403);
  assert.equal((await api(base, 'GET', '/machines', { token: auditor.token })).status, 403, 'аудитор — только чтение своих зон');

  const created = await api(base, 'POST', '/machines', { token: admin.token, body: { name: 'Касса-1', group: 'филиал' } });
  assert.equal(created.status, 201);
  assert.ok(created.json.code);
  for (const k of ['pin_hash', 'agent_token_hash', 'onboarding_code_hash', 'pinHash', 'agentTokenHash', 'code']) {
    assert.ok(!(k in created.json.machine), `в наружной машине нет ${k}`);
  }

  // незарегистрированную машину claim не пускает — честная причина
  const early = await api(base, 'POST', `/machines/${created.json.machine.id}/claim`, { token: operator.token, body: { reason: 'рано' } });
  assert.equal(early.status, 409);
  assert.equal(early.json.error.code, 'not_registered');

  // пагинация как у members
  await api(base, 'POST', '/machines', { token: admin.token, body: { name: 'м-2', group: '' } });
  await api(base, 'POST', '/machines', { token: admin.token, body: { name: 'м-3' } });
  const page = await api(base, 'GET', '/machines?limit=2&offset=2', { token: operator.token });
  assert.equal(page.status, 200);
  assert.equal(page.json.total, 3);
  assert.equal(page.json.items.length, 1);

  // валидация входа
  assert.equal((await api(base, 'POST', '/machines', { token: admin.token, body: {} })).status, 400);
  assert.equal((await api(base, 'POST', '/machines', { token: admin.token, body: { name: ' '.repeat(121) } })).status, 400);
  assert.equal((await api(base, 'POST', '/machines', { token: admin.token, body: { name: 'ок', group: 'г'.repeat(61) } })).status, 400);
});

test('полный цикл: код → регистрация → claim с причиной → агент принимает claim', async (t) => {
  const { base, port, admin } = await setup(t);
  const operator = await makeUser(base, admin, 'operator', 'op-cycle');
  const { created, reg } = await onboardAndRegister(base, admin);

  // повторное использование кода отклонено
  const reuse = await api(base, 'POST', '/agent/register', { body: { code: created.code, name: 'двойник', os: '', version: '' } });
  assert.equal(reuse.status, 400);

  // claim без причины — отказ
  const noReason = await api(base, 'POST', `/machines/${created.machine.id}/claim`, { token: operator.token, body: {} });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error.code, 'reason_required');

  // несуществующая машина — 404
  assert.equal((await api(base, 'POST', '/machines/no-such-machine/claim', { token: operator.token, body: { reason: 'х' } })).status, 404);

  const claimed = await api(base, 'POST', `/machines/${created.machine.id}/claim`, { token: operator.token, body: { reason: 'Плановое обслуживание СКУД' } });
  assert.equal(claimed.status, 201);
  const { sessionId, claimId } = claimed.json;

  // аудит: actor=machine-id, unattended=true, причина записана без PIN-ов
  const audit = await api(base, 'GET', '/audit?limit=100', { token: admin.token });
  const entry = audit.json.items.find((a) => a.action === 'machine.claim' && a.targetId === sessionId);
  assert.ok(entry, 'успешный claim в аудите');
  assert.equal(entry.actorId, created.machine.id);
  assert.equal(entry.detail.unattended, true);
  assert.equal(entry.detail.reason, 'Плановое обслуживание СКУД');
  const denyEntry = audit.json.items.find((a) => a.action === 'machine.claim.deny');
  assert.ok(denyEntry, 'отказ в аудите');
  assert.equal(denyEntry.detail.unattended, true);
  assert.equal(denyEntry.actorId, created.machine.id);

  // агент обнаруживает сеанс по своему токену
  const sess = await api(base, 'GET', '/agent/session', { token: reg.token });
  assert.equal(sess.status, 200);
  assert.equal(sess.json.sessionId, sessionId);
  assert.equal(sess.json.claimId, claimId);

  // агент подключается как host со своим машинным токеном и получает claim
  const host = wsConnect(port);
  const ready = await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: reg.token });
  assert.equal(ready.state, 'pending-consent');
  assert.equal((await host.wait((m) => m.type === 'claim')).claimId, claimId);

  const op = wsConnect(port);
  await wsAuth(op, { type: 'auth', role: 'operator', sessionId, token: operator.token, claimId });
  await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: reg.token, body: { claimId, allow: true } });
  assert.equal((await host.wait((m) => m.type === 'approved')).claimId, claimId);
  assert.equal((await op.wait((m) => m.type === 'approved')).claimId, claimId);

  // второй live-сеанс машины невозможен
  const busy = await api(base, 'POST', `/machines/${created.machine.id}/claim`, { token: operator.token, body: { reason: 'ещё раз' } });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error.code, 'machine_busy');

  // heartbeat агента отмечается; админ видит online
  assert.equal((await api(base, 'POST', '/agent/heartbeat', { token: reg.token })).status, 200);
  const list = await api(base, 'GET', '/machines', { token: admin.token });
  const m = list.json.items.find((x) => x.id === created.machine.id);
  assert.equal(m.online, true);
  assert.equal(m.registered, true);
  assert.equal(m.os, 'linux');
});

test('политика PIN: без PIN не войти, неверный — отказ, верный — впускает; PIN не утекает в аудит', async (t) => {
  const { base, admin } = await setup(t);
  const operator = await makeUser(base, admin, 'operator', 'op-pin');
  const { created, reg } = await onboardAndRegister(base, admin);
  void reg;

  assert.equal((await api(base, 'POST', `/machines/${created.machine.id}/pin`, { token: admin.token, body: { pin: '12' } })).status, 400, 'слишком короткий PIN');
  assert.equal((await api(base, 'POST', `/machines/${created.machine.id}/pin`, { token: admin.token, body: { pin: '13-57-ПИН' } })).status, 200);

  const need = await api(base, 'POST', `/machines/${created.machine.id}/claim`, { token: operator.token, body: { reason: 'Диагностика' } });
  assert.equal(need.status, 400);
  assert.equal(need.json.error.code, 'pin_required');

  const wrong = await api(base, 'POST', `/machines/${created.machine.id}/claim`, { token: operator.token, body: { reason: 'Диагностика', pin: '0000' } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.error.code, 'bad_pin');

  const good = await api(base, 'POST', `/machines/${created.machine.id}/claim`, { token: operator.token, body: { reason: 'Диагностика', pin: '13-57-ПИН' } });
  assert.equal(good.status, 201);

  const audit = await api(base, 'GET', '/audit?limit=100', { token: admin.token });
  const denies = JSON.stringify(audit.json.items.filter((a) => a.action === 'machine.claim.deny'));
  assert.ok(!denies.includes('13-57-ПИН'), 'настоящий PIN не пишется в журнал');
  assert.ok(!denies.includes('0000'), 'подбираемый PIN тоже не пишется');

  // снятие PIN возвращает машину в политику без PIN
  await api(base, 'POST', `/machines/${created.machine.id}/pin`, { token: admin.token, body: {} });
  const list = await api(base, 'GET', '/machines', { token: admin.token });
  assert.equal(list.json.items.find((x) => x.id === created.machine.id).hasPin, false);
});

test('лимиты: подбор PIN и подбор кода регистрации ограничены', async (t) => {
  const { base, admin } = await setup(t, {
    limits: { machineClaimId: new RateLimiter(2, 60_000), agentRegister: new RateLimiter(3, 60_000) },
  });
  const operator = await makeUser(base, admin, 'operator', 'op-limit');
  const { created } = await onboardAndRegister(base, admin);
  await api(base, 'POST', `/machines/${created.machine.id}/pin`, { token: admin.token, body: { pin: '9999' } });

  for (let i = 0; i < 2; i++) {
    const r = await api(base, 'POST', `/machines/${created.machine.id}/claim`, { token: operator.token, body: { reason: 'Подбор', pin: `000${i}` } });
    assert.equal(r.status, 403, `попытка ${i + 1} — честный отказ`);
  }
  const third = await api(base, 'POST', `/machines/${created.machine.id}/claim`, { token: operator.token, body: { reason: 'Подбор', pin: '0002' } });
  assert.equal(third.status, 429, 'третья неудачная попытка — порог исчерпан');

  for (let i = 0; i < 2; i++) {
    const r = await api(base, 'POST', '/agent/register', { body: { code: `не-код-${i}`, name: 'x', os: '', version: '' } });
    assert.equal(r.status, 400);
  }
  assert.equal((await api(base, 'POST', '/agent/register', { body: { code: 'не-код-3', name: 'x', os: '', version: '' } })).status, 429,
    'после успеха и двух промахов подбор кода заперт');
});

test('revoke завершает живой сеанс машины и гасит токен; delete удаляет', async (t) => {
  const { base, admin } = await setup(t);
  const { created, reg } = await onboardAndRegister(base, admin);
  const claimed = await api(base, 'POST', `/machines/${created.machine.id}/claim`, { token: admin.token, body: { reason: 'Обслуживание' } });
  const { sessionId } = claimed.json;

  assert.equal((await api(base, 'POST', `/machines/${created.machine.id}/revoke`, { token: admin.token })).status, 200);
  const history = await api(base, 'GET', '/history', { token: admin.token });
  const row = history.json.items.find((it) => it.id === sessionId);
  assert.equal(row.endReason, 'machine-revoked', 'живой сеанс завершён отзывом');
  assert.equal(row.machineId, created.machine.id, 'история помечает машину');

  assert.equal((await api(base, 'GET', '/agent/session', { token: reg.token })).status, 401, 'токен отозванной машины мёртв');
  const recl = await api(base, 'POST', `/machines/${created.machine.id}/claim`, { token: admin.token, body: { reason: 'снова' } });
  assert.equal(recl.status, 409);
  assert.equal(recl.json.error.code, 'machine_revoked');

  assert.equal((await api(base, 'POST', `/machines/${created.machine.id}/revoke`, { token: admin.token })).status, 404, 'повторный отзыв — не найдено');
  assert.equal((await api(base, 'DELETE', `/machines/${created.machine.id}`, { token: admin.token })).status, 200);
  assert.equal((await api(base, 'GET', '/machines', { token: admin.token })).json.total, 0);
  assert.equal((await api(base, 'DELETE', `/machines/${created.machine.id}`, { token: admin.token })).status, 404);
});

test('инвентарь по API: heartbeat с inventory сохранён и виден в GET /machines и /machines/:id; мусор отброшен; без inventory не падает', async (t) => {
  const { base, admin } = await setup(t);
  const auditor = await makeUser(base, admin, 'auditor', 'aud-inv');
  const { created, reg } = await onboardAndRegister(base, admin);
  const machineUrl = `/machines/${created.machine.id}`;

  // heartbeat без inventory — 200, у машины честно null
  assert.equal((await api(base, 'POST', '/agent/heartbeat', { token: reg.token })).status, 200);
  assert.equal((await api(base, 'GET', machineUrl, { token: admin.token })).json.inventory, null);

  // валидный инвентарь: сохранён и отдаётся и в одиночной машине, и в списке
  const good = { os: 'linux', appVersion: '0.9.0', uptimeSec: 3600, diskFreeGb: 12.5 };
  assert.equal((await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: { inventory: good } })).status, 200);
  assert.deepEqual((await api(base, 'GET', machineUrl, { token: admin.token })).json.inventory, good);
  assert.deepEqual(
    (await api(base, 'GET', '/machines', { token: admin.token })).json.items.find((x) => x.id === created.machine.id).inventory,
    good,
  );

  // мусор (не-объект, не-те типы, переполнение 4 КБ) — heartbeat всё равно 200, прошлый инвентарь жив
  for (const junk of ['строка', { os: 42, uptimeSec: 'много' }, { junk: 'x'.repeat(5000) }]) {
    assert.equal((await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: { inventory: junk } })).status, 200);
  }
  assert.deepEqual((await api(base, 'GET', machineUrl, { token: admin.token })).json.inventory, good);

  // RBAC одиночной машины: аноним 401, аудитор 403, неизвестная 404
  assert.equal((await api(base, 'GET', machineUrl)).status, 401);
  assert.equal((await api(base, 'GET', machineUrl, { token: auditor.token })).status, 403);
  assert.equal((await api(base, 'GET', '/machines/no-such-machine', { token: admin.token })).status, 404);
});

test('отказы машинных маршрутов локализуются по Accept-Language (ru/en)', async (t) => {
  const { base, admin } = await setup(t);
  const operator = await makeUser(base, admin, 'operator', 'op-i18n');
  const { created } = await onboardAndRegister(base, admin);
  await api(base, 'POST', `/machines/${created.machine.id}/pin`, { token: admin.token, body: { pin: '7777' } });
  const claimUrl = `/machines/${created.machine.id}/claim`;

  const call = async (p, extra = {}) => {
    const res = await fetch(base + '/api/v1' + p, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operator.token}`,
        ...(extra.language ? { 'Accept-Language': extra.language } : {}),
      },
      body: JSON.stringify(extra.body ?? {}),
    });
    return { status: res.status, json: await res.json() };
  };

  // без заголовка — русский (исторический язык продукта)
  const ru = await call(claimUrl, { body: {} });
  assert.equal(ru.status, 400);
  assert.equal(ru.json.error.code, 'reason_required');
  assert.equal(ru.json.error.message, 'Укажите причину подключения (до 500 символов)');

  // Accept-Language: en — английский текст, без кириллицы
  const en = await call(claimUrl, { body: {}, language: 'en' });
  assert.equal(en.json.error.code, 'reason_required');
  assert.equal(en.json.error.message, 'State the reason for connecting (up to 500 characters)');
  assert.ok(!/[А-Яа-яЁё]/.test(en.json.error.message), 'в английском тексте отказа нет кириллицы');

  const pinNeedEn = await call(claimUrl, { body: { reason: 'Diagnostics' }, language: 'en' });
  assert.equal(pinNeedEn.json.error.code, 'pin_required');
  assert.equal(pinNeedEn.json.error.message, 'This machine requires a PIN');

  const badPinEn = await call(claimUrl, { body: { reason: 'Diagnostics', pin: '0000' }, language: 'en' });
  assert.equal(badPinEn.json.error.code, 'bad_pin');
  assert.equal(badPinEn.json.error.message, 'Incorrect PIN');
  assert.ok(!JSON.stringify(badPinEn.json).includes('0000'), 'значение PIN не подставляется в текст');

  // операционные отказы тоже локализуются
  const missing = await call('/machines/no-such-machine/claim', { body: { reason: 'x' }, language: 'en' });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.message, 'Machine not found');

  // верный PIN впускает независимо от языка
  const okEn = await call(claimUrl, { body: { reason: 'Diagnostics', pin: '7777' }, language: 'en' });
  assert.equal(okEn.status, 201);
});

// ---- сообщение на экран машины (R08): POST /machines/:id/toast ----
// Выбранный путь: toast живёт в ПАМЯТИ сервера (TTL 60с), агент забирает его
// следующим машинным heartbeat (поле toast в ответе) и отвечает результатом
// (toastResult в следующем heartbeat). WS-реле не расширяется. Ожидания:
// честные отказы (нет машины/агента/сети), лимит текста 500, RBAC claim-уровня.

test('toast API: RBAC и честные отказы — не-текст, чужая/отозванная/безагентная/офлайн машина', async (t) => {
  const { base, admin } = await setup(t);
  const operator = await makeUser(base, admin, 'operator', 'op-toast');
  const auditor = await makeUser(base, admin, 'auditor', 'aud-toast');

  const { created } = await onboardAndRegister(base, admin);

  assert.equal((await api(base, 'POST', `/machines/${created.machine.id}/toast`)).status, 401, 'без токена нельзя');
  assert.equal((await api(base, 'POST', `/machines/${created.machine.id}/toast`, { token: auditor.token, body: { text: 'х' } })).status, 403, 'аудитор — только чтение');
  // оператору можно (как claim): сообщение — операция поддержки, не админская
  const badText = await api(base, 'POST', `/machines/${created.machine.id}/toast`, { token: operator.token, body: { text: '   ' } });
  assert.equal(badText.status, 400, 'пустой текст отклонён');
  const longText = await api(base, 'POST', `/machines/${created.machine.id}/toast`, { token: operator.token, body: { text: 'х'.repeat(501) } });
  assert.equal(longText.status, 400, 'лимит 500 символов честный');
  assert.match(longText.json.error.message, /500/);

  const unknown = await api(base, 'POST', '/machines/no-such/toast', { token: operator.token, body: { text: 'х' } });
  assert.equal(unknown.status, 404);

  const offline = await api(base, 'POST', `/machines/${created.machine.id}/toast`, { token: operator.token, body: { text: 'х' } });
  assert.equal(offline.status, 409, 'зарегистрированная, но не отвечающая машина — офлайн');
  assert.equal(offline.json.error.code, 'machine_offline');

  // отозванная машина — свой честный код
  const second = await onboardAndRegister(base, admin, { name: 'Касса-2', groupName: '' });
  await api(base, 'POST', `/machines/${second.created.machine.id}/revoke`, { token: admin.token });
  const revoked = await api(base, 'POST', `/machines/${second.created.machine.id}/toast`, { token: operator.token, body: { text: 'х' } });
  assert.equal(revoked.status, 409);
  assert.equal(revoked.json.error.code, 'machine_revoked');

  // незарегистрированная (код выдан, агент не приходил) — «нет агента»
  const third = await api(base, 'POST', '/machines', { token: admin.token, body: { name: 'Касса-3', group: '' } });
  const noAgent = await api(base, 'POST', `/machines/${third.json.machine.id}/toast`, { token: operator.token, body: { text: 'х' } });
  assert.equal(noAgent.status, 409);
  assert.equal(noAgent.json.error.code, 'not_registered');
});

test('toast API: агент забирает toast машинным heartbeat-ом и отвечает результатом — оператор получает статус', async (t) => {
  const { base, admin } = await setup(t, { toastWaitMs: 5000 });
  const operator = await makeUser(base, admin, 'operator', 'op-toast2');
  const { created, reg } = await onboardAndRegister(base, admin);

  // машины «нет в сети» → агент сначала делает heartbeat (touch), затем оператор шлёт toast
  const beat = await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: {} });
  assert.equal(beat.status, 200);
  assert.deepEqual(beat.json, { ok: true }, 'без ожидающего toast ответ прежний');

  // ожидание оператора и выдача toast агенту идут параллельно
  const pending = api(base, 'POST', `/machines/${created.machine.id}/toast`, { token: operator.token, body: { text: 'Перезагрузите кассу' } });

  // агент забирает toast следующим heartbeat-ом
  const pickup = await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: {} });
  assert.equal(pickup.status, 200);
  assert.equal(typeof pickup.json.toast?.id, 'string', 'агент получил id запроса');
  assert.equal(pickup.json.toast.text, 'Перезагрузите кассу', 'текст дошёл без изменений');

  // повторный heartbeat без результата: toast уже забран, повторно не выдаётся
  const again = await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: {} });
  assert.equal(again.json.toast, undefined, 'ожидающий toast выдаётся один раз');

  // агент отчитывается результатом — запрос оператора завершается честным статусом
  const answer = await api(base, 'POST', '/agent/heartbeat', {
    token: reg.token,
    body: { toastResult: { id: pickup.json.toast.id, ok: true } },
  });
  assert.equal(answer.status, 200);
  const done = await pending;
  assert.equal(done.status, 200);
  assert.deepEqual(done.json, { ok: true, result: { ok: true } }, 'оператору пришло подтверждение машины');
});

test('toast API: отказ агента доходит с причиной; нет ответа за срок — result null; TTL и замена', async (t) => {
  const { base, admin } = await setup(t, { toastWaitMs: 300 });
  const operator = await makeUser(base, admin, 'operator', 'op-toast3');
  const { created, reg } = await onboardAndRegister(base, admin);
  await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: {} });

  // агент честно не смог показать (например, нет консольного пользователя)
  const pending = api(base, 'POST', `/machines/${created.machine.id}/toast`, { token: operator.token, body: { text: 'х' } });
  const pickup = await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: {} });
  await api(base, 'POST', '/agent/heartbeat', {
    token: reg.token,
    body: { toastResult: { id: pickup.json.toast.id, ok: false, reason: 'no-console-user' } },
  });
  const done = await pending;
  assert.deepEqual(done.json, { ok: true, result: { ok: false, reason: 'no-console-user' } }, 'отказ агента честен');

  // агент молчит — оператор получает result null за отведённый срок
  const silentStarted = Date.now();
  const silent = await api(base, 'POST', `/machines/${created.machine.id}/toast`, { token: operator.token, body: { text: 'х' } });
  assert.equal(silent.status, 200);
  assert.deepEqual(silent.json, { ok: true, result: null }, 'нет подтверждения — честный null');
  assert.ok(Date.now() - silentStarted < 2000, 'ожидание ограничено toastWaitMs');

  // результат по чужому/устаревшему id никуда не идёт: waiter уже разрешён
  await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: { toastResult: { id: 'чужой', ok: true } } });

  // мусорный toastResult не роняет heartbeat
  const junk = await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: { toastResult: 'мусор' } });
  assert.equal(junk.status, 200);
});

test('toast API: TTL просроченного toast — агенту не выдаётся', async (t) => {
  const { base, admin } = await setup(t, { toastTtlMs: -1 });
  const operator = await makeUser(base, admin, 'operator', 'op-toast4');
  const { created, reg } = await onboardAndRegister(base, admin);
  await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: {} });

  await api(base, 'POST', `/machines/${created.machine.id}/toast`, { token: operator.token, body: { text: 'устарело' } });
  const expired = await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: {} });
  assert.equal(expired.json.toast, undefined, 'просроченный toast не выдаётся (TTL 60с в проде)');
});

test('toast API: новый toast заменяет ожидающий — уезжает последний, чужие ожидания не разрешаются', async (t) => {
  const { base, admin } = await setup(t, { toastWaitMs: 200 });
  const operator = await makeUser(base, admin, 'operator', 'op-toast5');
  const { created, reg } = await onboardAndRegister(base, admin);
  await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: {} });

  const first = api(base, 'POST', `/machines/${created.machine.id}/toast`, { token: operator.token, body: { text: 'первый' } });
  const second = api(base, 'POST', `/machines/${created.machine.id}/toast`, { token: admin.token, body: { text: 'второй' } });
  const pickup = await api(base, 'POST', '/agent/heartbeat', { token: reg.token, body: {} });
  assert.equal(pickup.json.toast?.text, 'второй', 'уехал последний');
  await api(base, 'POST', '/agent/heartbeat', {
    token: reg.token,
    body: { toastResult: { id: pickup.json.toast.id, ok: true } },
  });
  const firstDone = await first;
  const secondDone = await second;
  assert.deepEqual(firstDone.json, { ok: true, result: null }, 'первый оператор — честное «нет подтверждения»');
  assert.deepEqual(secondDone.json, { ok: true, result: { ok: true } }, 'второй получил результат');
});
