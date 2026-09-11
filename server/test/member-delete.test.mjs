import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';

async function inviteAndLogin(base, adminToken, role, login, password, name = 'Сотрудник') {
  const inv = await api(base, 'POST', '/invites', { token: adminToken, body: { role } });
  assert.equal(inv.status, 201);
  const acc = await api(base, 'POST', '/invites/accept', {
    body: { token: inv.json.token, login, name, password },
  });
  assert.equal(acc.status, 200);
  const loginRes = await api(base, 'POST', '/auth/login', { body: { login, password } });
  assert.equal(loginRes.status, 200);
  return loginRes.json;
}

test('member.delete: удаляет оператора, отзывает токены и завершает живую сессию', async (t) => {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath, leaseMs: 8000, heartbeatMs: 200 });
  const admin = await adminLogin(dbPath, base);
  const op = await inviteAndLogin(base, admin.token, 'operator', 'удаляемый-опер', 'пароль-удаляемого');

  // живая сессия оператора: claim + WS
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password } = reg.json;
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: op.token, body: { password } });
  assert.equal(claim.status, 201);
  const opWs = wsConnect(port);
  await wsAuth(opWs, { type: 'auth', role: 'operator', sessionId, token: op.token, claimId: claim.json.claimId });
  const endedP = opWs.wait((m) => m.type === 'ended', 3000);

  const members = await api(base, 'GET', '/members', { token: admin.token });
  const target = members.json.items.find((u) => u.login === 'удаляемый-опер');
  assert.ok(target);

  const del = await api(base, 'DELETE', `/members/${target.id}`, { token: admin.token });
  assert.equal(del.status, 200);
  assert.equal(del.json.ok, true);

  const after = await api(base, 'GET', '/members', { token: admin.token });
  assert.ok(!after.json.items.some((u) => u.id === target.id));
  assert.equal((await api(base, 'POST', '/auth/login', {
    body: { login: 'удаляемый-опер', password: 'пароль-удаляемого' },
  })).status, 401);
  assert.equal((await api(base, 'GET', '/contacts', { token: op.token })).status, 401);

  assert.equal((await endedP).reason, 'operator-revoked');

  const h = await api(base, 'GET', '/history', { token: admin.token });
  const item = h.json.items.find((it) => it.id === sessionId);
  assert.equal(item.state, 'ended');
  assert.equal(item.endReason, 'operator-revoked');
  assert.equal(item.operatorName, null);

  const audit = await api(base, 'GET', '/audit', { token: admin.token });
  const entry = audit.json.items.find((a) => a.action === 'member.delete' && a.targetId === target.id);
  assert.ok(entry);
  assert.equal(entry.detail.login, 'удаляемый-опер');
  assert.equal(entry.detail.role, 'operator');
});

test('member.delete: RBAC, self-delete, последний админ и удаление админа новым админом', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  const aud = await inviteAndLogin(base, admin.token, 'auditor', 'наблюдатель-1', 'пароль-наблюдателя');

  const members = await api(base, 'GET', '/members', { token: admin.token });
  const self = members.json.items.find((u) => u.id === admin.user.id);
  assert.ok(self);

  assert.equal((await api(base, 'DELETE', `/members/${self.id}`)).status, 401);
  assert.equal((await api(base, 'DELETE', `/members/${self.id}`, { token: aud.token })).status, 403);
  assert.equal((await api(base, 'DELETE', '/members/нет-такого', { token: admin.token })).status, 404);

  // единственный активный админ: самоудаление запрещено
  const selfDel = await api(base, 'DELETE', `/members/${self.id}`, { token: admin.token });
  assert.equal(selfDel.status, 409);

  // второй админ: удаление первого проходит
  const second = await inviteAndLogin(base, admin.token, 'admin', 'второй-админ-1', 'пароль-второго');
  const del = await api(base, 'DELETE', `/members/${self.id}`, { token: second.token });
  assert.equal(del.status, 200);

  const after = await api(base, 'GET', '/members', { token: second.token });
  assert.ok(!after.json.items.some((u) => u.id === self.id));
  assert.equal((await api(base, 'GET', '/contacts', { token: admin.token })).status, 401);

  // оставшийся админ — последний: самоудаление снова 409
  const lastDel = await api(base, 'DELETE', `/members/${second.user.id}`, { token: second.token });
  assert.equal(lastDel.status, 409);
});
