import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api } from './util.mjs';

test('smoke: сервер стартует, /health отвечает без авторизации', async (t) => {
  const { base } = await startServer(t);
  const res = await api(base, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.version, /^\d+\.\d+\.\d+$/);
});

test('неизвестный маршрут — 404 в формате {error:{code,message}} на русском', async (t) => {
  const { base } = await startServer(t);
  const res = await api(base, 'GET', '/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'not_found');
  assert.equal(typeof res.json.error.message, 'string');
  assert.match(res.json.error.message, /./);
});
