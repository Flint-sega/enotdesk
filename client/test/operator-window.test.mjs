import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  OPERATOR_UI_LEVEL, operatorWindowUrls, isAllowedNavigation, evaluateHealth,
  probeOperatorServer, isTrustedOperatorFrame, rememberAllowed,
} from '../lib/operator-window.mjs';

// ADR 0033, этап 2: desktop показывает /operator с сервера в отдельном окне.
// Чистая логика — адреса, допуск навигации, вердикт health; плюс контракт
// закалки окна в main.mjs и узкого моста operator-preload.cjs.

const dir = import.meta.dirname;

test('operator-window: адреса окна строятся от origin сервера', () => {
  const u = operatorWindowUrls('https://support.example.com/some/path?x=1');
  assert.equal(u.origin, 'https://support.example.com');
  assert.equal(u.operator, 'https://support.example.com/operator');
  assert.equal(u.health, 'https://support.example.com/api/v1/health');
  assert.equal(u.invite('a b'), 'https://support.example.com/invite#token=a%20b');
  assert.equal(operatorWindowUrls('http://127.0.0.1:8080').operator, 'http://127.0.0.1:8080/operator');
  assert.equal(operatorWindowUrls('file:///etc/passwd'), null, 'не http(s) — окна нет');
  assert.equal(operatorWindowUrls('не адрес'), null);
});

test('operator-window: навигация только внутри origin сервера', () => {
  const o = 'https://support.example.com';
  assert.equal(isAllowedNavigation('https://support.example.com/invite#token=1', o), true);
  assert.equal(isAllowedNavigation('https://support.example.com/downloads', o), true);
  assert.equal(isAllowedNavigation('https://evil.example.com/operator', o), false);
  assert.equal(isAllowedNavigation('http://support.example.com/operator', o), false, 'смена схемы — другой origin');
  assert.equal(isAllowedNavigation('https://support.example.com:8443/', o), false, 'другой порт — другой origin');
  assert.equal(isAllowedNavigation('javascript:alert(1)', o), false);
  assert.equal(isAllowedNavigation('https://support.example.com/', null), false, 'без origin окна — нельзя ничего');
});

test('operator-window: вердикт health — уровень страницы, а не номер версии', () => {
  assert.equal(OPERATOR_UI_LEVEL, 1);
  assert.deepEqual(evaluateHealth(200, { ok: true, version: '0.6.23', operatorUi: 1 }), { ok: true, version: '0.6.23' });
  assert.deepEqual(evaluateHealth(200, { ok: true, version: '0.6.22', operatorUi: 2 }), { ok: true, version: '0.6.22' }, 'уровень выше — тоже годится');
  assert.deepEqual(evaluateHealth(200, { ok: true, version: '0.6.21' }), { ok: false, reason: 'server-outdated', version: '0.6.21' }, 'старый сервер без поля — «обновите сервер»');
  assert.deepEqual(evaluateHealth(200, { ok: true, version: '0.6.21', operatorUi: '1' }), { ok: false, reason: 'server-outdated', version: '0.6.21' }, 'строка вместо числа — не доверяем');
  assert.deepEqual(evaluateHealth(503, { ok: true, operatorUi: 1 }), { ok: false, reason: 'server-unreachable' });
  assert.deepEqual(evaluateHealth(200, null), { ok: false, reason: 'server-unreachable' }, 'не JSON — не наш сервер');
  assert.deepEqual(evaluateHealth(200, { status: 'up' }), { ok: false, reason: 'server-unreachable' }, 'чужой health — не наш сервер');
  assert.equal(evaluateHealth(200, { ok: true, version: 'x'.repeat(500) }).version.length, 40, 'версия в тексте ошибки обрезана');
});

test('operator-window: проба сервера — сеть инъекцией, сбой сети честно «не отвечает»', async () => {
  let asked = null;
  const ok = await probeOperatorServer('https://s.example.com', async (url, opts) => {
    asked = { url, redirect: opts.redirect, hasSignal: Boolean(opts.signal) };
    return { status: 200, json: async () => ({ ok: true, version: '0.6.23', operatorUi: 1 }) };
  });
  assert.deepEqual(ok, { ok: true, version: '0.6.23' });
  assert.deepEqual(asked, { url: 'https://s.example.com/api/v1/health', redirect: 'error', hasSignal: true });
  const down = await probeOperatorServer('https://s.example.com', async () => { throw new Error('ECONNREFUSED'); });
  assert.deepEqual(down, { ok: false, reason: 'server-unreachable' });
  const html = await probeOperatorServer('https://s.example.com', async () => ({ status: 200, json: async () => { throw new SyntaxError('html'); } }));
  assert.deepEqual(html, { ok: false, reason: 'server-unreachable' });
  assert.deepEqual(await probeOperatorServer('ftp://x', async () => { throw new Error('не должно звать'); }), { ok: false, reason: 'server-unreachable' });
});

