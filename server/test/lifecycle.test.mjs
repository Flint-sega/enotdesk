import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';

async function setup(t, extra = {}) {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath, ...extra });
  const admin = await adminLogin(dbPath, base);
  return { base, port, admin };
}

async function makeSession(base, port, admin) {
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  const { claimId } = claim.json;
  return { sessionId, hostToken, host, claimId };
}

test('heartbeat обновляет lease: без него сеанс истекает, с ним живёт', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 700, heartbeatMs: 200 });

  const { sessionId, hostToken, host } = await makeSession(base, port, admin);
  // держим heartbeat ~1.4с (два lease-периода) — сеанс жив
  const ackP = host.wait((m) => m.type === 'heartbeat');
  for (let i = 0; i < 9; i++) {
    host.send(JSON.stringify({ type: 'heartbeat' }));
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal((await ackP).type, 'heartbeat');
  const endedP = host.wait((m) => m.type === 'ended', 3000);
  // перестаём слать — через lease сеанс истекает
  const h = await api(base, 'GET', '/history', { token: admin.token });
  assert.equal(h.json.items[0].state, 'pending-consent');
  const ended = await endedP;
  assert.equal(ended.reason, 'lease-expired');
  // наблюдаемое следствие: hostToken завершённого сеанса больше не даёт rtc-config
  const rtcAfter = await api(base, 'GET', '/rtc-config', { token: hostToken });
  assert.equal(rtcAfter.status, 401);
});

test('потеря host-сокета завершает сеанс и уведомляет оператора', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200 });
  const reg = await api(base, 'POST', '/sessions');
  const s = reg.json;
  const host2 = wsConnect(port);
  await wsAuth(host2, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });
  const claim2 = await api(base, 'POST', `/sessions/${s.sessionId}/claim`, { token: admin.token, body: { password: s.password } });
  const op2 = wsConnect(port);
  await wsAuth(op2, { type: 'auth', role: 'operator', sessionId: s.sessionId, token: admin.token, claimId: claim2.json.claimId });

  const endedP = op2.wait((m) => m.type === 'ended');
  host2.close(); // host уходит без end
  assert.equal((await endedP).reason, 'host-lost');
});

test('потеря operator-сокета завершает сеанс и уведомляет host', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200 });
  const reg = await api(base, 'POST', '/sessions');
  const s = reg.json;
  const h2 = wsConnect(port);
  await wsAuth(h2, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });
  const c2 = await api(base, 'POST', `/sessions/${s.sessionId}/claim`, { token: admin.token, body: { password: s.password } });
  const op = wsConnect(port);
  await wsAuth(op, { type: 'auth', role: 'operator', sessionId: s.sessionId, token: admin.token, claimId: c2.json.claimId });

  const endedP = h2.wait((m) => m.type === 'ended');
  op.close();
  assert.equal((await endedP).reason, 'operator-lost');
});

test('host подключается после claim: получает pending-consent и отложенный claim', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200 });
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  const { claimId } = claim.json;

  const host = wsConnect(port);
  const ready = await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  assert.equal(ready.state, 'pending-consent');
  const claimMsg = await host.wait((m) => m.type === 'claim');
  assert.equal(claimMsg.claimId, claimId);
});

test('operator подключается после approval: сразу получает approved', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200 });
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  const { claimId } = claim.json;
  await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: hostToken, body: { claimId, allow: true } });

  const op = wsConnect(port);
  const ready = await wsAuth(op, { type: 'auth', role: 'operator', sessionId, token: admin.token, claimId });
  assert.equal(ready.state, 'approved');
  const approved = await op.wait((m) => m.type === 'approved');
  assert.equal(approved.claimId, claimId);
});
