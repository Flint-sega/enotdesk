import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';

test('relay: upload по hostToken → 201, скачивание по ссылке, битый токен → 403', async (t) => {
  const dbPath = tmpDb(t);
  const { inst, base, port } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  assert.equal(claim.status, 201);

  // загрузка сырым телом
  const payload = Buffer.from('EnotDesk relay file content — проверка', 'utf8');
  const res = await fetch(base + '/api/v1/relay', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${hostToken}`,
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent('test-file.txt'),
    },
    body: payload,
  });
  assert.equal(res.status, 201, 'upload 201');
  const up = await res.json();
  assert.equal(up.name, 'test-file.txt');
  assert.ok(up.url.startsWith('/api/v1/relay/'), 'относительная ссылка');

  // скачивание по токену
  const dl = await fetch(base + up.url);
  assert.equal(dl.status, 200);
  const text = Buffer.from(await dl.arrayBuffer()).toString('utf8');
  assert.equal(text, payload.toString('utf8'));

  // битый токен → 403
  const bad = await fetch(base + `/api/v1/relay/${up.id}?token=wrong`);
  assert.equal(bad.status, 403);

  // без токена → 403
  const noToken = await fetch(base + `/api/v1/relay/${up.id}`);
  assert.equal(noToken.status, 403);
  inst.close();
});

test('relay: кириллическое имя (encoded) сохраняется корректно', async (t) => {
  const dbPath = tmpDb(t);
  const { inst, base, port } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  assert.equal(claim.status, 201);

  const name = encodeURIComponent('отчёт за год.txt');
  const res = await fetch(base + '/api/v1/relay', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${hostToken}`,
      'content-type': 'application/octet-stream',
      'x-file-name': name,
    },
    body: Buffer.from('данные'),
  });
  assert.equal(res.status, 201);
  const up = await res.json();
  assert.equal(up.name, 'отчёт за год.txt', 'имя декодировано и сохранено');
  inst.close();
});

test('relay: auth-отказы — без токена 401, лишний размер 413', async (t) => {
  const dbPath = tmpDb(t);
  const { inst, base, port } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  const { hostToken } = reg.json;

  const noAuth = await fetch(base + '/api/v1/relay', { method: 'POST', body: Buffer.from('x') });
  assert.equal(noAuth.status, 401);

  const big = Buffer.alloc(201 * 1024 * 1024, 7);
  const tooBig = await fetch(base + '/api/v1/relay', {
    method: 'POST',
    headers: { authorization: `Bearer ${hostToken}`, 'content-length': String(big.length) },
    body: big,
  });
  assert.equal(tooBig.status, 413);
  inst.close();
});
