import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../app.mjs';
import { SCHEMA_VERSION } from '../db.mjs';

// Фейк-EnotDesk: инъекция enotFetch (шов из interfaces.md) — реальной сети нет.
// state меняется из теста: loginStatus/meStatus/healthOk/role.
function fakeEnotDesk(overrides = {}) {
  const state = { loginStatus: 200, meStatus: 200, meThrow: false, healthOk: true, role: 'operator', ...overrides };
  const calls = [];
  const user = () => ({ id: 'u1', login: 'op', name: 'Оператор', role: state.role, active: true });
  const enotFetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, opts });
    if (path === '/api/v1/auth/login') {
      if (state.loginStatus !== 200) {
        const code = state.loginStatus === 401 ? 'invalid_credentials'
          : state.loginStatus === 401.5 ? 'totp_required' : 'error';
        return Response.json({ error: { code, message: 'upstream' } }, { status: state.loginStatus === 401.5 ? 401 : state.loginStatus });
      }
      return Response.json({ token: `upstream-token-${calls.length}`, user: user(), expiresAt: '2030-01-01T00:00:00.000Z' });
    }
    if (path === '/api/v1/auth/me') {
      if (state.meThrow) throw new Error('connection reset');
      if (state.meStatus !== 200) return new Response(null, { status: state.meStatus });
      return Response.json({ user: user() });
    }
    if (path === '/api/v1/auth/logout') return Response.json({ ok: true });
    if (path === '/api/v1/health') return state.healthOk ? Response.json({ ok: true }) : new Response(null, { status: 503 });
    return new Response(null, { status: 404 });
  };
  return { enotFetch, calls, state };
}

// Полностью мёртвый апстрим: сеть недоступна (login → 502, health → false)
const deadFetch = async () => { throw new Error('connection refused'); };

async function startHub({ enotFetch, publicUrl = 'http://hub.example', now, secretKey = '', trustedProxy } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'enotdesk-hub-test-'));
  const inst = createHub({
    dbPath: join(dir, 'hub.db'),
    port: 0,
    enotdeskUrl: 'http://enot.test',
    publicUrl,
    secretKey,
    trustedProxy,
    enotFetch,
    now,
  });
  const port = await inst.start();
  const base = `http://127.0.0.1:${port}`;
  return { inst, base, db: inst.db, dir, close: () => inst.close() };
}

