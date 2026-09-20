import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseJoinLink, reportJoin } from '../lib/join.mjs';
import ru from '../locales/ru.mjs';
import en from '../locales/en.mjs';

// Ожидания заданы спецификацией (Решения §One-click, тикет 04): ссылка строго
// enotdesk://join?server=<url>&t=<token>, сервер проходит normalizeServerUrl
// ({allowInsecureHttp:true}), токен — [A-Za-z0-9_-]{16,128}; всё прочее — null.

const OK_SERVER = 'https://enot.example.com';
const OK_TOKEN = 'Abcdef0123456789-_xy'; // [A-Za-z0-9_-], ровно 20 знаков
const link = (server, token) => `enotdesk://join?server=${encodeURIComponent(server)}&t=${token}`;

// ---- parseJoinLink: валидные ссылки ----

test('валидная https-ссылка разбирается в {server, token}', () => {
  assert.deepEqual(parseJoinLink(link(OK_SERVER, OK_TOKEN)), { server: OK_SERVER, token: OK_TOKEN });
});

test('loopback http в server допустим (dev-сервер)', () => {
  assert.deepEqual(
    parseJoinLink(link('http://127.0.0.1:8080', OK_TOKEN)),
    { server: 'http://127.0.0.1:8080', token: OK_TOKEN },
  );
});

test('хвостовой слэш у server срезается нормализацией', () => {
  assert.deepEqual(
    parseJoinLink(link('https://enot.example.com/', OK_TOKEN)),
    { server: OK_SERVER, token: OK_TOKEN },
  );
});

test('границы токена: ровно 16 и ровно 128 знаков проходят', () => {
  const t16 = 'A'.repeat(16);
  const t128 = 'B'.repeat(128);
  assert.equal(parseJoinLink(link(OK_SERVER, t16))?.token, t16);
  assert.equal(parseJoinLink(link(OK_SERVER, t128))?.token, t128);
});

test('лишние параметры запроса не ломают разбор', () => {
  assert.deepEqual(
    parseJoinLink(`enotdesk://join?server=${encodeURIComponent(OK_SERVER)}&t=${OK_TOKEN}&x=1`),
    { server: OK_SERVER, token: OK_TOKEN },
  );
});

// ---- parseJoinLink: мусор и чужие схемы ----

test('не-строка, пустая строка и не-ссылка — null', () => {
  for (const bad of [null, undefined, 42, {}, '', '   ', 'не ссылка']) {
    assert.equal(parseJoinLink(bad), null, String(bad));
  }
});

test('чужие схемы отклоняются: https, javascript, другой кастомный', () => {
  for (const bad of [
    `https://enot.example.com/join?server=${encodeURIComponent(OK_SERVER)}&t=${OK_TOKEN}`,
    `javascript:enotdesk://join?server=${encodeURIComponent(OK_SERVER)}&t=${OK_TOKEN}`,
    `javascript:alert(1)`,
    `enotsdesk://join?server=${encodeURIComponent(OK_SERVER)}&t=${OK_TOKEN}`,
  ]) {
    assert.equal(parseJoinLink(bad), null, bad);
  }
});

test('host строго join: другой узел и одинарный слэш — null', () => {
  assert.equal(parseJoinLink(link(OK_SERVER, OK_TOKEN).replace('://join', '://evil')), null);
  assert.equal(
    parseJoinLink(`enotdesk:/join?server=${encodeURIComponent(OK_SERVER)}&t=${OK_TOKEN}`),
    null,
  );
});

test('пропущенные или пустые параметры — null', () => {
  for (const bad of [
    'enotdesk://join',
    'enotdesk://join?t=' + OK_TOKEN,
    `enotdesk://join?server=${encodeURIComponent(OK_SERVER)}`,
    `enotdesk://join?server=&t=${OK_TOKEN}`,
    `enotdesk://join?server=${encodeURIComponent(OK_SERVER)}&t=`,
    `enotdesk://join?server=${encodeURIComponent(OK_SERVER)}&t=${encodeURIComponent('   ')}`,
  ]) {
    assert.equal(parseJoinLink(bad), null, bad);
  }
});

test('сервер не URL или не http(s) — null', () => {
  for (const server of ['не адрес', 'ftp://enot.example.com', 'enot.example.com', 'file:///etc/passwd']) {
    assert.equal(parseJoinLink(link(server, OK_TOKEN)), null, server);
  }
});

test('токен не по алфавиту/длине — null', () => {
  for (const token of ['A'.repeat(15), 'A'.repeat(129), 'aaaa$$$$aaaaaaaa', 'токен-по-русски', 'aaaa aaaa aaaaaa']) {
    assert.equal(parseJoinLink(link(OK_SERVER, token)), null, token);
  }
});

// ---- reportJoin: репорт {sessionId,password} на hub по одноразовому URL ----

function fakeFetch(calls, response = { ok: true, status: 200 }) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return response;
  };
}

