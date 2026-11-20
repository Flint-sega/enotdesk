import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startServer, wsAuth, wsConnect } from './util.mjs';

async function startHelp(base) {
  const created = await api(base, 'POST', '/sessions', { body: {} });
  assert.equal(created.status, 201);
  return created.json;
}

test('guest invitations are off by default', async (t) => {
  const { base } = await startServer(t);
  const { sessionId, hostToken } = await startHelp(base);
  const invite = await api(base, 'POST', `/sessions/${sessionId}/guest-invite`, { token: hostToken });
  assert.equal(invite.status, 404);
});

test('the operator page advertises guest help only when the server enables it', async (t) => {
  for (const enabled of [false, true]) {
    const { base } = await startServer(t, { guestHelp: enabled });
    const page = await fetch(`${base}/operator`);
    const html = await page.text();
    assert.match(html, new RegExp(`data-guest-help="${enabled ? '1' : '0'}"`));
    assert.match(html, /id="login-form"/);
    assert.match(html, /id="guest-form"/);
  }
});

test('a guest invitation is single-use and grants only the approved help session', async (t) => {
  const { base, port } = await startServer(t, { guestHelp: true, leaseMs: 15_000 });
  const { sessionId, hostToken, password } = await startHelp(base);
  const other = await startHelp(base);
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const invitePath = `/sessions/${sessionId}/guest-invite`;
  assert.equal((await api(base, 'POST', invitePath, { token: other.hostToken })).status, 403);
  assert.equal((await api(base, 'POST', `/sessions/${sessionId}/claim`, { body: { password } })).status, 401);
  const invitation = await api(base, 'POST', invitePath, { token: hostToken });
  assert.equal(invitation.status, 201);
  const redeem = () => api(base, 'POST', '/guest/claim', { body: { invite: invitation.json.invite } });
  const claims = (await Promise.all([redeem(), redeem()])).sort((a, b) => a.status - b.status);
  assert.deepEqual(claims.map(({ status }) => status), [201, 404]);
  const { claimId, token } = claims[0].json;
  await assert.rejects(host.wait((m) => m.type === 'claim', 80), /timeout/);
  assert.equal((await api(base, 'GET', '/auth/me', { token })).status, 401);
  assert.equal((await api(base, 'GET', '/machines', { token })).status, 401);
  assert.equal((await api(base, 'GET', '/rtc-config', { token })).status, 401);
  assert.equal((await api(base, 'POST', `/sessions/${other.sessionId}/end`, { token })).status, 403);
  const guest = wsConnect(port);
  const auth = { type: 'auth', role: 'operator', sessionId, claimId, token };
  assert.equal((await wsAuth(guest, auth)).state, 'pending-consent');
  assert.equal((await host.wait((m) => m.type === 'claim')).claimId, claimId);
  const signal = { type: 'signal', data: { description: { type: 'answer', sdp: 'v=0' } } };
  guest.send(JSON.stringify(signal));
  await assert.rejects(host.wait((m) => m.type === 'signal', 80), /timeout/);
  const decision = await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: hostToken, body: { claimId, allow: true } });
  assert.equal(decision.status, 200);
  await guest.wait((m) => m.type === 'approved');
  assert.equal((await api(base, 'GET', '/rtc-config', { token })).status, 200);
  guest.send(JSON.stringify(signal));
  assert.equal((await host.wait((m) => m.type === 'signal')).from, claimId);
  assert.equal((await api(base, 'POST', `/sessions/${sessionId}/end`, { token })).status, 200);
  await guest.wait((m) => m.type === 'ended');
  assert.equal((await api(base, 'GET', '/rtc-config', { token })).status, 401);
});

