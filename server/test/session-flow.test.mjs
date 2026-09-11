import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';

const OFFER = { description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' } };
const ANSWER = { description: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n' } };
const CAND = { candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0' } };

async function setup(t) {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath, leaseMs: 8000, heartbeatMs: 200, authTimeoutMs: 2000 });
  const admin = await adminLogin(dbPath, base);
  return { base, port, admin };
}

test('полный сценарий: register → claim → consent → WS relay → end', async (t) => {
  const { base, port, admin } = await setup(t);

  const reg = await api(base, 'POST', '/sessions');
  assert.equal(reg.status, 201);
  const { sessionId, password, hostToken } = reg.json;
  assert.match(sessionId, /^\d{9}$/);
  assert.equal(password.length, 8);
  assert.ok(!/[0O1lI|]/.test(password));

  // host WS аутентифицируется первым сообщением
  const host = wsConnect(port);
  const ready = await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  assert.equal(ready.state, 'waiting');
  assert.equal(ready.role, 'host');

  // claim с неверным паролем — общий отказ
  const badClaim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password: 'неверный' } });
  assert.equal(badClaim.status, 400);

  // claim корректный; ожидание сообщения вешаем до HTTP-вызова
  const claimMsgP = host.wait((m) => m.type === 'claim');
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password, contactId: null } });
  assert.equal(claim.status, 201);
  assert.equal(claim.json.state, 'pending-consent');
  assert.equal(claim.json.operator.name, 'Главный Енот');
  const { claimId } = claim.json;
  const claimMsg = await claimMsgP;
  assert.equal(claimMsg.claimId, claimId);
  assert.equal(claimMsg.operator.name, 'Главный Енот');

  // operator WS
  const op = wsConnect(port);
  const opReady = await wsAuth(op, { type: 'auth', role: 'operator', sessionId, token: admin.token, claimId });
  assert.equal(opReady.state, 'pending-consent');

  // сигнал до подтверждения отклонён
  op.send(JSON.stringify({ type: 'signal', data: OFFER }));
  const earlyErr = await op.wait((m) => m.type === 'error');
  assert.equal(earlyErr.code, 'not_approved');

  // решение host: согласие — оба получают approved
  const approvedHP = host.wait((m) => m.type === 'approved');
  const approvedOP = op.wait((m) => m.type === 'approved');
  const decision = await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: hostToken, body: { claimId, allow: true } });
  assert.equal(decision.status, 200);
  assert.equal((await approvedHP).claimId, claimId);
  assert.equal((await approvedOP).claimId, claimId);

  // relay: host → offer → operator; operator → answer + candidate → host
  const gotOfferP = op.wait((m) => m.type === 'signal' && m.data.description?.type === 'offer');
  host.send(JSON.stringify({ type: 'signal', data: OFFER }));
  assert.equal((await gotOfferP).data.description.sdp, OFFER.description.sdp);
  const gotAnswerP = host.wait((m) => m.type === 'signal' && m.data.description?.type === 'answer');
  const gotCandP = host.wait((m) => m.type === 'signal' && m.data.candidate);
  op.send(JSON.stringify({ type: 'signal', data: ANSWER }));
  op.send(JSON.stringify({ type: 'signal', data: CAND }));
  assert.equal((await gotAnswerP).data.description.sdp, ANSWER.description.sdp);
  assert.equal((await gotCandP).data.candidate.candidate, CAND.candidate.candidate);

  // второй оператор не получает чужие сигналы (изоляция сеансов)
  const reg2 = await api(base, 'POST', '/sessions');
  const claim2 = await api(base, 'POST', `/sessions/${reg2.json.sessionId}/claim`, {
    token: admin.token, body: { password: reg2.json.password },
  });
  const other = wsConnect(port);
  await wsAuth(other, { type: 'auth', role: 'operator', sessionId: reg2.json.sessionId, token: admin.token, claimId: claim2.json.claimId });
  const otherLeakP = other.wait((m) => m.type === 'signal', 400);
  host.send(JSON.stringify({ type: 'signal', data: { candidate: { candidate: 'candidate:second 1 udp 1 1 1 typ host' } } }));
  await assert.rejects(otherLeakP);

  // end от оператора — оба получают ended, host-сокет закрывается
  const endHP = host.wait((m) => m.type === 'ended');
  const endOP = op.wait((m) => m.type === 'ended');
  const hostCloseP = host.closeCode();
  const end = await api(base, 'POST', `/sessions/${sessionId}/end`, { token: admin.token, body: {} });
  assert.equal(end.status, 200);
  assert.equal((await endHP).reason, 'ended');
  assert.equal((await endOP).reason, 'ended');
  assert.equal(await hostCloseP, 1000);

  // повторный end легитимным вызывающим — идемпотентен
  const end2 = await api(base, 'POST', `/sessions/${sessionId}/end`, { token: hostToken, body: {} });
  assert.equal(end2.status, 200);

  // устаревший hostToken: WS и decision больше не работают
  const stale = wsConnect(port);
  await stale.opened;
  stale.send(JSON.stringify({ type: 'auth', role: 'host', sessionId, token: hostToken }));
  assert.equal(await stale.closeCode(), 4003);
  const staleDecision = await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: hostToken, body: { claimId, allow: true } });
  assert.equal(staleDecision.status, 403);
});

