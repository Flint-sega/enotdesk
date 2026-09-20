import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api } from './util.mjs';

test('smoke: сервер стартует, /health отвечает без авторизации', async (t) => {
  const { base } = await startServer(t);
  const res = await api(base, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof res.json.activeSessions, 'number', 'health показывает число живых сеансов');
  assert.ok(res.json.uptimeSec >= 0, 'health показывает аптайм');
});

test('неизвестный маршрут — 404 в формате {error:{code,message}} на русском', async (t) => {
  const { base } = await startServer(t);
  const res = await api(base, 'GET', '/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'not_found');
  assert.equal(typeof res.json.error.message, 'string');
  assert.match(res.json.error.message, /./);
});

test('API-ответы не кешируются (Cache-Control: no-store), бренд-ассеты с nosniff', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/api/v1/health`);
  await res.text();
  assert.equal(res.headers.get('cache-control'), 'no-store', 'ok() ставит no-store на API');
  const icon = await fetch(`${base}/brand/icon.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('x-content-type-options'), 'nosniff', 'nosniff на /brand');
  const asset = await fetch(`${base}/client/lib/i18n.mjs`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff', 'nosniff на статике оператора');
});
