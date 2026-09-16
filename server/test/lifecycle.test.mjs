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

  const { hostToken, host } = await makeSession(base, port, admin);
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

test('потеря host-сокета завершает сеанс и уведомляет оператора (graceMs=0, fail-closed)', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200, graceMs: 0 });
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

test('потеря operator-сокета завершает сеанс и уведомляет host (graceMs=0, fail-closed)', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200, graceMs: 0 });
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

// ---- грейс переподключения (ADR 0013) ----

async function approvedSession(base, port, admin) {
  const reg = await api(base, 'POST', '/sessions');
  const s = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });
  const claim = await api(base, 'POST', `/sessions/${s.sessionId}/claim`, { token: admin.token, body: { password: s.password } });
  const claimId = claim.json.claimId;
  const op = wsConnect(port);
  await wsAuth(op, { type: 'auth', role: 'operator', sessionId: s.sessionId, token: admin.token, claimId });
  await api(base, 'POST', `/sessions/${s.sessionId}/decision`, { token: s.hostToken, body: { claimId, allow: true } });
  await host.wait((m) => m.type === 'approved');
  await op.wait((m) => m.type === 'approved');
  return { s, host, op, claimId };
}

test('грейс: host переподключается тем же токеном — сеанс жив, обе стороны получают resumed', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 400, heartbeatMs: 200, graceMs: 5000 });
  const { s, host, op, claimId } = await approvedSession(base, port, admin);

  const peerNoteP = op.wait((m) => m.type === 'peer-reconnecting');
  host.close(); // host «обрывается»
  assert.equal((await peerNoteP).role, 'host');

  // в грейсе lease не судья: heartbeat не идут дольше leaseMs, но сеанс не завершился
  await new Promise((r) => setTimeout(r, 700));

  const host2 = wsConnect(port);
  const ready = await wsAuth(host2, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });
  assert.equal(ready.state, 'approved');
  // replay approved: ворота ввода на клиенте открываются только реальным approved
  assert.equal((await host2.wait((m) => m.type === 'approved')).claimId, claimId);
  assert.equal((await host2.wait((m) => m.type === 'resumed')).type, 'resumed');
  assert.equal((await op.wait((m) => m.type === 'resumed')).type, 'resumed');

  // heartbeat после переподключения снова продлевает lease
  host2.send(JSON.stringify({ type: 'heartbeat' }));
  assert.equal((await host2.wait((m) => m.type === 'heartbeat')).type, 'heartbeat');
});

test('грейс: operator переподключается — claimId тот же, resumed обоим', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200, graceMs: 5000 });
  const { s, host, op, claimId } = await approvedSession(base, port, admin);

  const peerNoteP = host.wait((m) => m.type === 'peer-reconnecting');
  op.close();
  assert.equal((await peerNoteP).role, 'operator');

  const op2 = wsConnect(port);
  const ready = await wsAuth(op2, { type: 'auth', role: 'operator', sessionId: s.sessionId, token: admin.token, claimId });
  assert.equal(ready.state, 'approved');
  assert.equal((await op2.wait((m) => m.type === 'approved')).claimId, claimId);
  await host.wait((m) => m.type === 'resumed');
  await op2.wait((m) => m.type === 'resumed');
});

test('грейс: переподключение другим токеном и до согласия — по-прежнему отказ', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 400, heartbeatMs: 200, graceMs: 5000 });
  const { s, host } = await approvedSession(base, port, admin);

  // чужой hostToken не пускаем и в грейсе (сервер закрывает 4003 без сообщения)
  const other = await api(base, 'POST', '/sessions');
  const intruder = wsConnect(port);
  await intruder.opened;
  intruder.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: s.sessionId, token: other.json.hostToken }));
  assert.equal(await intruder.closeCode(), 4003);

  // до approval обрыв мгновенно завершает сеанс, грейс не применяется
  const reg = await api(base, 'POST', '/sessions');
  const h2 = wsConnect(port);
  await wsAuth(h2, { type: 'auth', role: 'host', sessionId: reg.json.sessionId, token: reg.json.hostToken });
  await api(base, 'POST', `/sessions/${reg.json.sessionId}/claim`, { token: admin.token, body: { password: reg.json.password } });
  h2.close();
  await new Promise((r) => setTimeout(r, 150));
  const h = await api(base, 'GET', '/history', { token: admin.token });
  const row = h.json.items.find((it) => it.id === reg.json.sessionId);
  assert.equal(row.state, 'ended');
  assert.equal(row.endReason, 'host-lost');
  void host;
});

test('грейс: истёкший грейс завершает сеанс как host-lost/operator-lost', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 60_000, heartbeatMs: 200, graceMs: 1200 });
  const { host, op } = await approvedSession(base, port, admin);

  const resumed = op.wait((m) => m.type === 'ended', 4000);
  host.close();
  const ended = await resumed;
  assert.equal(ended.reason, 'host-lost', 'по истечении грейса сеанс завершается с честной причиной');
});

test('потолок живых сеансов: новые отклоняются (4005), свои и после освобождения слота — да', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200, graceMs: 0, maxSessions: 1 });
  const reg = await api(base, 'POST', '/sessions');
  const s = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });

  // свой оператор подключается, хотя потолок уже достигнут (сеанс A уже в live)
  const claim = await api(base, 'POST', `/sessions/${s.sessionId}/claim`, { token: admin.token, body: { password: s.password } });
  const op = wsConnect(port);
  const opReady = await wsAuth(op, { type: 'auth', role: 'operator', sessionId: s.sessionId, token: admin.token, claimId: claim.json.claimId });
  assert.equal(opReady.type, 'ready');

  // новый сеанс B — новый live-запись — отклонён честным server-busy
  const reg2 = await api(base, 'POST', '/sessions');
  const busy = wsConnect(port);
  await busy.opened;
  busy.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: reg2.json.sessionId, token: reg2.json.hostToken }));
  assert.equal(await busy.closeCode(), 4005);

  // завершение A освобождает слот — B подключается
  await api(base, 'POST', `/sessions/${s.sessionId}/end`, { token: s.hostToken, body: {} });
  const retry = wsConnect(port);
  const ready = await wsAuth(retry, { type: 'auth', role: 'host', sessionId: reg2.json.sessionId, token: reg2.json.hostToken });
  assert.equal(ready.type, 'ready');
});
