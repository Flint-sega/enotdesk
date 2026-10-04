import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';

// Мультиоператор (модель RustDesk): N подписчиков на один поток; offer
// адресуется (to=claimId), answer/ICE оператора тегируются (from=claimId).

async function setup(t, extra = {}) {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath, ...extra });
  const admin = await adminLogin(dbPath, base);
  return { base, port, admin };
}

// Второй оператор — отдельный юзер (invite → accept → login), как в lifecycle.
let opSeq = 0;
async function newOperatorToken(base, admin) {
  const login = `op-mt-${++opSeq}`;
  const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'operator' } });
  await api(base, 'POST', '/invites/accept', { body: { token: inv.json.token, login, name: `Оп ${opSeq}`, password: 'operator-pass-2' } });
  const r = await api(base, 'POST', '/auth/login', { body: { login, password: 'operator-pass-2' } });
  assert.equal(r.status, 200);
  return r.json.token;
}

// Живой approved-сеанс: хост + первый оператор (consent-маршрут).
async function approvedSession(base, port, admin) {
  const reg = await api(base, 'POST', '/sessions');
  const s = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });
  const claim = await api(base, 'POST', `/sessions/${s.sessionId}/claim`, { token: admin.token, body: { password: s.password } });
  assert.equal(claim.status, 201);
  const op = wsConnect(port);
  await wsAuth(op, { type: 'auth', role: 'operator', sessionId: s.sessionId, token: admin.token, claimId: claim.json.claimId });
  await api(base, 'POST', `/sessions/${s.sessionId}/decision`, { token: s.hostToken, body: { claimId: claim.json.claimId, allow: true } });
  await op.wait((m) => m.type === 'approved');
  return { sessionId: s.sessionId, password: s.password, hostToken: s.hostToken, host, op, claimId: claim.json.claimId };
}

test('operator-joined несёт claimId; operator-left при уходе', async (t) => {
  const { base, port, admin } = await setup(t);
  const { sessionId, password, host } = await approvedSession(base, port, admin);
  // первый оператор уже прицеплен WS'ом; проверяем join в approved по паролю
  const op2Token = await newOperatorToken(base, admin);
  const join = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: op2Token, body: { password } });
  assert.equal(join.status, 201);
  const joined = await host.wait((m) => m.type === 'operator-joined' && m.claimId === join.json.claimId);
  assert.equal(joined.operator.login.startsWith('op-mt-'), true);

  // уход оператора: хост получает operator-left с тем же claimId
  const op2 = wsConnect(port);
  await wsAuth(op2, { type: 'auth', role: 'operator', sessionId, token: op2Token, claimId: join.json.claimId });
  await host.wait((m) => m.type === 'operator-joined' && m.claimId === join.json.claimId);
  op2.close();
  const left = await host.wait((m) => m.type === 'operator-left');
  assert.equal(left.claimId, join.json.claimId);
  host.close();
});

test('offer с to идёт только адресату; answer/ICE оператора тегированы from', async (t) => {
  const { base, port, admin } = await setup(t);
  const { sessionId, password, host, op: op1, claimId: c1 } = await approvedSession(base, port, admin);
  // хост шлёт адресованный offer оператору №1
  host.send(JSON.stringify({ type: 'signal', to: c1, data: { description: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n' } } }));
  const got = await op1.wait((m) => m.type === 'signal' && m.data?.description?.type === 'offer');
  assert.match(got.data.description.sdp, /o=- 1 2/);

  // второй оператор (отдельный юзер) join'ится в живой сеанс
  const op2Token = await newOperatorToken(base, admin);
  const join = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: op2Token, body: { password } });
  assert.equal(join.status, 201);
  const op2 = wsConnect(port);
  await wsAuth(op2, { type: 'auth', role: 'operator', sessionId, token: op2Token, claimId: join.json.claimId });
  await host.wait((m) => m.type === 'operator-joined' && m.claimId === join.json.claimId);
  void password;

  host.send(JSON.stringify({ type: 'signal', to: join.json.claimId, data: { description: { type: 'offer', sdp: 'v=0\r\no=- 7 7 IN IP4 127.0.0.1\r\ns=-\r\n' } } }));
  const got2 = await op2.wait((m) => m.type === 'signal' && m.data?.description?.type === 'offer');
  assert.match(got2.data.description.sdp, /o=- 7 7/);
  // op1 НЕ получает чужой offer
  assert.equal(op1.log.some((m) => m.type === 'signal' && m.data?.description?.sdp?.includes('o=- 7 7')), false);

  // answer/ICE оператора тегированы from=claimId
  op1.send(JSON.stringify({ type: 'signal', data: { description: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\n' } } }));
  const ans = await host.wait((m) => m.type === 'signal' && m.data?.description?.type === 'answer');
  assert.equal(ans.from, c1);
  op1.send(JSON.stringify({ type: 'signal', data: { candidate: { candidate: 'candidate:9 udp 1 10.0.0.9 9 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 } } }));
  const cand = await host.wait((m) => m.type === 'signal' && m.data?.candidate);
  assert.equal(cand.from, c1);
  host.close(); op2.close();
});

test('offer без to — fan-out всем операторам (машина-хост, прежний поток)', async (t) => {
  const { base, port, admin } = await setup(t);
  const { sessionId, password, host, op: op1 } = await approvedSession(base, port, admin);
  const op2Token = await newOperatorToken(base, admin);
  const join = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: op2Token, body: { password } });
  assert.equal(join.status, 201);
  const op2 = wsConnect(port);
  await wsAuth(op2, { type: 'auth', role: 'operator', sessionId, token: op2Token, claimId: join.json.claimId });
  await host.wait((m) => m.type === 'operator-joined' && m.claimId === join.json.claimId);
  void password;

  host.send(JSON.stringify({ type: 'signal', data: { description: { type: 'offer', sdp: 'v=0\r\no=- 5 5 IN IP4 127.0.0.1\r\ns=-\r\n' } } }));
  await op1.wait((m) => m.type === 'signal' && m.data?.description);
  await op2.wait((m) => m.type === 'signal' && m.data?.description);
  host.close(); op2.close();
});

test('уход одного оператора не завершает сеанс при живом втором', async (t) => {
  const { base, port, admin } = await setup(t);
  const { sessionId, password, host, op: op1 } = await approvedSession(base, port, admin);
  const op2Token = await newOperatorToken(base, admin);
  const join = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: op2Token, body: { password } });
  assert.equal(join.status, 201);
  const op2 = wsConnect(port);
  await wsAuth(op2, { type: 'auth', role: 'operator', sessionId, token: op2Token, claimId: join.json.claimId });
  await host.wait((m) => m.type === 'operator-joined' && m.claimId === join.json.claimId);
  void password;

  // первый оператор отвалился: сеанс жив, второй подключён
  op1.close();
  const left = await host.wait((m) => m.type === 'operator-left');
  assert.notEqual(left.claimId, join.json.claimId);
  await new Promise((r) => setTimeout(r, 400));
  const h = await api(base, 'GET', '/history?limit=1', { token: admin.token });
  const last = (h.json?.items ?? [])[0] ?? {};
  assert.notEqual(last.endReason, 'operator-lost');
  assert.equal(last.endedAt ?? null, null);
  // второй оператор продолжает получать сигналы хоста
  host.send(JSON.stringify({ type: 'signal', data: { candidate: { candidate: 'c2', sdpMid: '0' } } }));
  await op2.wait((m) => m.type === 'signal' && m.data?.candidate?.candidate === 'c2');
  host.close(); op2.close();
});
