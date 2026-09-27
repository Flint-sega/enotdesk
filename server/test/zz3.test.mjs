import test from 'node:test';
import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';

test('diag decision', async (t) => {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  console.log('claim:', claim.status, JSON.stringify(claim.json).slice(0, 160));
  const decision = await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: hostToken, body: { claimId: claim.json.claimId, allow: true } });
  console.log('decision:', decision.status, JSON.stringify(decision.json).slice(0, 160));
});
