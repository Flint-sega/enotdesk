// Связный локальный прогон T04: bootstrap → login → приглашение оператора →
// accept → создание сессии → claim вторым токеном → согласие (consent) →
// WS-сигналинг (ready/claim/approved, relay offer/answer) → end.
// Использует те же производственные швы, что и тесты: createServer + bootstrapAdmin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/app.mjs';
import { bootstrapAdmin } from '../server/bootstrap.mjs';
import WebSocket from 'ws';

const fail = (msg) => { console.error(`SMOKE FAIL: ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`SMOKE ok: ${msg}`);

const dbPath = path.join(os.tmpdir(), `enodesk-smoke-${process.pid}.db`);
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch { /* файла могло не быть */ } }

const boot = bootstrapAdmin(dbPath, { login: 'smokeadmin', name: 'Smoke Admin', password: 'smoke-pass-123' });
if (!boot.ok) { fail(`bootstrap: ${boot.reason}`); process.exit(1); }
ok('bootstrap первого админа');

const svc = createServer({ dbPath, host: '127.0.0.1', port: 0 });
const port = await svc.start();
const base = `http://127.0.0.1:${port}`;

async function req(method, p, { token, body, auth } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (auth) headers.authorization = auth;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + '/api/v1' + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

try {
  const health = await req('GET', '/health');
  if (!health.data.ok) throw new Error('health не ok');
  ok(`health (версия ${health.data.version})`);

  const admin = await req('POST', '/auth/login', { body: { login: 'smokeadmin', password: 'smoke-pass-123' } });
  if (admin.status !== 200 || !admin.data.token) throw new Error(`логин админа: ${admin.status}`);
  ok('логин админа (bearer выдан)');

  const inv = await req('POST', '/invites', { token: admin.data.token, body: { role: 'operator' } });
  if (inv.status !== 201 && inv.status !== 200) throw new Error(`invite create: ${inv.status}`);
  const acc = await req('POST', '/invites/accept', { body: { token: inv.data.token, login: 'smokeop', name: 'Smoke Operator', password: 'op-pass-123' } });
  if (acc.status >= 300) throw new Error(`invite accept: ${acc.status}`);
  const op = await req('POST', '/auth/login', { body: { login: 'smokeop', password: 'op-pass-123' } });
  if (!op.data.token) throw new Error('логин оператора не выдал токен');
  ok('приглашение → accept → логин оператора');

  const s = await req('POST', '/sessions', { body: {} });
  if (!s.data.sessionId || !s.data.password || !s.data.hostToken) throw new Error(`создание сессии: ${JSON.stringify(s.data).slice(0, 120)}`);
  ok(`сессия создана (ID ${s.data.sessionId})`);

  // Сигналинг: хост подключается сразу (как настоящий клиент, состояние waiting)
  const wsBase = `ws://127.0.0.1:${port}/signal`;
  const recv = (ws, filter, label) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), 5000);
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (filter(m)) { clearTimeout(t); ws.off('message', onMsg); resolve(m); }
    };
    ws.on('message', onMsg);
  });
  const hostWs = new WebSocket(wsBase);
  await new Promise((r, j2) => { hostWs.once('open', r); hostWs.once('error', j2); });
  hostWs.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: s.data.sessionId, token: s.data.hostToken }));
  const hostReady = await recv(hostWs, (m) => m.type === 'ready', 'host ready');
  if (hostReady.state !== 'waiting') throw new Error(`ожидалось waiting, пришло ${hostReady.state}`);
  ok('host ready, состояние waiting');

  // Слушатели прикрепляются ДО HTTP-триггера: WS-сообщение может прийти раньше,
  // чем разрешится fetch-промис (иначе событие уже сработало бы мимо листенера).
  const claimMsgP = recv(hostWs, (m) => m.type === 'claim', 'host claim live');
  const claim = await req('POST', `/sessions/${s.data.sessionId}/claim`, { token: op.data.token, body: { password: s.data.password } });
  if (claim.data.state !== 'pending-consent') throw new Error(`claim: ${JSON.stringify(claim.data).slice(0, 160)}`);
  const claimMsg = await claimMsgP;
  if (!claimMsg.operator?.name) throw new Error('claim без имени оператора');
  ok('claim оператором → хост получил claim c именем (pending-consent)');

  const opWs = new WebSocket(wsBase);
  await new Promise((r, j2) => { opWs.once('open', r); opWs.once('error', j2); });
  opWs.send(JSON.stringify({ type: 'auth', role: 'operator', sessionId: s.data.sessionId, claimId: claim.data.claimId, token: op.data.token }));
  const opReady = await recv(opWs, (m) => m.type === 'ready', 'op ready');
  ok(`op ready (state=${opReady.state})`);

  const hostApprovedP = recv(hostWs, (m) => m.type === 'approved', 'host approved');
  const opApprovedP = recv(opWs, (m) => m.type === 'approved', 'op approved');
  const dec = await req('POST', `/sessions/${s.data.sessionId}/decision`, { auth: `Bearer ${s.data.hostToken}`, body: { claimId: claim.data.claimId, allow: true } });
  if (!dec.data.ok) throw new Error(`decision: ${JSON.stringify(dec.data).slice(0, 160)}`);
  await hostApprovedP;
  await opApprovedP;
  ok('consent: оба получили approved');

  hostWs.send(JSON.stringify({ type: 'signal', data: { description: { type: 'offer', sdp: 'v=0 smoke-offer' } } }));
  const gotOffer = await recv(opWs, (m) => m.type === 'signal' && m.data?.description?.type === 'offer', 'offer→operator');
  opWs.send(JSON.stringify({ type: 'signal', data: { description: { type: 'answer', sdp: 'v=0 smoke-answer' } } }));
  await recv(hostWs, (m) => m.type === 'signal' && m.data?.description?.type === 'answer', 'answer→host');
  ok(`сигналинг: relay offer/answer сквозь сервер (${gotOffer.data.description.sdp})`);

  const opEndedP = recv(opWs, (m) => m.type === 'ended', 'operator ended');
  const endRes = await req('POST', `/sessions/${s.data.sessionId}/end`, { auth: `Bearer ${s.data.hostToken}`, body: {} });
  if (!endRes.data.ok) throw new Error('end не ok');
  await opEndedP;
  ok('завершение сессии: both стороны уведомлены');

  hostWs.close(); opWs.close();
  console.log('SMOKE PASS: полный локальный цикл пройден');
} catch (e) {
  fail(e.message);
} finally {
  await svc.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch { /* файла могло не быть */ } }
}
