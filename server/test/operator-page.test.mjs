import test from 'node:test';
import assert from 'node:assert/strict';

// Браузерный оператор (spec: истории 14, 15, 19). Проверяем серверную поверхность
// страницы /operator (RBAC по ролям, CSP, статика) и полный цикл подключения
// браузерного оператора к фейк-пиру: login → claim → WS /signal → offer/answer
// (тот же протокол, что у desktop; сам WebRTC в браузере — ручная приёмка).

import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';

async function html(base, p, { token, cookie } = {}) {
  const res = await fetch(base + p, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  return { status: res.status, csp: res.headers.get('content-security-policy'), body: await res.text() };
}

test('/operator: без аутентификации — 401 и форма входа; оператору/админу — 200; аудитору — 403', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  const { token } = await adminLogin(dbPath, base); // админ

  const anon = await html(base, '/operator');
  assert.equal(anon.status, 401);
  assert.match(anon.body, /id="login-form"/, 'анониму видна только форма входа');

  const admin = await html(base, '/operator', { token });
  assert.equal(admin.status, 200);
  assert.match(admin.body, /id="op-remote"/);
  assert.match(admin.csp ?? '', /script-src 'self'/, 'CSP аналогичен desktop: скрипты только свои');
  assert.match(admin.csp ?? '', /connect-src 'self'/, 'same-origin fetch и WS');
  assert.doesNotMatch(admin.body, /<script(?![^>]*\bsrc=)/, 'без inline-скриптов');

  // аудитору страница оператора не отдаётся — только чтение, как в desktop
  const invite = await api(base, 'POST', '/invites', { token, body: { role: 'auditor' } });
  const reg = await fetch(base + '/api/v1/invites/accept', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: invite.json.token, login: 'aud-one', name: 'Аудитор', password: 'Пароль-аудита-123' }),
  });
  assert.equal(reg.status, 200);
  const audLogin = await api(base, 'POST', '/auth/login', { body: { login: 'aud-one', password: 'Пароль-аудита-123' } });
  const aud = await html(base, '/operator', { token: audLogin.json.token });
  assert.equal(aud.status, 403);

  // cookie (как её ставит страница) несёт только роль для выбора варианта HTML
  // (SEC-008): admin/operator → 200, аудитор → 403, мусор → 401. Токен в cookie
  // не живёт — каждый /api и WS всё равно за Bearer-RBAC.
  assert.equal((await html(base, '/operator', { cookie: 'enot_op=admin' })).status, 200);
  assert.equal((await html(base, '/operator', { cookie: 'enot_op=operator' })).status, 200);
  assert.equal((await html(base, '/operator', { cookie: 'enot_op=auditor' })).status, 403);
  assert.equal((await html(base, '/operator', { cookie: 'enot_op=garbage' })).status, 401);
});

test('статика страницы оператора: модули и словари отдаются, traversal — 404', async (t) => {
  const { base } = await startServer(t);
  const mod = await fetch(`${base}/web/operator.mjs`);
  assert.equal(mod.status, 200);
  assert.match(mod.headers.get('content-type') ?? '', /text\/javascript/);
  assert.match(await mod.text(), /wireBrowserInput/);
  assert.equal((await fetch(`${base}/web/input-source.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/client/lib/i18n.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/client/renderer/dom.js`)).status, 200);
  assert.equal((await fetch(`${base}/client/locales/ru.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/client/locales/de.mjs`)).status, 404, 'словари только ru/en');
  assert.equal((await fetch(`${base}/client/lib/../main.mjs`)).status, 404, 'вне allowlist ничего не отдаётся');
  assert.equal((await fetch(`${base}/web/nope.mjs`)).status, 404);
});

test('браузерный цикл: login → claim → WS → offer/answer с фейк-пиром → end', async (t) => {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath, leaseMs: 8000, heartbeatMs: 200, authTimeoutMs: 2000 });
  const { token } = await adminLogin(dbPath, base);

  // клиент помощи создаёт сеанс (как в приложении)
  const created = await api(base, 'POST', '/sessions');
  assert.equal(created.status, 201);
  const { sessionId, password, hostToken } = created.json;

  // фейк-пир (хост) сидит на WS
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });

  // оператор из браузера: login и claim — те же REST-вызовы, что делает страница
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token, body: { password } });
  assert.equal(claim.status, 201);
  const { claimId } = claim.json;
  assert.equal(typeof claimId, 'string');
  await host.wait((m) => m.type === 'claim');

  // клиент соглашается — обе стороны получают approved
  const decision = await api(base, 'POST', `/sessions/${sessionId}/decision`, {
    token: hostToken, body: { claimId, allow: true },
  });
  assert.equal(decision.status, 200);
  await host.wait((m) => m.type === 'approved');

  // страница открывает WS и отвечает на оффер клиента; сигнал доходит до хоста
  const op = wsConnect(port);
  const ready = await wsAuth(op, { type: 'auth', role: 'operator', sessionId, claimId, token });
  assert.equal(ready.type, 'ready');
  assert.equal(ready.role, 'operator');
  await op.wait((m) => m.type === 'approved');

  const offer = { type: 'signal', data: { description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' } } };
  host.send(JSON.stringify(offer));
  const relayed = await op.wait((m) => m.type === 'signal' && m.data?.description?.type === 'offer');
  assert.equal(relayed.data.description.sdp, offer.data.description.sdp);

  const answer = { type: 'signal', data: { description: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n' } } };
  op.send(JSON.stringify(answer));
  const back = await host.wait((m) => m.type === 'signal' && m.data?.description?.type === 'answer');
  assert.equal(back.data.description.sdp, answer.data.description.sdp);

  // завершение с операторской стороны — хост получает ended (кнопка «Завершить»)
  const end = await api(base, 'POST', `/sessions/${sessionId}/end`, { token });
  assert.equal(end.status, 200);
  assert.equal((await host.wait((m) => m.type === 'ended')).reason, 'ended');
  host.close();
  op.close();
});

test('RBAC аудитора в цикле браузерного оператора: claim — 403', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  const { token } = await adminLogin(dbPath, base);
  const invite = await api(base, 'POST', '/invites', { token, body: { role: 'auditor' } });
  await fetch(base + '/api/v1/invites/accept', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: invite.json.token, login: 'aud-two', name: 'Аудитор', password: 'Пароль-аудита-123' }),
  });
  const aud = await api(base, 'POST', '/auth/login', { body: { login: 'aud-two', password: 'Пароль-аудита-123' } });
  const created = await api(base, 'POST', '/sessions');
  const { sessionId } = created.json;
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: aud.json.token, body: { password: 'любой' } });
  assert.equal(claim.status, 403);
  assert.equal(claim.json.error.code, 'forbidden');
});
