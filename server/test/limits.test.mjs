import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, adminLogin, tmpDb, wsConnect } from './util.mjs';
import { RateLimiter } from '../app.mjs';

async function setup(t) {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath });
  return { base, port };
}

test('rate limit: POST /sessions ограничен по IP (429)', async (t) => {
  const { base } = await setup(t);
  let last;
  for (let i = 0; i < 12; i++) last = await api(base, 'POST', '/sessions');
  assert.equal(last.status, 429);
  assert.equal(last.json.error.code, 'rate_limited');
});

test('rate limit: login ограничен по IP (429)', async (t) => {
  const { base } = await setup(t);
  const body = { login: 'никто', password: 'несуществует-1' };
  let last;
  for (let i = 0; i < 12; i++) last = await api(base, 'POST', '/auth/login', { body });
  assert.equal(last.status, 429);
});

test('rate limit: claim ограничен по sessionId, соседние сеансы не затронуты', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, {
    dbPath,
    limits: {
      sessions: new RateLimiter(100, 60_000),
      login: new RateLimiter(100, 60_000),
      claim: new RateLimiter(100, 60_000),
      claimId: new RateLimiter(3, 60_000),
    },
  });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  let last;
  for (let i = 0; i < 5; i++) {
    last = await api(base, 'POST', `/sessions/${reg.json.sessionId}/claim`, { token: admin.token, body: { password: 'неверный' } });
  }
  assert.equal(last.status, 429);
  // per-ID лимит бьёт только по этому сеансу: другой sessionId отвечает обычным 400
  const reg2 = await api(base, 'POST', '/sessions');
  const other = await api(base, 'POST', `/sessions/${reg2.json.sessionId}/claim`, { token: admin.token, body: { password: 'неверный' } });
  assert.equal(other.status, 400);
});

test('body limit: слишком большой запрос — 413', async (t) => {
  const { base } = await setup(t);
  const huge = { name: 'x'.repeat(200 * 1024) };
  const res = await api(base, 'POST', '/sessions', { body: huge });
  assert.equal(res.status, 413);
});

test('WS frame limit: кадр больше 128KiB закрывает соединение (1009)', async (t) => {
  const { port, base } = await setup(t);
  const reg = await api(base, 'POST', '/sessions');
  const ws = wsConnect(port);
  await ws.opened;
  ws.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: reg.json.sessionId, token: reg.json.hostToken }));
  await ws.wait((m) => m.type === 'ready');
  ws.send('x'.repeat(129 * 1024));
  assert.equal(await ws.closeCode(), 1009);
});

test('origin check: чужой Origin — 403 в HTTP и 403 (не 101) на WS-апгрейд; без Origin WS работает', async (t) => {
  const { base, port } = await setup(t);
  const res = await fetch(base + '/api/v1/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);

  const { request } = await import('node:http');
  const outcome = await new Promise((resolve, reject) => {
    const r = request({
      host: '127.0.0.1',
      port,
      path: '/signal',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': 13,
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        Origin: 'https://evil.example',
      },
    });
    r.on('upgrade', () => reject(new Error('чужой Origin получил WS-апгрейд')));
    r.on('response', (resp) => { resp.resume(); resolve(resp.statusCode); });
    r.on('error', reject);
    r.end();
  });
  assert.equal(outcome, 403);

  // контроль: легитимное подключение без Origin проходит — тест краснеет при сломанном шве
  const reg = await api(base, 'POST', '/sessions');
  const ok = wsConnect(port);
  await ok.opened;
  ok.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: reg.json.sessionId, token: reg.json.hostToken }));
  await ok.wait((m) => m.type === 'ready');
});

test('rtc-config: без токена 401; с hostToken и TURN-конфигом отдаёт iceServers', async (t) => {
  const dbPath = tmpDb(t);
  const { inst, base } = await startServer(t, { dbPath, turnUrls: 'turn:turn.example:3478', turnUsername: 'enot', turnPassword: 'secret-кред' });
  assert.equal((await api(base, 'GET', '/rtc-config')).status, 401);
  const reg = await api(base, 'POST', '/sessions');
  const cfg = await api(base, 'GET', '/rtc-config', { token: reg.json.hostToken });
  assert.equal(cfg.status, 200);
  assert.deepEqual(cfg.json.iceServers, [{ urls: ['turn:turn.example:3478'], username: 'enot', credential: 'secret-кред' }]);
  await inst.close();
});

test('downloads: страница и API честно пустые без dist', async (t) => {
  const { base } = await setup(t);
  const html = await fetch(base + '/downloads');
  assert.equal(html.status, 200);
  const text = await html.text();
  assert.match(text, /Сборка ещё не готова/);
  const apiRes = await api(base, 'GET', '/downloads');
  assert.equal(apiRes.status, 200);
  assert.deepEqual(apiRes.json.items, []);
});

test('downloads-files: отдаёт только allowlist-файлы из dist/, traversal отказан', async (t) => {
  const { base } = await setup(t);
  const distDir = path.join(process.cwd(), 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const fileName = 'EnotDesk-0.1.0.exe';
  fs.writeFileSync(path.join(distDir, fileName), 'PORTABLE-BYTES');
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));

  const list = await api(base, 'GET', '/downloads');
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].name, fileName);
  assert.equal(list.json.items[0].platform, 'win32');
  assert.equal(list.json.items[0].size, 'PORTABLE-BYTES'.length);

  const file = await fetch(`${base}/api/v1/downloads-files/${encodeURIComponent(fileName)}`);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'PORTABLE-BYTES');

  // вне allowlist / traversal / отсутствующий allowlist-файл
  assert.equal((await fetch(`${base}/api/v1/downloads-files/README.md`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/downloads-files/${encodeURIComponent('../package.json')}`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/downloads-files/EnotDesk-9.9.9.exe`)).status, 404);
});