test('reportJoin шлёт POST на /api/hub/join/:t/report строго с {sessionId,password} — hostToken отсутствует', async () => {
  const calls = [];
  const res = await reportJoin(
    OK_SERVER,
    OK_TOKEN,
    { sessionId: '123456789', password: 'pass-1234', hostToken: 'НЕ-ДОЛЖЕН-УЙТИ' },
    fakeFetch(calls),
  );
  assert.deepEqual(res, { ok: true, status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${OK_SERVER}/api/hub/join/${OK_TOKEN}/report`);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
  // deepEqual на точное тело: лишние поля (включая hostToken) в запрос не попадают
  assert.deepEqual(JSON.parse(calls[0].opts.body), { sessionId: '123456789', password: 'pass-1234' });
});

test('reportJoin нормализует хвостовой слэш сервера', async () => {
  const calls = [];
  await reportJoin('https://enot.example.com/', OK_TOKEN, { sessionId: '1', password: 'p' }, fakeFetch(calls));
  assert.equal(calls[0].url, `${OK_SERVER}/api/hub/join/${OK_TOKEN}/report`);
});

test('reportJoin честно возвращает не-2xx, не бросая', async () => {
  const res = await reportJoin(OK_SERVER, OK_TOKEN, { sessionId: '1', password: 'p' }, fakeFetch([], { ok: false, status: 409 }));
  assert.deepEqual(res, { ok: false, status: 409 });
});

test('reportJoin сетевая ошибка — отклонение (решает вызывающий, не глотаем)', async () => {
  await assert.rejects(
    () => reportJoin(OK_SERVER, OK_TOKEN, { sessionId: '1', password: 'p' }, async () => { throw new Error('hub недоступен'); }),
    /hub недоступен/,
  );
});

test('reportJoin невалидные входные отклоняются без похода в сеть', async () => {
  for (const [server, token, creds] of [
    ['не адрес', OK_TOKEN, { sessionId: '1', password: 'p' }],
    [OK_SERVER, 'короткий', { sessionId: '1', password: 'p' }],
    [OK_SERVER, OK_TOKEN, null],
    [OK_SERVER, OK_TOKEN, { sessionId: '', password: 'p' }],
    [OK_SERVER, OK_TOKEN, { sessionId: '1', password: undefined }],
  ]) {
    const calls = [];
    await assert.rejects(() => reportJoin(server, token, creds ?? {}, fakeFetch(calls)));
    assert.equal(calls.length, 0, JSON.stringify(creds));
  }
});

// ---- wiring-контракты: main/preload/view/builder/словари ----

const root = path.join(import.meta.dirname, '..');

test('main.mjs регистрирует протокол только в упакованном приложении и ведёт open-url/second-instance/argv', () => {
  const mainJs = readFileSync(path.join(root, 'main.mjs'), 'utf8');
  assert.match(mainJs, /const PROTOCOL_REGISTERED = !SMOKE && !AGENT && app\.isPackaged;/);
  assert.match(mainJs, /if \(PROTOCOL_REGISTERED\) app\.setAsDefaultProtocolClient\('enotdesk'\)/);
  // SMOKЕ-вывод вычисляет фактическое состояние, а не повторяет константу
  assert.match(mainJs, /SMOKE protocol: \$\{PROTOCOL_REGISTERED \? 'registered' : 'not registered'\}/);
  assert.match(mainJs, /'open-url'/);
  assert.match(mainJs, /'second-instance'/);
  assert.match(mainJs, /parseJoinLink/);
});

test('join-ссылка не ослабляет настройки: allowInsecureHttp из ссылки не персистится', () => {
  const mainJs = readFileSync(path.join(root, 'main.mjs'), 'utf8');
  const fn = mainJs.match(/function applyJoinLink\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(fn.includes('function applyJoinLink'), 'applyJoinLink найдена');
  assert.ok(!/allowInsecureHttp/.test(fn), 'join не должен трогать галочку «Разрешить HTTP»');
  // адрес сохраняется; решение о http-допуске остаётся за пользователем
  assert.match(fn, /settings\.serverUrl = parsed\.server;/);
  assert.match(fn, /saveSettings\(\)/);
});

test('preload выставляет узкие каналы join (без произвольного IPC)', () => {
  const preload = readFileSync(path.join(root, 'preload.cjs'), 'utf8');
  assert.match(preload, /enot:onJoinStart/);
  assert.match(preload, /enot:joinReport/);
});

test('client-view реагирует на join-старт и репортит через мост', () => {
  const view = readFileSync(path.join(root, 'renderer', 'views', 'client-view.js'), 'utf8');
  assert.match(view, /onJoinStart/);
  assert.match(view, /joinReport/);
});

test('electron-builder прописывает протокол enotdesk', () => {
  const yml = readFileSync(path.join(root, '..', 'build', 'electron-builder.yml'), 'utf8');
  assert.match(yml, /schemes:\s*\n\s*-\s*enotdesk/);
});

test('ключи join.* есть в обоих словарях (импорт модулей, не grep)', () => {
  assert.ok('join.reportOk' in ru && 'join.reportFailed' in ru, 'ru');
  assert.ok('join.reportOk' in en && 'join.reportFailed' in en, 'en');
});