async function hubLogin(base, { login = 'op', password = 'pw', totp } = {}) {
  return fetch(`${base}/api/hub/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password, ...(totp ? { totp } : {}) }),
  });
}

function sidFrom(res) {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('enot_hub_sid='));
  return cookie ? cookie.split(';')[0] : '';
}

test('hub.db: schema_version поднимается до текущей', async () => {
  const h = await startHub({ enotFetch: fakeEnotDesk().enotFetch });
  try {
    const row = h.db.prepare('SELECT version FROM schema_version').get();
    assert.equal(row.version, SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 2); // 1 — каркас SSO (T01), 2 — тикеты (T02)
  } finally { h.close(); }
});

test('health: живой апстрим → {ok,enotdesk:true} и кэш 5 с (один пинг на два запроса)', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const r1 = await fetch(`${h.base}/api/hub/health`);
    assert.deepEqual(await r1.json(), { ok: true, enotdesk: true });
    const r2 = await fetch(`${h.base}/api/hub/health`);
    assert.equal((await r2.json()).enotdesk, true);
    const pings = f.calls.filter((c) => c.path === '/api/v1/health');
    assert.equal(pings.length, 1); // второй ответ из кэша
  } finally { h.close(); }
});

test('health: мёртвый апстрим → честный enotdesk:false, сам хаб ok', async () => {
  const h = await startHub({ enotFetch: deadFetch });
  try {
    const r = await fetch(`${h.base}/api/hub/health`);
    assert.deepEqual(await r.json(), { ok: true, enotdesk: false });
  } finally { h.close(); }
});

test('SSO: успешный логин → cookie с флагами HttpOnly/SameSite=Lax (без Secure на http), bearer не в cookie', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const res = await hubLogin(h.base, { login: 'op', password: 'pw' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.role, 'operator');
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('enot_hub_sid='));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//);
    assert.doesNotMatch(setCookie, /Secure/i);
    assert.ok(!setCookie.includes('upstream-token'), 'bearer не утекает в cookie');
    // прокси ушёл в EnotDesk с теми же кредами
    const sent = JSON.parse(f.calls.find((c) => c.path === '/api/v1/auth/login').opts.body);
    assert.deepEqual({ login: sent.login, password: sent.password }, { login: 'op', password: 'pw' });
  } finally { h.close(); }
});

test('SSO: https publicUrl → cookie помечена Secure', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch, publicUrl: 'https://hub.example' });
  try {
    const res = await hubLogin(h.base);
    assert.match(res.headers.getSetCookie().join(''), /Secure/i);
  } finally { h.close(); }
});

test('SSO: неверный пароль → 401 invalid_credentials насквозь, сессия не создана', async () => {
  const f = fakeEnotDesk({ loginStatus: 401 });
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const res = await hubLogin(h.base);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'invalid_credentials');
    assert.equal(res.headers.getSetCookie().length, 0);
  } finally { h.close(); }
});

test('SSO: EnotDesk мёртв → 502 enotdesk_unavailable', async () => {
  const h = await startHub({ enotFetch: deadFetch });
  try {
    const res = await hubLogin(h.base);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'enotdesk_unavailable');
  } finally { h.close(); }
});

test('SSO: totp_required апстрима проходит насквозь', async () => {
  const f = fakeEnotDesk({ loginStatus: 401.5 });
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const res = await hubLogin(h.base, { totp: '' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'totp_required');
  } finally { h.close(); }
});

test('сессия: /me отдаёт пользователя; ревалидация кэшируется (один вызов апстрима)', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const login = await hubLogin(h.base);
    const cookie = sidFrom(login);
    const r1 = await fetch(`${h.base}/api/hub/auth/me`, { headers: { cookie } });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).user.role, 'operator');
    await fetch(`${h.base}/api/hub/auth/me`, { headers: { cookie } });
    const meCalls2 = f.calls.filter((c) => c.path === '/api/v1/auth/me').length;
    assert.ok(meCalls2 <= 1, `ревалидация кэшируется (было вызовов: ${meCalls2})`);
  } finally { h.close(); }
});

test('сессия: без cookie → 401', async () => {
  const h = await startHub({ enotFetch: fakeEnotDesk().enotFetch });
  try {
    const res = await fetch(`${h.base}/api/hub/auth/me`);
    assert.equal(res.status, 401);
  } finally { h.close(); }
});

test('сессия: bearer умер (ротация) → ревалидация 401, сессия удалена, апстрим больше не дёргается', async () => {
  let nowMs = 1_000_000;
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch, now: () => nowMs });
  try {
    const login = await hubLogin(h.base);
    const cookie = sidFrom(login);
    assert.equal((await fetch(`${h.base}/api/hub/auth/me`, { headers: { cookie } })).status, 200);
    nowMs += 61_000; // кэш ревалидации (60 с) истёк
    f.state.meStatus = 401; // bearer отозван на стороне EnotDesk
    const r2 = await fetch(`${h.base}/api/hub/auth/me`, { headers: { cookie } });
    assert.equal(r2.status, 401);
    const before = f.calls.filter((c) => c.path === '/api/v1/auth/me').length;
    const r3 = await fetch(`${h.base}/api/hub/auth/me`, { headers: { cookie } });
    assert.equal(r3.status, 401);
    assert.equal(f.calls.filter((c) => c.path === '/api/v1/auth/me').length, before, 'сессия уже удалена — апстрим не опрашивается');
  } finally { h.close(); }
});

test('сессия: апстрим мигнул после кэша → честный 502, сессия НЕ удаляется', async () => {
  let nowMs = 1_000_000;
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch, now: () => nowMs });
  try {
    const cookie = sidFrom(await hubLogin(h.base));
    assert.equal((await fetch(`${h.base}/api/hub/auth/me`, { headers: { cookie } })).status, 200);
    nowMs += 61_000; // кэш истёк — следующий /me пойдёт в апстрим
    f.state.meThrow = true;
    const down = await fetch(`${h.base}/api/hub/auth/me`, { headers: { cookie } });
    assert.equal(down.status, 502);
    assert.equal((await down.json()).error.code, 'enotdesk_unavailable');
    f.state.meThrow = false; // апстрим вернулся
    const back = await fetch(`${h.base}/api/hub/auth/me`, { headers: { cookie } });
    assert.equal(back.status, 200, 'сессия пережила кратковременный сбой апстрима');
  } finally { h.close(); }
});

test('logout: удаляет hub-сессию, чистит cookie и уходит в EnotDesk (best-effort)', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const cookie = sidFrom(await hubLogin(h.base));
    const res = await fetch(`${h.base}/api/hub/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.getSetCookie().join(''), /Max-Age=0/i);
    assert.equal((await fetch(`${h.base}/api/hub/auth/me`, { headers: { cookie } })).status, 401);
    assert.ok(f.calls.some((c) => c.path === '/api/v1/auth/logout'));
  } finally { h.close(); }
});

