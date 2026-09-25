import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createHub, VISITOR_RE } from '../app.mjs';
import ruDict from '../../client/locales/ru.mjs';
import enDict from '../../client/locales/en.mjs';

// T03: чат-виджет. Швы — createHub HTTP/WS (фейк-EnotDesk через enotFetch):
// WS-цикл гостя↔агента, offline→тикет, CORS-эхо, consent-гейт, rating,
// история по visitor_id, лимиты/мусор WS, контракты страниц.

// Сильные visitor-токены — известные величины ('v-'+32 base64url), не вывод
// из кода под тестом; 'visitor-…' — предсказуемый мусор, сервер его не примет.
const STRONG_VISITOR = 'v-' + 'A'.repeat(32);
const STRONG_VISITOR_2 = 'v-' + 'C'.repeat(32);
const STRONG_VISITOR_3 = 'v-' + 'D'.repeat(32);

function fakeEnotDesk(overrides = {}) {
  const state = { loginStatus: 200, meStatus: 200, meThrow: false, healthOk: true, role: 'operator', ...overrides };
  const calls = [];
  const user = () => ({ id: 'u1', login: 'op', name: 'Оператор', role: state.role, active: true });
  const enotFetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push({ path });
    if (path === '/api/v1/auth/login') {
      if (state.loginStatus !== 200) return Response.json({ error: { code: 'invalid_credentials', message: 'upstream' } }, { status: state.loginStatus });
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

async function startHub({ enotFetch, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'enotdesk-hub-widget-'));
  const inst = createHub({
    dbPath: join(dir, 'hub.db'),
    port: 0,
    enotdeskUrl: 'http://enot.test',
    publicUrl: 'http://hub.example',
    enotFetch,
    widgetHelloMs: 300,
    ...extra,
  });
  const port = await inst.start();
  return { inst, base: `http://127.0.0.1:${port}`, port, db: inst.db, close: () => inst.close() };
}

async function loginCookie(base) {
  const res = await fetch(`${base}/api/hub/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'op', password: 'pw' }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('enot_hub_sid='));
  return cookie.split(';')[0];
}

function wsOpen(port, path, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  ws.log = [];
  ws.on('message', (raw) => {
    try { ws.log.push(JSON.parse(raw.toString())); } catch { ws.log.push(null); }
  });
  ws.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_q, res) => reject(new Error(`upgrade ${res.statusCode}`)));
  });
  ws.closed = new Promise((resolve) => { if (ws.readyState === WebSocket.CLOSED) resolve(0); ws.once('close', (code) => resolve(code)); });
  ws.wait = (pred, ms = 2000) => new Promise((resolve, reject) => {
    const check = (m) => m && pred(m);
    const buffered = ws.log.find(check);
    if (buffered) return resolve(buffered);
    const timer = setTimeout(() => { ws.off('message', on); reject(new Error('ws wait timeout')); }, ms);
    const on = (raw) => {
      try { const m = JSON.parse(raw.toString()); if (check(m)) { clearTimeout(timer); ws.off('message', on); resolve(m); } } catch { /* не JSON */ }
    };
    ws.on('message', on);
  });
  return ws;
}

async function api(base, method, p, { cookie, body, headers = {} } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* не JSON */ }
  return { status: res.status, json, headers: res.headers };
}

// Гость: страница выдаёт visitor-cookie; для WS-теста носим её как куку.
async function guestCookie(base) {
  const res = await fetch(`${base}/w`);
  const c = res.headers.getSetCookie().find((x) => x.startsWith('enot_wv='));
  assert.ok(c, 'страница /w выдаёт enot_wv');
  return c.split(';')[0];
}

async function setup({ role = 'operator' } = {}) {
  const f = fakeEnotDesk({ role });
  const h = await startHub({ enotFetch: f.enotFetch });
  const cookie = await loginCookie(h.base);
  return { f, h, cookie };
}

// ---- статика и контракты страниц ----

const widgetDir = join(import.meta.dirname, '..', 'widget');
const wHtml = readFileSync(join(widgetDir, 'w.html'), 'utf8');
const wJs = readFileSync(join(widgetDir, 'w.mjs'), 'utf8');

test('виджет: статика отдаётся честно — /widget.js без зависимостей, /w с CSP и visitor-cookie', async () => {
  const h = await startHub({ enotFetch: fakeEnotDesk().enotFetch });
  try {
    const loader = await fetch(`${h.base}/widget.js`);
    assert.equal(loader.status, 200);
    assert.match(loader.headers.get('content-type'), /javascript/);
    assert.match(loader.headers.get('cache-control'), /max-age=3600/, 'кэш лоадера 1 ч');
    const loaderText = await loader.text();
    assert.match(loaderText, /data-server/, 'лоадер читает data-server');
    assert.ok(!/\brequire\(|from ['"]node:/.test(loaderText), 'без зависимостей');

    const page = await fetch(`${h.base}/w`, { headers: { 'accept-language': 'ru' } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    const setCookie = page.headers.getSetCookie().find((c) => c.startsWith('enot_wv='));
    assert.match(setCookie ?? '', /Path=\//, 'visitor-cookie на Path=/ (иначе не дойдёт до /ws/widget)');
    assert.match(setCookie ?? '', /HttpOnly/);

    const app = await fetch(`${h.base}/hub/widget/w.mjs`);
    assert.equal(app.status, 200, 'модуль страницы доступен под /hub/widget/w.mjs');

    // T05: /join без токена — честная 404 (живая страница — в hub/test/join.test)
    const joinPage = await fetch(`${h.base}/join`);
    assert.equal(joinPage.status, 404, '/join без токена — честная 404');
  } finally { h.close(); }
});

test('контракты w.html: все id из w.mjs есть в разметке, кнопки живые, тексты — только словарь', () => {
  const htmlIds = new Set([...wHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const id of [...wJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1])) {
    assert.ok(htmlIds.has(id), `id «${id}» из w.mjs отсутствует в w.html`);
  }
  for (const id of ['w-msgs', 'w-input', 'w-send', 'w-status-text', 'w-prechat', 'w-offline', 'w-rating']) {
    assert.ok(htmlIds.has(id), `нет обязательного id «${id}»`);
  }
  // анти-мёртвые: звёзды rating подключены циклом по data-star
  assert.match(wJs, /data-star/, 'звёзды rating размечены data-star');
  assert.match(wJs, /addEventListener\('click'/, 'кнопки подключены');
  // тексты — только словари: data-i18n ключи есть в ru и en
  const keys = [...wHtml.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 15, `статические тексты размечены i18n (${keys.length})`);
  for (const key of new Set(keys)) {
    assert.ok(key in ruDict && key in enDict, `ключ «${key}» отсутствует в словарях`);
  }
  for (const m of wJs.matchAll(/\bt\('([^']+)'/g)) {
    assert.ok(m[1] in ruDict && m[1] in enDict, `t('${m[1]}') нет в словарях`);
  }
  const cyr = /[\u0400-\u04FF]/;
  for (const lit of wJs.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []) {
    assert.ok(!cyr.test(lit), `кириллический литерал в w.mjs: ${lit.slice(0, 50)}`);
  }
});

// ---- cookie enot_wv: path-match до /ws/widget и SameSite-скоуплинг ----

// RFC 6265 §5.1.4: кука совпадает с путём запроса только на границе сегмента —
// Path=/w НЕ матчится с /ws/widget, реальный браузер куку на WS не пошлёт бы.
function cookiePathMatches(cookiePath, requestPath) {
  if (requestPath === cookiePath) return true;
  return requestPath.startsWith(cookiePath)
    && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/');
}

test('cookie enot_wv: Path=/ матчится с /ws/widget по RFC 6265; SameSite скоуплен с Secure', async () => {
  const fHttp = fakeEnotDesk();
  const insecure = await startHub({ enotFetch: fHttp.enotFetch });
  try {
    const page = await fetch(`${insecure.base}/w`);
    const sc = page.headers.getSetCookie().find((c) => c.startsWith('enot_wv='));
    assert.ok(sc, 'страница /w выдаёт visitor-cookie');
    const cookiePath = (sc.match(/Path=([^;]+)/) ?? [])[1] ?? '';
    assert.equal(cookiePathMatches(cookiePath, '/ws/widget'), true,
      `кука с Path=${cookiePath} не уйдёт браузером на WS-эндпоинт /ws/widget`);
    assert.equal(cookiePathMatches(cookiePath, '/w'), true, 'кука работает и на самой странице');
    assert.equal((sc.match(/SameSite=(\w+)/) ?? [])[1], 'Lax', 'без https — SameSite=Lax');
    assert.ok(!sc.includes('Secure'), 'без https Secure не ставится');

    const fHttps = fakeEnotDesk();
    const secure = await startHub({ enotFetch: fHttps.enotFetch, publicUrl: 'https://hub.example' });
    try {
      const page2 = await fetch(`${secure.base}/w`);
      const sc2 = page2.headers.getSetCookie().find((c) => c.startsWith('enot_wv='));
      assert.equal((sc2.match(/SameSite=(\w+)/) ?? [])[1], 'None', 'сторонний iframe на https — SameSite=None');
      assert.match(sc2, /Secure/, 'SameSite=None обязан идти с Secure');
    } finally { secure.close(); }
  } finally { insecure.close(); }
});

test('visitor_id: только сильные токены — слабый hello-токен игнорируется, сильный принимается', async () => {
  // RE-контракт: 'v-'+32..128 base64url; uuid и предсказуемые 'visitor-…' не проходят
  assert.ok(VISITOR_RE.test(STRONG_VISITOR));
  assert.ok(!VISITOR_RE.test('visitor-allowed-01'), 'предсказуемый токен не матчится');
  assert.ok(!VISITOR_RE.test('6cf1a9a8-4b7d-4f0e-9a2f-8f0d3f7c9b11'), 'uuid не матчится');
  assert.ok(!VISITOR_RE.test('v-короткий10'), 'короткий хвост не матчится');
  assert.ok(!VISITOR_RE.test('v-' + 'A'.repeat(31)), 'меньше 32 символов — слабо');

  const { h } = await setup();
  let ws;
  try {
    const vc = await guestCookie(h.base);
    ws = wsOpen(h.port, '/ws/widget', { cookie: vc });
    await ws.opened;
    ws.send(JSON.stringify({ type: 'hello', visitorId: 'visitor-allowed-01' }));
    let ready = await ws.wait((m) => m.type === 'ready');
    assert.match(ready.visitorId, VISITOR_RE, 'fallback — сильный серверный токен');
    assert.notEqual(ready.visitorId, 'visitor-allowed-01', 'слабый токен отброшен, не запомнен');
    ws.close();

    const ws2 = wsOpen(h.port, '/ws/widget'); // куки блокированы — localStorage-fallback
    await ws2.opened;
    ws2.send(JSON.stringify({ type: 'hello', visitorId: STRONG_VISITOR_2 }));
    ready = await ws2.wait((m) => m.type === 'ready');
    assert.equal(ready.visitorId, STRONG_VISITOR_2, 'сильный сохранённый токен принят как есть');
    ws = ws2;
  } finally { ws?.close(); h.close(); }
});

// ---- WS-цикл гостя ↔ агента ----

test('WS-цикл: pre-chat → сообщение гостя → агент получил → ответ → гость получил; typing в обе стороны', async () => {
  const { h, cookie } = await setup();
  let consoleWs;
  let guest;
  try {
    consoleWs = wsOpen(h.port, '/ws/console', { cookie });
    await consoleWs.opened;
    const ready = await consoleWs.wait((m) => m.type === 'ready');
    assert.equal(ready.me.id, 'u1');
    assert.ok(ready.presence.some((p) => p.agentId === 'u1' && p.status === 'online'), 'консоль-подключение = агент online');

    const vc = await guestCookie(h.base);
    guest = wsOpen(h.port, '/ws/widget', { cookie: vc });
    await guest.opened;
    guest.send(JSON.stringify({ type: 'hello', name: 'Аня', email: 'anya@example.com' }));
    const gReady = await guest.wait((m) => m.type === 'ready');
    assert.equal(gReady.presence.status, 'online', 'виджету честно видно: агенты online');
    assert.ok(gReady.visitorId.length >= 8);
    assert.deepEqual(gReady.thread, null, 'тред создаётся при первом сообщении, не при подключении');

    guest.send(JSON.stringify({ type: 'msg', text: 'Здравствуйте, помогите с установкой' }));
    const notify = await consoleWs.wait((m) => m.type === 'new-message');
    assert.equal(notify.thread.channel, 'chat');
    assert.equal(notify.message.author, 'contact');
    assert.equal(notify.message.body, 'Здравствуйте, помогите с установкой');
    const sentAck = await guest.wait((m) => m.type === 'sent');
    assert.equal(sentAck.threadId, notify.thread.id);
    // эхо: гость видит своё сообщение сразу, а не только по реплею истории
    const echo = guest.log.find((m) => m?.type === 'msg' && m.message?.author === 'contact');
    assert.ok(echo, 'гость получил эхо своего сообщения');
    assert.equal(echo.message.body, 'Здравствуйте, помогите с установкой');
    assert.equal(echo.threadId, notify.thread.id);

    const row = h.db.prepare(`
      SELECT t.channel, t.subject, c.name, c.email FROM threads t JOIN contacts c ON c.id = t.contact_id
    `).get();
    assert.equal(row.channel, 'chat');
    assert.equal(row.name, 'Аня');
    assert.equal(row.email, 'anya@example.com');

    guest.send(JSON.stringify({ type: 'typing' }));
    await consoleWs.wait((m) => m.type === 'typing' && m.threadId === notify.thread.id);

    consoleWs.send(JSON.stringify({ type: 'reply', threadId: notify.thread.id, text: 'Конечно, опишите шаги' }));
    const back = await guest.wait((m) => m.type === 'msg' && m.message?.author === 'agent');
    assert.equal(back.message.body, 'Конечно, опишите шаги');
    assert.equal(back.message.author, 'agent');
    await consoleWs.wait((m) => m.type === 'agent-message' && m.threadId === notify.thread.id);

    consoleWs.send(JSON.stringify({ type: 'typing', threadId: notify.thread.id }));
    await guest.wait((m) => m.type === 'agent-typing');
  } finally {
    guest?.close();
    consoleWs?.close();
    h.close();
  }
});

test('история между визитами: переподключение с тем же visitor cookie видит тред и сообщения', async () => {
  const { h } = await setup();
  let guest;
  try {
    const vc = await guestCookie(h.base);
    guest = wsOpen(h.port, '/ws/widget', { cookie: vc });
    await guest.opened;
    guest.send(JSON.stringify({ type: 'hello' }));
    let ready = await guest.wait((m) => m.type === 'ready');
    guest.send(JSON.stringify({ type: 'msg', text: 'первый визит' }));
    const sent = await guest.wait((m) => m.type === 'sent');
    guest.close();

    const guest2 = wsOpen(h.port, '/ws/widget', { cookie: vc });
    await guest2.opened;
    guest2.send(JSON.stringify({ type: 'hello' }));
    ready = await guest2.wait((m) => m.type === 'ready');
    assert.equal(ready.thread.id, sent.threadId, 'тот же тред у того же посетителя');
    assert.ok(ready.messages.some((m) => m.body === 'первый визит'));
    guest2.close();

    // HTTP-история: тот же visitorId по list
    const visitorId = ready.visitorId;
    const list = await api(h.base, 'GET', `/api/hub/widget/list?visitorId=${visitorId}`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(list.status, 200);
    assert.equal(list.json.threads.length, 1);
    guest = guest2;
  } finally {
    guest?.close();
    h.close();
  }
});

// ---- consent-гейт ----

test('consent-гейт: без согласия чат не стартует; согласие фиксируется в контакте', async () => {
  const { h, cookie } = await setup({ role: 'admin' });
  let guest;
  try {
    const set = await api(h.base, 'POST', '/api/hub/settings/widget', {
      cookie, body: { consentRequired: true, policyUrl: 'https://hub.example/privacy' },
    });
    assert.equal(set.status, 200);

    const vc = await guestCookie(h.base);
    guest = wsOpen(h.port, '/ws/widget', { cookie: vc });
    await guest.opened;
    guest.send(JSON.stringify({ type: 'hello' }));
    const ready = await guest.wait((m) => m.type === 'ready');
    assert.equal(ready.settings.consentRequired, true);
    assert.equal(ready.settings.policyUrl, 'https://hub.example/privacy');

    guest.send(JSON.stringify({ type: 'msg', text: 'привет' }));
    const err = await guest.wait((m) => m.type === 'error');
    assert.equal(err.code, 'consent_required');
    assert.equal(h.db.prepare('SELECT count(*) c FROM threads').get().c, 0, 'тред не создан без согласия');

    guest.send(JSON.stringify({ type: 'consent', accepted: true }));
    await guest.wait((m) => m.type === 'ok');
    guest.send(JSON.stringify({ type: 'msg', text: 'теперь можно' }));
    await guest.wait((m) => m.type === 'sent');
    const contact = h.db.prepare('SELECT consent_at FROM contacts').get();
    assert.ok(contact.consent_at, 'согласие зафиксировано GDPR-фактом');
  } finally {
    guest?.close();
    h.close();
  }
});

// ---- offline → тикет ----

test('offline-форма создаёт тикет email-канала; presence честно отражает агентов', async () => {
  const { h } = await setup();
  try {
    const p0 = await api(h.base, 'GET', '/api/hub/widget/presence', { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.deepEqual(p0.json.presence, { status: 'offline', agentsOnline: 0 });

    const vc = await guestCookie(h.base);
    const bad = await api(h.base, 'POST', '/api/hub/widget/offline', {
      headers: { 'sec-fetch-site': 'same-origin', cookie: vc },
      body: { email: 'не-почта', subject: 'Т', text: 'Х' },
    });
    assert.equal(bad.status, 400);

    const ok = await api(h.base, 'POST', '/api/hub/widget/offline', {
      headers: { 'sec-fetch-site': 'same-origin', cookie: vc },
      body: { email: 'guest@example.com', subject: 'Не работает вход', text: 'Пишу из формы: не работает вход' },
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.thread.channel, 'email');
    const row = h.db.prepare('SELECT t.subject, t.channel, c.email, c.visitor_id FROM threads t JOIN contacts c ON c.id = t.contact_id').get();
    assert.equal(row.subject, 'Не работает вход');
    assert.equal(row.email, 'guest@example.com');
    assert.ok(row.visitor_id, 'offline-контакт связан с visitor_id');

    // агент подключился → статус online
    const consoleWs = wsOpen(h.port, '/ws/console', { cookie: await loginCookie(h.base) });
    try {
      await consoleWs.opened;
      await consoleWs.wait((m) => m.type === 'ready');
      const p1 = await api(h.base, 'GET', '/api/hub/widget/presence', { headers: { 'sec-fetch-site': 'same-origin' } });
      assert.equal(p1.json.presence.status, 'online');
    } finally { consoleWs.close(); }
  } finally { h.close(); }
});

// ---- CORS ----

test('CORS: эхо разрешённого Origin, чужой и отсутствующий — 403', async () => {
  const { h, cookie } = await setup({ role: 'admin' });
  try {
    await api(h.base, 'POST', '/api/hub/settings/widget', {
      cookie, body: { origins: ['site.example'] },
    });

    const allowed = await api(h.base, 'POST', '/api/hub/widget/create', {
      headers: { origin: 'https://site.example' },
      body: { visitorId: STRONG_VISITOR },
    });
    assert.equal(allowed.status, 201);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://site.example');
    assert.match(allowed.headers.get('vary') ?? '', /Origin/);

    const evil = await api(h.base, 'POST', '/api/hub/widget/create', {
      headers: { origin: 'https://evil.example' },
      body: { visitorId: STRONG_VISITOR },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error.code, 'cors_denied');

    const silent = await api(h.base, 'POST', '/api/hub/widget/create', {
      body: { visitorId: STRONG_VISITOR },
    });
    assert.equal(silent.status, 403, 'без Origin и без same-origin — 403');

    const same = await api(h.base, 'POST', '/api/hub/widget/create', {
      headers: { 'sec-fetch-site': 'same-origin' },
      body: { visitorId: STRONG_VISITOR_2 },
    });
    assert.equal(same.status, 201, 'same-origin странице CORS не нужен');

    const pre = await fetch(`${h.base}/api/hub/widget/settings`, {
      method: 'OPTIONS',
      headers: { origin: 'https://site.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://site.example');

    const preEvil = await fetch(`${h.base}/api/hub/widget/settings`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(preEvil.status, 403);
  } finally { h.close(); }
});

// ---- rating ----

test('rating после resolve пишется в store; не-ваш тред и не-resolved — отказ', async () => {
  const { h, cookie } = await setup();
  let guest;
  try {
    const vc = await guestCookie(h.base);
    guest = wsOpen(h.port, '/ws/widget', { cookie: vc });
    await guest.opened;
    guest.send(JSON.stringify({ type: 'hello' }));
    await guest.wait((m) => m.type === 'ready');
    guest.send(JSON.stringify({ type: 'msg', text: 'нужна помощь' }));
    const sent = await guest.wait((m) => m.type === 'sent');

    // не-resolved → 409
    const visitorId = vc.match(/enot_wv=([^;]+)/)[1];
    const notResolved = await api(h.base, 'POST', '/api/hub/widget/rating', {
      headers: { 'sec-fetch-site': 'same-origin', cookie: vc },
      body: { visitorId, threadId: sent.threadId, rating: 5 },
    });
    assert.equal(notResolved.status, 409, 'оценить можно только resolved-чат');

    const resolve = await api(h.base, 'PATCH', `/api/hub/threads/${sent.threadId}`, {
      cookie, body: { status: 'resolved' },
    });
    assert.equal(resolve.status, 200);
    await guest.wait((m) => m.type === 'resolved' && m.threadId === sent.threadId);

    const foreign = await api(h.base, 'POST', '/api/hub/widget/rating', {
      headers: { 'sec-fetch-site': 'same-origin' },
      body: { visitorId: 'visitor-чужой-0001', threadId: sent.threadId, rating: 5 },
    });
    assert.equal(foreign.status, 400, 'мусорный формат visitorId отклонён');
    const stranger = await api(h.base, 'POST', '/api/hub/widget/rating', {
      headers: { 'sec-fetch-site': 'same-origin' },
      body: { visitorId: STRONG_VISITOR_3, threadId: sent.threadId, rating: 5 },
    });
    assert.equal(stranger.status, 403, 'чужой visitorId не оценивает чужой тред');

    const junk = await api(h.base, 'POST', '/api/hub/widget/rating', {
      headers: { 'sec-fetch-site': 'same-origin', cookie: vc },
      body: { visitorId, threadId: sent.threadId, rating: 7 },
    });
    assert.equal(junk.status, 400);

    const good = await api(h.base, 'POST', '/api/hub/widget/rating', {
      headers: { 'sec-fetch-site': 'same-origin', cookie: vc },
      body: { visitorId, threadId: sent.threadId, rating: 5 },
    });
    assert.equal(good.status, 200);
    assert.equal(good.json.thread.rating, 5);
    assert.equal(h.db.prepare('SELECT rating FROM threads WHERE id = ?').get(sent.threadId).rating, 5, 'оценка в store');
  } finally {
    guest?.close();
    h.close();
  }
});

// ---- лимиты и мусор WS ----

test('WS-лимиты: мусор/чужой тип/таймаут hello/переразмер/флуд закрываются честно', async () => {
  const { h } = await setup();
  try {
    // плохой JSON → 4002
    let ws = wsOpen(h.port, '/ws/widget');
    await ws.opened;
    ws.send('не-json');
    assert.equal(await ws.closed, 4002);

    // сообщение не-hello до аутентификации → 4002
    ws = wsOpen(h.port, '/ws/widget');
    await ws.opened;
    ws.send(JSON.stringify({ type: 'msg', text: 'x' }));
    assert.equal(await ws.closed, 4002);

    // таймаут hello (widgetHelloMs=300) → 4001
    ws = wsOpen(h.port, '/ws/widget');
    await ws.opened;
    assert.equal(await ws.closed, 4001);

    // переразмер → maxPayload 64 КБ → 1009
    ws = wsOpen(h.port, '/ws/widget');
    await ws.opened;
    ws.send(JSON.stringify({ type: 'hello' }));
    ws.send(JSON.stringify({ type: 'msg', text: 'x'.repeat(70 * 1024) }));
    assert.equal(await ws.closed, 1009);

    // флуд: 21-е сообщение в 10 с → 1008
    ws = wsOpen(h.port, '/ws/widget');
    await ws.opened;
    ws.send(JSON.stringify({ type: 'hello' }));
    await ws.wait((m) => m.type === 'ready');
    for (let i = 0; i < 21; i += 1) ws.send(JSON.stringify({ type: 'msg', text: `flood ${i}` }));
    assert.equal(await ws.closed, 1008);

    // чужой путь апгрейда — отказ
    const bad = wsOpen(h.port, '/ws/other');
    await assert.rejects(bad.opened);
  } finally { h.close(); }
});

// ---- консоль-настройки виджета ----

test('настройки виджета: GET/POST админом, оператору 403, мусор 400, нормализация origins', async () => {
  const { h, cookie, f } = await setup({ role: 'admin' });
  try {
    const def = await api(h.base, 'GET', '/api/hub/settings/widget', { cookie });
    assert.equal(def.status, 200);
    assert.deepEqual(def.json.settings, { origins: [], consentRequired: false, policyUrl: '' });

    const junk = await api(h.base, 'POST', '/api/hub/settings/widget', {
      cookie, body: { origins: ['bad host!'] },
    });
    assert.equal(junk.status, 400);

    const junkUrl = await api(h.base, 'POST', '/api/hub/settings/widget', {
      cookie, body: { policyUrl: 'ftp://hub.example/x' },
    });
    assert.equal(junkUrl.status, 400);

    const saved = await api(h.base, 'POST', '/api/hub/settings/widget', {
      cookie,
      body: { origins: ['https://Site.example:8443/path', 'site.example'], consentRequired: true, policyUrl: 'https://hub.example/privacy' },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.settings.origins, ['site.example:8443', 'site.example'], 'нормализация без дублей');
    assert.equal(saved.json.settings.consentRequired, true);

    const roundtrip = await api(h.base, 'GET', '/api/hub/settings/widget', { cookie });
    assert.deepEqual(roundtrip.json.settings, saved.json.settings);

    // оператору — 403
    f.state.role = 'operator';
    const opCookie = await loginCookie(h.base, f.state);
    const forbidden = await api(h.base, 'GET', '/api/hub/settings/widget', { cookie: opCookie });
    assert.equal(forbidden.status, 403);
  } finally { h.close(); }
});