test('the standalone pilot exposes only guest help and issues TURN credentials after consent', async (t) => {
  const { base, port } = await startServer(t, {
    guestOnly: true,
    turnUrls: 'turn:203.0.113.1:13478?transport=tcp',
    turnSecret: 'test-only-turn-secret-for-guest-pilot',
  });
  const health = await api(base, 'GET', '/health');
  assert.equal(health.json.guestOnly, true);
  assert.equal(health.json.guestHelp, true);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.equal(new URL(page.url).pathname, '/operator');
  const html = await page.text();
  assert.match(html, /data-guest-only="1"/);
  assert.match(html, /id="guest-form"/);
  assert.doesNotMatch(html, /id="login-form"/);
  assert.equal((await fetch(`${base}/web/operator.mjs`)).status, 200);

  const created = await api(base, 'POST', '/sessions', { body: { hostId: '123456789' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.hostId, undefined);
  const { sessionId, hostToken } = created.json;
  for (const [method, route] of [
    ['POST', '/auth/login'], ['GET', '/auth/me'], ['GET', '/machines'], ['POST', '/relay'],
    ['GET', '/downloads'], ['POST', `/sessions/${sessionId}/claim`],
  ]) {
    assert.equal((await api(base, method, route)).status, 404, route);
  }
  assert.equal((await fetch(`${base}/health`)).status, 404);
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const invitation = await api(base, 'POST', `/sessions/${sessionId}/guest-invite`, { token: hostToken });
  assert.equal(invitation.status, 201);
  const claim = await api(base, 'POST', '/guest/claim', { body: { invite: invitation.json.invite } });
  assert.equal(claim.status, 201);
  const { claimId, token } = claim.json;
  const guest = wsConnect(port);
  await wsAuth(guest, { type: 'auth', role: 'operator', sessionId, claimId, token });
  assert.equal((await host.wait((m) => m.type === 'claim')).claimId, claimId);

  for (const participant of [hostToken, token]) {
    assert.equal((await api(base, 'GET', '/rtc-config', { token: participant })).status, 401);
  }
  const decision = await api(base, 'POST', `/sessions/${sessionId}/decision`, {
    token: hostToken, body: { claimId, allow: true },
  });
  assert.equal(decision.status, 200);
  await guest.wait((m) => m.type === 'approved');
  for (const participant of [hostToken, token]) {
    const rtc = await api(base, 'GET', '/rtc-config', { token: participant });
    assert.equal(rtc.status, 200);
    assert.equal(rtc.json.iceTransportPolicy, 'relay');
    assert.match(rtc.json.iceServers[0].credential, /^[A-Za-z0-9+/]+=*$/);
  }

  const end = await api(base, 'POST', `/sessions/${sessionId}/end`, { token: hostToken });
  assert.equal(end.status, 200);
  await guest.wait((m) => m.type === 'ended');
  assert.equal((await api(base, 'GET', '/rtc-config', { token })).status, 401);
});

test('a guest who never opens signaling does not strand the host session', async (t) => {
  let now = Date.now();
  const { base, port } = await startServer(t, {
    guestHelp: true, leaseMs: 15_000, sweeperMs: 15, nowMs: () => now,
  });
  const { sessionId, hostToken } = await startHelp(base);
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const issue = () => api(base, 'POST', `/sessions/${sessionId}/guest-invite`, { token: hostToken });
  const invitation = await issue();
  const claim = await api(base, 'POST', '/guest/claim', { body: { invite: invitation.json.invite } });
  assert.equal(claim.status, 201);
  now += 10_001;
  await assert.rejects(host.wait((m) => m.type === 'claim', 80), /timeout/);
  assert.equal((await issue()).status, 201);
  assert.equal((await api(base, 'POST', `/sessions/${sessionId}/end`, { token: claim.json.token })).status, 403);
});

test('replacing an invitation invalidates the old link and the new one expires', async (t) => {
  let now = Date.now();
  const { base } = await startServer(t, { guestHelp: true, leaseMs: 15_000, nowMs: () => now });
  const { sessionId, hostToken } = await startHelp(base);
  const issue = () => api(base, 'POST', `/sessions/${sessionId}/guest-invite`, { token: hostToken });
  const first = await issue();
  const second = await issue();
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const redeem = (invite) => api(base, 'POST', '/guest/claim', { body: { invite } });
  assert.equal((await redeem(first.json.invite)).status, 404);
  now += 5 * 60 * 1000 + 1;
  assert.equal((await redeem(second.json.invite)).status, 404);
});