test('logout: без сессии → 401', async () => {
  const h = await startHub({ enotFetch: fakeEnotDesk().enotFetch });
  try {
    const res = await fetch(`${h.base}/api/hub/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 401);
  } finally { h.close(); }
});

test('роли: operator/admin видят консоль (200), auditor → 403, аноним → страница логина', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const anon = await fetch(`${h.base}/hub/`);
    assert.equal(anon.status, 401);
    assert.match(await anon.text(), /data-state="login"/);

    const op = await fetch(`${h.base}/hub/`, { headers: { cookie: sidFrom(await hubLogin(h.base)) } });
    assert.equal(op.status, 200);
    assert.match(await op.text(), /data-state="console"/);

    f.state.role = 'auditor';
    const aud = await fetch(`${h.base}/hub/`, { headers: { cookie: sidFrom(await hubLogin(h.base, { login: 'aud', password: 'pw' })) } });
    assert.equal(aud.status, 403);
    assert.match(await aud.text(), /data-state="forbidden"/);
  } finally { h.close(); }
});

test('статика консоли: app.mjs и i18n-модули под /hub/, остальное — 404', async () => {
  const h = await startHub({ enotFetch: fakeEnotDesk().enotFetch });
  try {
    const app = await fetch(`${h.base}/hub/app.mjs`);
    assert.equal(app.status, 200);
    assert.match(app.headers.get('content-type'), /text\/javascript/);
    assert.match(await app.text(), /applyI18n/);
    assert.equal((await fetch(`${h.base}/hub/lib/i18n.mjs`)).status, 200);
    assert.equal((await fetch(`${h.base}/hub/locales/ru.mjs`)).status, 200);
    assert.equal((await fetch(`${h.base}/hub/../server/app.mjs`)).status, 404);
    assert.equal((await fetch(`${h.base}/hub/nope.mjs`)).status, 404);
  } finally { h.close(); }
});

test('заглушки: /widget.js — 501 с комментарием, /w и /join — каркасные страницы', async () => {
  const h = await startHub({ enotFetch: fakeEnotDesk().enotFetch });
  try {
    const w = await fetch(`${h.base}/widget.js`);
    assert.equal(w.status, 501);
    assert.match(await w.text(), /T03/);
    for (const p of ['/w', '/join']) {
      const res = await fetch(`${h.base}${p}`, { headers: { 'accept-language': 'ru' } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /lang="ru"/);
      assert.match(html, /скоро|Скоро/);
    }
  } finally { h.close(); }
});

test('логин: мусорное тело → 400, лимит попыток → 429', async () => {
  const h = await startHub({ enotFetch: fakeEnotDesk().enotFetch });
  try {
    const bad = await fetch(`${h.base}/api/hub/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"login":1}',
    });
    assert.equal(bad.status, 400);
    for (let i = 0; i < 10; i += 1) await hubLogin(h.base, { password: 'nope' });
    const limited = await hubLogin(h.base, { password: 'nope' });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'rate_limited');
  } finally { h.close(); }
});

