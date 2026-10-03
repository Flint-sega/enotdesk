import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';

// Реплей offer/ICE позднему оператору (приёмка 03.10: WS оператора прицепился
// позже approve — offer хоста умирал в пустоту, видео не появлялось никогда).

async function setup(t, extra = {}) {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath, ...extra });
  const admin = await adminLogin(dbPath, base);
  return { base, port, admin };
}

const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n' };

test('поздний оператор получает сохранённый offer + ICE; новый offer заменяет буфер', async (t) => {
  const { base, port, admin } = await setup(t);

  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });

  // первый оператор: claim+approve до всяких offer
  const claim1 = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  const { claimId } = claim1.json;
  const op1 = wsConnect(port);
  await wsAuth(op1, { type: 'auth', role: 'operator', sessionId, claimId, token: admin.token });
  await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: hostToken, body: { claimId, allow: true } });
  await op1.wait((m) => m.type === 'approved');

  // хост шлёт offer + ICE: живому сокету доходит, буфер наполняется
  host.send(JSON.stringify({ type: 'signal', data: { description: { type: 'offer', sdp: OFFER.sdp } } }));
  host.send(JSON.stringify({ type: 'signal', data: { candidate: { candidate: 'candidate:1 udp 1 10.0.0.1 1 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 } } }));
  host.send(JSON.stringify({ type: 'signal', data: { candidate: { candidate: 'candidate:2 udp 1 10.0.0.2 2 typ host generation 0', sdpMid: '1', sdpMLineIndex: 1 } } }));
  await op1.wait((m) => m.type === 'signal' && m.data?.candidate);

  // второй оператор прицепился ПОСЛЕ offer (fresh attach): должен получить
  // реплей approved + сохранённый offer + оба ICE
  const claim2 = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  assert.equal(claim2.status, 201);
  const op2 = wsConnect(port);
  await wsAuth(op2, { type: 'auth', role: 'operator', sessionId, claimId: claim2.json.claimId, token: admin.token });
  await op2.wait((m) => m.type === 'approved');
  const offer2 = await op2.wait((m) => m.type === 'signal' && m.data?.description?.type === 'offer');
  assert.equal(offer2.data.description.sdp, OFFER.sdp);
  await op2.wait((x) => x.type === 'signal' && x.data?.candidate?.candidate?.includes('candidate:2'));
  const cand2 = op2.log.filter((x) => x.type === 'signal' && x.data?.candidate).map((x) => x.data.candidate.candidate);
  assert.deepEqual([...cand2].sort(), ['candidate:1 udp 1 10.0.0.1 1 typ host generation 0', 'candidate:2 udp 1 10.0.0.2 2 typ host generation 0']);

  // новый offer от хоста заменяет буфер: старые кандидаты не реплеятся
  host.send(JSON.stringify({ type: 'signal', data: { description: { type: 'offer', sdp: 'v=0\r\no=- 9 9 IN IP4 127.0.0.1\r\ns=-\r\n' } } }));
  host.send(JSON.stringify({ type: 'signal', data: { candidate: { candidate: 'candidate:3 udp 1 10.0.0.3 3 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 } } }));

  const claim3 = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  const op3 = wsConnect(port);
  await wsAuth(op3, { type: 'auth', role: 'operator', sessionId, claimId: claim3.json.claimId, token: admin.token });
  await op3.wait((m) => m.type === 'approved');
  const offer3 = await op3.wait((m) => m.type === 'signal' && m.data?.description?.type === 'offer');
  assert.match(offer3.data.description.sdp, /o=- 9 9/);
  const c3 = await op3.wait((x) => x.type === 'signal' && x.data?.candidate);
  assert.match(c3.data.candidate.candidate, /candidate:3/);
  host.close(); op1.close(); op2.close(); op3.close();
});
