import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../app.mjs';
import { api, tmpDb, wsConnect, wsAuth, adminLogin } from './util.mjs';

test('рестарт: живые сеансы инвалидируются, команда/книга/аудит сохраняются', async (t) => {
  const dbPath = tmpDb(t);
  const first = createServer({ dbPath, port: 0, leaseMs: 60000 });
  t.after(() => first.close());
  const port1 = await first.start();
  const base1 = `http://127.0.0.1:${port1}`;
  const admin = await adminLogin(dbPath, base1);

  // данные до рестарта
  const contact = await api(base1, 'POST', '/contacts', { token: admin.token, body: { name: 'Постоянный Клиент' } });
  assert.equal(contact.status, 201);
  const reg = await api(base1, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port1);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  await api(base1, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });

  await first.close();

  // второй запуск на той же БД
  const second = createServer({ dbPath, port: 0, leaseMs: 60000 });
  t.after(() => second.close());
  const port2 = await second.start();
  const base2 = `http://127.0.0.1:${port2}`;

  // живой сеанс завершён с причиной server-restart
  const h = await api(base2, 'GET', '/history', { token: admin.token });
  assert.equal(h.json.total, 1);
  assert.equal(h.json.items[0].endReason, 'server-restart');

  // старый hostToken не работает: WS и claim и decision
  const stale = wsConnect(port2);
  await stale.opened;
  stale.send(JSON.stringify({ type: 'auth', role: 'host', sessionId, token: hostToken }));
  assert.equal(await stale.closeCode(), 4003);
  assert.equal((await api(base2, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } })).status, 400);

  // команда, книга, аудит пережили рестарт
  const me = await api(base2, 'GET', '/auth/me', { token: admin.token });
  assert.equal(me.status, 200); // bearer-токены (hashed) переживают рестарт
  const contacts = await api(base2, 'GET', '/contacts', { token: admin.token });
  assert.equal(contacts.json.total, 1);
  assert.equal(contacts.json.items[0].name, 'Постоянный Клиент');
  const audit = await api(base2, 'GET', '/audit?limit=100', { token: admin.token });
  assert.ok(audit.json.items.some((a) => a.action === 'session.create'));
  // запись аудита append-only: новые события добавляются после рестарта
  await api(base2, 'POST', '/sessions');
  const audit2 = await api(base2, 'GET', '/audit?limit=100', { token: admin.token });
  assert.equal(audit2.json.total, audit.json.total + 1);
});