test('негативы: отказ в согласии, дубликат сокета, чужой decision, неверный сигнал', async (t) => {
  const { base, port, admin } = await setup(t);

  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  const { claimId } = claim.json;
  const op = wsConnect(port);
  await wsAuth(op, { type: 'auth', role: 'operator', sessionId, token: admin.token, claimId });

  // decision не-hostToken отклоняется
  const badDecision = await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: admin.token, body: { claimId, allow: true } });
  assert.equal(badDecision.status, 403);

  // дубликат host-сокета отклоняется
  const dup = wsConnect(port);
  await dup.opened;
  dup.send(JSON.stringify({ type: 'auth', role: 'host', sessionId, token: hostToken }));
  assert.equal(await dup.closeCode(), 4004);

  // approval и неверная форма сигнала
  const approvedP = host.wait((m) => m.type === 'approved');
  await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: hostToken, body: { claimId, allow: true } });
  await approvedP;
  host.send(JSON.stringify({ type: 'signal', data: { evil: 'cross-session-injection' } }));
  assert.equal((await host.wait((m) => m.type === 'error')).code, 'bad_signal');

  // отказ клиента: ended у оператора с reason denied
  const reg3 = await api(base, 'POST', '/sessions');
  const claim3 = await api(base, 'POST', `/sessions/${reg3.json.sessionId}/claim`, { token: admin.token, body: { password: reg3.json.password } });
  const op3 = wsConnect(port);
  await wsAuth(op3, { type: 'auth', role: 'operator', sessionId: reg3.json.sessionId, token: admin.token, claimId: claim3.json.claimId });
  const deniedP = op3.wait((m) => m.type === 'ended');
  await api(base, 'POST', `/sessions/${reg3.json.sessionId}/decision`, { token: reg3.json.hostToken, body: { claimId: claim3.json.claimId, allow: false } });
  assert.equal((await deniedP).reason, 'denied');
  // повторный claim завершённого сеанса невозможен
  const recl = await api(base, 'POST', `/sessions/${reg3.json.sessionId}/claim`, { token: admin.token, body: { password: reg3.json.password } });
  assert.equal(recl.status, 400);
});

test('WS: первый пакет должен быть auth в течение таймаута; иное — закрытие', async (t) => {
  const { port } = await setup(t);
  const ws = wsConnect(port);
  await ws.opened;
  ws.send(JSON.stringify({ type: 'signal', data: OFFER }));
  assert.equal(await ws.closeCode(), 4002);
});
