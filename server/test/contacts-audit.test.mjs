import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb } from './util.mjs';

async function setup(t) {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  // operator
  const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'operator' } });
  await api(base, 'POST', '/invites/accept', { body: { token: inv.json.token, login: 'опер', name: 'Оп', password: 'пароль-оператора' } });
  const op = await api(base, 'POST', '/auth/login', { body: { login: 'опер', password: 'пароль-оператора' } });
  // auditor
  const inv2 = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'auditor' } });
  await api(base, 'POST', '/invites/accept', { body: { token: inv2.json.token, login: 'аудитор', name: 'Ауд', password: 'пароль-аудитора' } });
  const aud = await api(base, 'POST', '/auth/login', { body: { login: 'аудитор', password: 'пароль-аудитора' } });
  return { base, admin, op: op.json, aud: aud.json };
}

test('contacts: CRUD, конфликт revision 409, поиск, пагинация, RBAC auditor read-only', async (t) => {
  const { base, admin, op, aud } = await setup(t);

  const bad = await api(base, 'POST', '/contacts', { token: op.token, body: { name: '' } });
  assert.equal(bad.status, 400);
  // валидный JSON без name — 400, сервер продолжает жить
  const noName = await api(base, 'POST', '/contacts', { token: op.token, body: { notes: 'без имени' } });
  assert.equal(noName.status, 400);
  assert.equal((await api(base, 'GET', '/health')).status, 200);
  const badTags = await api(base, 'POST', '/contacts', { token: op.token, body: { name: 'X', tags: Array(11).fill('м') } });
  assert.equal(badTags.status, 400);

  const c1 = await api(base, 'POST', '/contacts', { token: op.token, body: { name: 'Иван Петров', notes: 'бухгалтерия', tags: ['работа'] } });
  assert.equal(c1.status, 201);
  assert.equal(c1.json.contact.revision, 1);
  await api(base, 'POST', '/contacts', { token: admin.token, body: { name: 'Мария Сидорова', tags: [] } });
  await api(base, 'POST', '/contacts', { token: admin.token, body: { name: 'Пётр Иванов' } });

  // поиск (регистронезависимый, кириллица): «иван» находит и «Иван Петров», и «Пётр Иванов»
  const found = await api(base, 'GET', '/contacts?q=иван', { token: op.token });
  assert.equal(found.json.total, 2);
  const sid = await api(base, 'GET', '/contacts?q=сидор', { token: op.token });
  assert.equal(sid.json.total, 1);
  assert.equal(sid.json.items[0].name, 'Мария Сидорова');

  // auditor контакты не читает (P2-8): только журналы и история
  assert.equal((await api(base, 'GET', '/contacts', { token: aud.token })).status, 403);

  // пагинация
  const page1 = await api(base, 'GET', '/contacts?limit=2&offset=0', { token: op.token });
  assert.equal(page1.json.items.length, 2);
  assert.equal(page1.json.total, 3);
  const page2 = await api(base, 'GET', '/contacts?limit=2&offset=2', { token: op.token });
  assert.equal(page2.json.items.length, 1);

  // lost-update: оба обновляют с revision=1, второй получает 409
  const upd1 = await api(base, 'PATCH', `/contacts/${c1.json.contact.id}`, {
    token: op.token, body: { name: 'Иван П.', revision: 1 },
  });
  assert.equal(upd1.status, 200);
  assert.equal(upd1.json.contact.revision, 2);
  const upd2 = await api(base, 'PATCH', `/contacts/${c1.json.contact.id}`, {
    token: admin.token, body: { name: 'Устаревшее', revision: 1 },
  });
  assert.equal(upd2.status, 409);

  // auditor не пишет
  assert.equal((await api(base, 'POST', '/contacts', { token: aud.token, body: { name: 'Нет' } })).status, 403);

  // удаление с revision
  const delBad = await api(base, 'DELETE', `/contacts/${c1.json.contact.id}`, { token: op.token, body: { revision: 1 } });
  assert.equal(delBad.status, 409);
  const del = await api(base, 'DELETE', `/contacts/${c1.json.contact.id}`, { token: op.token, body: { revision: 2 } });
  assert.equal(del.status, 200);
  assert.equal((await api(base, 'GET', '/contacts', { token: op.token })).json.total, 2);
});

test('audit: append-only записи с акторами из auth; history отражает сеансы с причинами', async (t) => {
  const { base, admin, op, aud } = await setup(t);

  // немного событий
  await api(base, 'POST', '/auth/login', { body: { login: 'опер', password: 'неверный-пароль' } });
  const created = await api(base, 'POST', '/contacts', { token: op.token, body: { name: 'Клиент Один' } });
  const sess = await api(base, 'POST', '/sessions');
  await api(base, 'POST', `/sessions/${sess.json.sessionId}/claim`, { token: op.token, body: { password: sess.json.password, contactId: created.json.contact.id } });
  await api(base, 'POST', `/sessions/${sess.json.sessionId}/end`, { token: sess.json.hostToken, body: {} });

  const audit = await api(base, 'GET', '/audit?limit=100', { token: aud.token });
  assert.equal(audit.status, 200);
  // журнал — для админов и наблюдателей; оператору не нужен
  assert.equal((await api(base, 'GET', '/audit', { token: op.token })).status, 403);
  const actions = audit.json.items.map((a) => a.action);
  for (const expected of ['login.success', 'login.failure', 'invite.create', 'invite.accept', 'contact.create', 'session.create', 'session.claim', 'session.end']) {
    assert.ok(actions.includes(expected), `нет действия ${expected}`);
  }
  // detail не содержит секретов
  const raw = JSON.stringify(audit.json);
  assert.ok(!raw.includes(sess.json.password));
  assert.ok(!raw.includes(sess.json.hostToken));
  assert.ok(!raw.includes(admin.token));

  const history = await api(base, 'GET', '/history', { token: aud.token });
  assert.equal(history.status, 200);
  assert.equal(history.json.total, 1);
  const h = history.json.items[0];
  assert.equal(h.endReason, 'ended');
  assert.equal(h.contactId, created.json.contact.id);
  assert.equal(h.operatorName, 'Оп');
  assert.equal(h.state, 'ended');
});
