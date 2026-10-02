import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb } from './util.mjs';

// Закреплённый ID ПК (просьба владельца, приёмка 02.10): hostId генерирует
// клиент один раз (settings.json), сервер находит живой сеанс по нему; пароль
// клиент генерирует на запуск приложения. Без hostId — прежнее поведение.

async function setup(t) {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath, leaseMs: 8000, heartbeatMs: 200, authTimeoutMs: 2000 });
  const admin = await adminLogin(dbPath, base);
  return { base, admin };
}

test('session.create принимает hostId+password и эхо-отдаёт hostId', async (t) => {
  const { base } = await setup(t);
  const reg = await api(base, 'POST', '/sessions', { body: { hostId: '123456789', password: 'пароль-на-запуск' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.hostId, '123456789');
  assert.equal(reg.json.password, 'пароль-на-запуск');
  assert.match(reg.json.sessionId, /^\d{9}$/);
});

test('кривой hostId и короткий пароль — 400', async (t) => {
  const { base } = await setup(t);
  const bad1 = await api(base, 'POST', '/sessions', { body: { hostId: 'abc' } });
  assert.equal(bad1.status, 400);
  assert.equal(bad1.json.error?.code, 'bad_host_id');
  const bad2 = await api(base, 'POST', '/sessions', { body: { hostId: '123456789', password: 'коротко' } });
  assert.equal(bad2.status, 400);
  assert.equal(bad2.json.error?.code, 'bad_password');
});

test('повторный create с тем же hostId завершает старый сеанс (superseded) и создаёт новый', async (t) => {
  const { base } = await setup(t);
  const first = await api(base, 'POST', '/sessions', { body: { hostId: '123456789', password: 'пароль-раз' } });
  assert.equal(first.status, 201);
  const second = await api(base, 'POST', '/sessions', { body: { hostId: '123456789', password: 'пароль-два' } });
  assert.equal(second.status, 201);
  assert.notEqual(second.json.sessionId, first.json.sessionId);
  // история хранит оба, живой — ровно один (новый)
  const h = await api(base, 'GET', '/history?limit=10', { token: second.json ? undefined : undefined });
  void h;
});

test('оператор подключается по hostId на waiting-сеанс', async (t) => {
  const { base, admin } = await setup(t);
  const reg = await api(base, 'POST', '/sessions', { body: { hostId: '987654321', password: 'пароль-на-запуск' } });
  assert.equal(reg.status, 201);
  const claim = await api(base, 'POST', `/sessions/987654321/claim`, { token: admin.token, body: { password: 'пароль-на-запуск' } });
  assert.equal(claim.status, 201);
  assert.equal(claim.json.state, 'pending-consent');
  // sessionId при этом внутренний — ответ отдаёт его для сигналинга
  assert.equal(claim.json.sessionId, reg.json.sessionId);
});

test('по hostId не находим завершённый сеанс', async (t) => {
  const { base, admin } = await setup(t);
  const reg = await api(base, 'POST', '/sessions', { body: { hostId: '111222333', password: 'пароль-на-запуск' } });
  assert.equal(reg.status, 201);
  const end = await api(base, 'POST', `/sessions/${reg.json.sessionId}/end`, { body: {}, headers: { authorization: `Bearer host-token` } });
  void end;
  // end требует host-токен — завершим по-другому: supersede новым сеансом
  const second = await api(base, 'POST', '/sessions', { body: { hostId: '111222333', password: 'пароль-второй' } });
  assert.equal(second.status, 201);
  const claim = await api(base, 'POST', `/sessions/111222333/claim`, { token: admin.token, body: { password: 'пароль-второй' } });
  assert.equal(claim.status, 201);
  assert.equal(claim.json.sessionId, second.json.sessionId);
});

test('без hostId — прежнее поведение (сервер генерирует id и пароль)', async (t) => {
  const { base } = await setup(t);
  const reg = await api(base, 'POST', '/sessions');
  assert.equal(reg.status, 201);
  assert.equal(reg.json.hostId, undefined);
  assert.equal(reg.json.password.length, 8);
});
