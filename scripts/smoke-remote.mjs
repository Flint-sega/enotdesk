// Внешний smoke-тест развёрнутого EnotDesk (R22): login админа → invite →
// accept → login оператора → sessions create → claim оператором → decision
// allow (hostToken) → WS auth host+operator → relay offer/answer → end.
// Проверяет реальный сервер по HTTP+WS (в отличие от smoke-local, который
// поднимает сервер в процессе).
//
// env: ENOT_BASE_URL, ENOT_ADMIN_LOGIN, ENOT_ADMIN_PASSWORD.
// Секреты (пароли, токены) не печатаются.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const baseUrl = (process.env.ENOT_BASE_URL || '').replace(/\/+$/, '');
const adminLogin = process.env.ENOT_ADMIN_LOGIN || '';
const adminPassword = process.env.ENOT_ADMIN_PASSWORD || '';
if (!baseUrl || !adminLogin || !adminPassword) {
  console.error('SMOKE FAIL: задайте ENOT_BASE_URL, ENOT_ADMIN_LOGIN и ENOT_ADMIN_PASSWORD (см. .env.example)');
  process.exit(1);
}
const signalUrl = baseUrl.replace(/^http/, 'ws') + '/signal';
const TIMEOUT_MS = 10000;

let exitCode = 0;
const fail = (msg) => { console.error(`SMOKE FAIL: ${msg}`); exitCode = 1; };
const ok = (msg) => console.log(`SMOKE ok: ${msg}`);

// req/recv намеренно дублируют smoke-local: оба скрипта standalone (этот
// бьёт по внешнему серверу, локальный — по in-process), общего модуля нет.
async function req(method, p, { token, auth, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (auth) headers.authorization = auth;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(baseUrl + '/api/v1' + p, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`сеть: ${method} ${p}: ${e.message}`);
  }
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function recv(ws, filter, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), TIMEOUT_MS);
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (filter(m)) { clearTimeout(t); ws.off('message', onMsg); resolve(m); }
    };
    ws.on('message', onMsg);
  });
}

function connect(url, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: TIMEOUT_MS });
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* уже закрыт */ }
      reject(new Error(`timeout: подключение ${label}`));
    }, TIMEOUT_MS);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(new Error(`WS ${label}: ${e.message}`)); });
  });
}

let hostWs = null;
let opWs = null;
let adminToken = null;
let opUserId = null;