test('operator-window: мост «запомнить меня» — только главный фрейм окна оператора с origin сервера', () => {
  const origin = 'https://s.example.com';
  const base = { isOperatorWindow: true, isMainFrame: true, frameUrl: 'https://s.example.com/operator', origin };
  assert.equal(isTrustedOperatorFrame(base), true);
  assert.equal(isTrustedOperatorFrame({ ...base, isOperatorWindow: false }), false, 'главное окно/виджет — не сюда');
  assert.equal(isTrustedOperatorFrame({ ...base, isMainFrame: false }), false, 'iframe — нет');
  assert.equal(isTrustedOperatorFrame({ ...base, frameUrl: 'https://evil.example.com/' }), false, 'чужой origin — нет');
  assert.equal(isTrustedOperatorFrame({ ...base, frameUrl: undefined }), false);
  assert.equal(isTrustedOperatorFrame({ ...base, origin: null }), false, 'окно закрыто — нет');
});

test('operator-window: «запомнить меня» — только https и loopback (не открытый HTTP наружу)', () => {
  assert.equal(rememberAllowed('https://support.example.com'), true);
  assert.equal(rememberAllowed('http://127.0.0.1:8080'), true);
  assert.equal(rememberAllowed('http://localhost:8080'), true);
  assert.equal(rememberAllowed('http://[::1]:8080'), true);
  assert.equal(rememberAllowed('http://192.0.2.10:8080'), false, 'внешний HTTP — посредник может подменить страницу');
  assert.equal(rememberAllowed('http://127.0.0.1.evil.example'), false);
  assert.equal(rememberAllowed(null), false);
});

test('operator-window: контракт закалки окна в main.mjs и узкий preload', () => {
  const main = readFileSync(path.join(dir, '..', 'main.mjs'), 'utf8');
  const start = main.indexOf('async function openOperatorWindow(');
  assert.ok(start > 0, 'openOperatorWindow есть');
  const body = main.slice(start, main.indexOf('\nfunction registerIpc()', start));
  for (const must of [
    'partition: OPERATOR_PARTITION', 'contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webviewTag: false',
    "setWindowOpenHandler(() => ({ action: 'deny' }))", "'will-navigate'", "'will-redirect'", "'will-attach-webview'",
    'probeOperatorServer(', "'operator-preload.cjs'",
  ]) assert.ok(body.includes(must), `окно оператора: ${must}`);
  assert.match(main, /const OPERATOR_PARTITION = 'enot-operator';/, 'сессия в памяти (без persist:) — модель SEC-008');
  // разрешения сессии окна оператора: только буфер (запись) и полноэкранный режим
  const ses = main.slice(main.indexOf('function prepareOperatorSession('), main.indexOf('function closeOperatorWindow('));
  assert.match(ses, /permission === 'clipboard-sanitized-write' \|\| permission === 'fullscreen'/);
  assert.match(ses, /setDisplayMediaRequestHandler\(\(_req, callback\) => callback\(\{\}\)\)/, 'захват экрана — отказ');
  // каждый канал моста под operatorGuard; креды — с origin окна
  for (const ch of ['available', 'load', 'save', 'clear']) {
    const re = new RegExp(`ipcMain\\.handle\\('enot-op:credentials-${ch}', \\(e(, creds)?\\) => \\{\\s*operatorGuard\\(e\\);`);
    assert.match(main, re, `enot-op:credentials-${ch} проверяет отправителя`);
  }
  assert.match(main, /opCreds\.load\(\{ origin: operatorOrigin \}\)/);
  assert.equal((main.match(/rememberAllowed\(operatorOrigin\)/g) ?? []).length, 3, 'available/load/save сверяют схему origin');
  assert.match(main, /opCreds\.save\(\{ login, password, origin: operatorOrigin \}\)/);

  const preload = readFileSync(path.join(dir, '..', 'operator-preload.cjs'), 'utf8');
  const channels = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(channels, ['enot-op:credentials-available', 'enot-op:credentials-clear', 'enot-op:credentials-load', 'enot-op:credentials-save']);
  assert.ok(!/ipcRenderer\.(send|on)\(/.test(preload), 'мост окна оператора — только invoke четырёх каналов');
});
