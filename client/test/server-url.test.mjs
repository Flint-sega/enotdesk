import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServerUrl } from '../lib/server-url.mjs';

// Ожидания заданы из правил спецификации §7, не пересчётом через код:
// https — ок; http loopback — ок; http внешний — только с allowInsecureHttp; хвостовой слэш срезан.

test('https внешний адрес принимается', () => {
  assert.deepEqual(normalizeServerUrl('https://enot.example.com'), { ok: true, url: 'https://enot.example.com' });
});

test('http loopback принимается без флага', () => {
  for (const u of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
    assert.deepEqual(normalizeServerUrl(u), { ok: true, url: u }, u);
  }
});

test('http внешний без флага отклоняется как https-required', () => {
  assert.deepEqual(normalizeServerUrl('http://89.125.214.92:8080'), { ok: false, reason: 'https-required' });
});

test('http внешний с allowInsecureHttp принимается', () => {
  assert.deepEqual(
    normalizeServerUrl('http://89.125.214.92:8080', { allowInsecureHttp: true }),
    { ok: true, url: 'http://89.125.214.92:8080' },
  );
});

test('пустая строка и пробелы — empty', () => {
  assert.deepEqual(normalizeServerUrl(''), { ok: false, reason: 'empty' });
  assert.deepEqual(normalizeServerUrl('   '), { ok: false, reason: 'empty' });
});

test('мусор и не http(s) протоколы — invalid', () => {
  assert.deepEqual(normalizeServerUrl('не адрес'), { ok: false, reason: 'invalid' });
  assert.deepEqual(normalizeServerUrl('ftp://example.com'), { ok: false, reason: 'invalid' });
});

test('хвостовой слэш срезается, пробелы обрезаются', () => {
  assert.deepEqual(normalizeServerUrl('  https://enot.example.com/  '), { ok: true, url: 'https://enot.example.com' });
  assert.deepEqual(normalizeServerUrl('http://127.0.0.1:8080/'), { ok: true, url: 'http://127.0.0.1:8080' });
});