// ── craft-ревью таска 01: шифрование bearer, доверенные прокси, сырой traversal ──

test('SSO: с ENOT_SECRET_KEY bearer в БД только шифротекстом (v1:), sid — sha256', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch, secretKey: 'hub-test-secret' });
  try {
    const res = await hubLogin(h.base);
    assert.equal(res.status, 200);
    const sid = sidFrom(res).split('=')[1];
    const rows = h.db.prepare('SELECT sid_hash, bearer FROM hub_sessions').all();
    assert.equal(rows.length, 1);
    const row = rows[0];
    // sha256(sid) — известная величина, считаем независимо от кода хаба
    assert.equal(row.sid_hash, createHash('sha256').update(sid).digest('hex'));
    assert.match(row.bearer, /^v1:/, 'bearer лежит шифротекстом');
    assert.ok(!row.bearer.includes('upstream-token'), 'plaintext-токен в БД отсутствует');
    // шифротекст рабочий: ревалидация расшифровывает и ходит в EnotDesk
    const me = await fetch(`${h.base}/api/hub/auth/me`, { headers: { cookie: `enot_hub_sid=${sid}` } });
    assert.equal(me.status, 200);
  } finally { h.close(); }
});

test('SSO: без ENOT_SECRET_KEY fallback честный — bearer в БД как есть (наружу не отдаётся)', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch }); // ключа нет
  try {
    const res = await hubLogin(h.base);
    assert.equal(res.status, 200);
    const sid = sidFrom(res).split('=')[1];
    assert.ok(!res.headers.getSetCookie().join('').includes('upstream-token'), 'bearer не в cookie');
    const row = h.db.prepare('SELECT sid_hash, bearer FROM hub_sessions').get();
    assert.equal(row.bearer, 'upstream-token-1'); // задокументированный fallback (как webhook-секрет в server/)
    assert.equal(row.sid_hash, createHash('sha256').update(sid).digest('hex'));
    assert.equal((await fetch(`${h.base}/api/hub/auth/me`, { headers: { cookie: `enot_hub_sid=${sid}` } })).status, 200);
  } finally { h.close(); }
});

test('rate-limit: XFF-спуф не меняет бакет — по умолчанию заголовок не доверяется', async () => {
  const f = fakeEnotDesk({ loginStatus: 401 });
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const attempt = (xff) => fetch(`${h.base}/api/hub/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
      body: JSON.stringify({ login: 'op', password: 'nope' }),
    });
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await attempt(`9.9.9.${i}`)).status, 401, 'каждый спуф-клиент «успешно неуспешен»');
    }
    const limited = await attempt('8.8.8.8'); // свежий спуф-адрес не даёт новый бакет
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'rate_limited');
  } finally { h.close(); }
});

test('rate-limit: XFF от доверенного прокси разбирается — бакеты по реальному клиенту', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch, trustedProxy: '127.0.0.1' });
  try {
    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`${h.base}/api/hub/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}` },
        body: JSON.stringify({ login: 'op', password: 'pw' }),
      });
      assert.equal(res.status, 200, 'разные клиенты за доверенным прокси не делят бакет');
    }
  } finally { h.close(); }
});

function rawGet(port, target) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: hub.test\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
  });
}

test('traversal: сырой запрос (без нормализации fetch) не отдаёт файлы вне allowlist', async () => {
  const h = await startHub({ enotFetch: fakeEnotDesk().enotFetch });
  try {
    const port = Number(new URL(h.base).port);
    for (const target of [
      '/hub/%2e%2e%2fserver/app.mjs', // закодированный ..
      '/hub/..%2fserver%2fapp.mjs', // полу-закодированный
      '/hub/../server/app.mjs', // буквальный ..
    ]) {
      const out = await rawGet(port, target);
      assert.match(out, /HTTP\/1\.1 404/, `404 для ${target}`);
      assert.ok(!out.includes('createServer'), 'серверный код не утёк');
    }
  } finally { h.close(); }
});