try {
  const health = await req('GET', '/health');
  if (health.status !== 200 || !health.data.ok) throw new Error(`health: ${health.status}`);
  ok(`health (${baseUrl}, версия ${health.data.version})`);

  const admin = await req('POST', '/auth/login', { body: { login: adminLogin, password: adminPassword } });
  if (admin.status !== 200 || !admin.data.token) {
    throw new Error(`логин администратора: ${admin.status} ${admin.data?.error?.message || ''}`);
  }
  adminToken = admin.data.token;
  ok('логин администратора (bearer выдан)');

  const invite = await req('POST', '/invites', { token: adminToken, body: { role: 'operator' } });
  if (!invite.data?.token) throw new Error(`создание приглашения: ${invite.status}`);
  const opLogin = `smoke-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const opPassword = `smoke-${randomUUID()}`;
  const accept = await req('POST', '/invites/accept', {
    body: { token: invite.data.token, login: opLogin, name: 'Smoke Operator', password: opPassword },
  });
  if (accept.status !== 200 || !accept.data.ok) {
    throw new Error(`accept приглашения: ${accept.status} ${accept.data?.error?.message || ''}`);
  }
  const operator = await req('POST', '/auth/login', { body: { login: opLogin, password: opPassword } });
  if (operator.status !== 200 || !operator.data.token) {
    throw new Error(`логин оператора: ${operator.status} ${operator.data?.error?.message || ''}`);
  }
  const opToken = operator.data.token;
  opUserId = operator.data.user?.id ?? null;
  ok('приглашение → accept → логин временного оператора');

  const s = await req('POST', '/sessions', { body: {} });
  if (s.status !== 201 || !s.data.sessionId || !s.data.hostToken || !s.data.password) {
    throw new Error(`создание сессии: ${s.status}`);
  }
  ok(`сессия создана (ID ${s.data.sessionId})`);

  hostWs = await connect(signalUrl, 'host');
  hostWs.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: s.data.sessionId, token: s.data.hostToken }));
  const hostReady = await recv(hostWs, (m) => m.type === 'ready', 'host ready');
  if (hostReady.state !== 'waiting') throw new Error(`состояние хоста: ${hostReady.state}`);
  ok('WS хоста: ready (waiting)');

  const claimMsgP = recv(hostWs, (m) => m.type === 'claim', 'host claim');
  const claim = await req('POST', `/sessions/${s.data.sessionId}/claim`, { token: opToken, body: { password: s.data.password } });
  if (claim.status !== 201 || claim.data.state !== 'pending-consent') {
    throw new Error(`claim оператора: ${claim.status} ${claim.data?.error?.message || ''}`);
  }
  await claimMsgP;
  ok('claim оператора → хост получил запрос (pending-consent)');

  opWs = await connect(signalUrl, 'operator');
  opWs.send(JSON.stringify({
    type: 'auth', role: 'operator', sessionId: s.data.sessionId, claimId: claim.data.claimId, token: opToken,
  }));
  const opReady = await recv(opWs, (m) => m.type === 'ready', 'operator ready');
  if (!['pending-consent', 'approved'].includes(opReady.state)) {
    throw new Error(`состояние оператора: ${opReady.state}`);
  }
  ok(`WS оператора: ready (${opReady.state})`);

  const hostApprovedP = recv(hostWs, (m) => m.type === 'approved', 'host approved');
  const opApprovedP = recv(opWs, (m) => m.type === 'approved', 'operator approved');
  const dec = await req('POST', `/sessions/${s.data.sessionId}/decision`, {
    auth: `Bearer ${s.data.hostToken}`,
    body: { claimId: claim.data.claimId, allow: true },
  });
  if (dec.status !== 200 || !dec.data.ok) throw new Error(`decision: ${dec.status}`);
  await hostApprovedP;
  await opApprovedP;
  ok('consent: обе стороны получили approved');

  hostWs.send(JSON.stringify({ type: 'signal', data: { description: { type: 'offer', sdp: 'v=0 remote-smoke-offer' } } }));
  const gotOffer = await recv(opWs, (m) => m.type === 'signal' && m.data?.description?.type === 'offer', 'offer→operator');
  opWs.send(JSON.stringify({ type: 'signal', data: { description: { type: 'answer', sdp: 'v=0 remote-smoke-answer' } } }));
  await recv(hostWs, (m) => m.type === 'signal' && m.data?.description?.type === 'answer', 'answer→host');
  ok(`relay offer/answer сквозь сервер (${gotOffer.data.description.sdp})`);

  const opEndedP = recv(opWs, (m) => m.type === 'ended', 'operator ended');
  const endRes = await req('POST', `/sessions/${s.data.sessionId}/end`, { auth: `Bearer ${s.data.hostToken}`, body: {} });
  if (endRes.status !== 200 || !endRes.data.ok) throw new Error(`end: ${endRes.status}`);
  await opEndedP;
  ok('end: обе стороны уведомлены');

  console.log(`SMOKE PASS: сервер ${baseUrl} прошёл полный цикл`);
} catch (e) {
  fail(e.message);
} finally {
  if (adminToken && opUserId) {
    try {
      const off = await req('PATCH', `/members/${opUserId}`, { token: adminToken, body: { active: false } });
      if (off.status !== 200 || off.data.user?.active !== false) {
        console.error(`SMOKE warn: временного оператора не удалось деактивировать (${off.status}) — удалите вручную`);
      }
    } catch (e) {
      console.error(`SMOKE warn: деактивация временного оператора не удалась: ${e.message}`);
    }
  }
  for (const ws of [hostWs, opWs]) { try { ws?.terminate(); } catch { /* уже закрыт */ } }
  process.exit(exitCode);
}
