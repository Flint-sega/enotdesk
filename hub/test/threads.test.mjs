import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../app.mjs';
import { openHubDb } from '../db.mjs';
import { createThreadsStore, sanitizeTags, sanitizeText, sanitizeEmail, sanitizeShortcut, THREAD_LIMITS } from '../threads.mjs';

// Фейк-EnotDesk: тот же шов, что в hub-skeleton.test (инъекция enotFetch).
function fakeEnotDesk(overrides = {}) {
  const state = { loginStatus: 200, meStatus: 200, meThrow: false, healthOk: true, role: 'operator', ...overrides };
  const calls = [];
  const user = () => ({ id: 'u1', login: 'op', name: 'Оператор', role: state.role, active: true });
  const enotFetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, opts });
    if (path === '/api/v1/auth/login') {
      if (state.loginStatus !== 200) {
        return Response.json({ error: { code: 'invalid_credentials', message: 'upstream' } }, { status: state.loginStatus });
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

async function startHub({ enotFetch, now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'enotdesk-hub-threads-'));
  const inst = createHub({
    dbPath: join(dir, 'hub.db'),
    port: 0,
    enotdeskUrl: 'http://enot.test',
    publicUrl: 'http://hub.example',
    enotFetch,
    now,
  });
  const port = await inst.start();
  return { inst, base: `http://127.0.0.1:${port}`, db: inst.db, dir, close: () => inst.close() };
}

async function loginCookie(base) {
  // роль задаёт тест через f.state.role ДО вызова — логин проксируется в фейк-апстрим хаба
  const res = await fetch(`${base}/api/hub/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'op', password: 'pw' }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('enot_hub_sid='));
  return cookie.split(';')[0];
}

const api = (base, method, path, { cookie, body } = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
  },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

// ---- store: схема, санитизация, CRUD ----

function freshStore() {
  const db = openHubDb(':memory:');
  let tick = 1_000_000; // монотонные часы: порядок last_activity определён
  return { db, store: createThreadsStore(db, { nowMs: () => (tick += 1000) }) };
}

test('store: схема v2 — таблицы тикетов и индексы на месте', () => {
  const { db } = freshStore();
  for (const table of ['contacts', 'threads', 'messages', 'canned', 'agent_presence']) {
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table), `нет таблицы ${table}`);
  }
  const idx = db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='index' AND name LIKE 'idx_threads%'`).get().c;
  assert.ok(idx >= 3, `индексы статус/канал/last_activity (найдено ${idx})`);
});

test('store: CHECK-ограничения — чужой channel/status/author/type не записывается', () => {
  const { store } = freshStore();
  assert.equal(store.createThread({ channel: 'fax', subject: 'x' }), null);
  const t = store.createThread({ channel: 'manual', subject: 'Тема' });
  assert.equal(store.updateThread(t.id, { status: 'closed' }), 'invalid');
  assert.equal(store.appendMessage(t.id, { author: 'robot', body: 'hi' }), null);
  assert.equal(store.appendMessage(t.id, { author: 'agent', type: 'audio', body: 'hi' }), null);
});

test('store: создание треда с контактом — dedupe по email, первое сообщение, last_activity', () => {
  const { store } = freshStore();
  const t1 = store.createThread({
    channel: 'manual',
    subject: 'Не печатает принтер',
    contact: { email: 'ivan@example.com', name: 'Иван' },
    firstMessage: { author: 'contact', body: 'Здравствуйте, принтер не работает' },
  });
  assert.ok(t1.id);
  assert.equal(t1.channel, 'manual');
  assert.equal(t1.status, 'open');
  assert.equal(t1.contact.email, 'ivan@example.com');
  assert.equal(t1.contact.name, 'Иван');
  assert.equal(t1.messageCount, 1);
  // тот же email — тот же контакт (история общая)
  const t2 = store.createThread({ channel: 'email', subject: 'Ещё письмо', contact: { email: 'ivan@example.com' } });
  assert.equal(t2.contact.id, t1.contact.id);
  // новое сообщение двигает last_activity вперёд и растит счётчик
  const m = store.appendMessage(t1.id, { author: 'agent', body: 'Ответ', agentId: 'u1' });
  assert.equal(m.author, 'agent');
  assert.equal(m.agentId, 'u1');
  const again = store.getThread(t1.id);
  assert.equal(again.messages.length, 2);
  assert.ok(again.thread.lastActivityAt >= t1.lastActivityAt);
});

test('store: санитизация — потолок текста 8000, теги 10×30, мусор честно отброшен', () => {
  assert.equal(sanitizeText('   ок  ', 100), 'ок');
  assert.equal(sanitizeText('x'.repeat(THREAD_LIMITS.body + 50), THREAD_LIMITS.body).length, THREAD_LIMITS.body);
  assert.equal(sanitizeText(42, 100), null);
  assert.equal(sanitizeText('', 100), null);
  assert.deepEqual(sanitizeTags(['а', 'б']), ['а', 'б']);
  assert.equal(sanitizeTags(Array.from({ length: 11 }, (_, i) => `t${i}`)), null);
  assert.equal(sanitizeTags(['x'.repeat(31)]), null); // тег длиннее 30 — весь патч невалиден
  assert.equal(sanitizeTags([42]), null);
  assert.equal(sanitizeEmail('ivan@example.com'), 'ivan@example.com');
  assert.equal(sanitizeEmail('не почта'), null);
  assert.equal(sanitizeShortcut('#printer'), 'printer'); // ведущий # съедается
  assert.equal(sanitizeShortcut('плохой шорткат'), null);
  const { store } = freshStore();
  assert.equal(store.createThread({ channel: 'manual', subject: '   ' }), null, 'пустая тема — отказ');
  assert.equal(store.updateThread('нет', { tags: [42] }), null, 'несуществующий тред — null');
});

test('store: фильтры инбокса — статус/канал/тег/assignee/поиск, total честный', () => {
  const { store } = freshStore();
  const a = store.createThread({ channel: 'chat', subject: 'Чат про принтер', contact: { name: 'Иван' }, tags: ['принтер'] });
  const b = store.createThread({ channel: 'email', subject: 'Письмо про оплату', tags: ['бухгалтерия'] });
  const c = store.createThread({ channel: 'manual', subject: 'Звонок', contact: { email: 'petr@example.com' } });
  store.updateThread(b.id, { status: 'pending', assigneeId: 'u1' });
  assert.equal(store.listThreads({}).total, 3);
  // свежие раньше: среди open — c (создан последним), затем a
  assert.deepEqual(store.listThreads({ status: 'open' }).items.map((t) => t.id), [c.id, a.id]);
  assert.deepEqual(store.listThreads({ channel: 'email' }).items.map((t) => t.id), [b.id]);
  assert.equal(store.listThreads({ tag: 'принтер' }).total, 1);
  assert.equal(store.listThreads({ assigneeId: 'u1' }).total, 1, 'фильтр по assignee');
  assert.equal(store.listThreads({ q: 'принтер' }).total, 1, 'поиск находит в теме');
  assert.equal(store.listThreads({ q: 'petr@' }).total, 1, 'поиск находит в email контакта');
  assert.equal(store.listThreads({ q: 'Иван' }).total, 1, 'поиск находит в имени контакта');
  assert.equal(store.listThreads({ q: 'NoSuch' }).total, 0);
});

test('store: пагинация — limit/offset режут выдачу, total не зависит от окна', () => {
  const { store } = freshStore();
  for (let i = 0; i < 7; i += 1) store.createThread({ channel: 'manual', subject: `Тикет ${i}` });
  const page = store.listThreads({ limit: 3, offset: 3 });
  assert.equal(page.items.length, 3);
  assert.equal(page.total, 7);
  // сортировка по свежести: самые новые раньше
  assert.deepEqual(store.listThreads({ limit: 2 }).items.map((t) => t.subject), ['Тикет 6', 'Тикет 5']);
});

test('store: updateThread — статус/assignee/теги; снятие assignee через null', () => {
  const { store } = freshStore();
  const t = store.createThread({ channel: 'chat', subject: 'x' });
  const upd = store.updateThread(t.id, { status: 'resolved', assigneeId: 'u1', tags: ['сеть', 'срочно'] });
  assert.equal(upd.status, 'resolved');
  assert.equal(upd.assigneeId, 'u1');
  assert.deepEqual(upd.tags, ['сеть', 'срочно']);
  const cleared = store.updateThread(t.id, { assigneeId: null });
  assert.equal(cleared.assigneeId, null);
  assert.equal(store.setRating(t.id, 5).rating, 5);
  assert.equal(store.setRating(t.id, 6), 'invalid');
  assert.equal(store.setRating(t.id, null).rating, null);
  assert.equal(store.setRating('нет', 3), null);
});

test('store: canned — приватные и общие, дубликат шортката в скоупе, чужой приватный не виден', () => {
  const { store } = freshStore();
  const mine = store.createCanned({ scope: 'private', shortcut: 'hi', text: 'Здравствуйте!', agentId: 'u1' });
  assert.ok(mine.id);
  assert.equal(store.createCanned({ scope: 'private', shortcut: 'hi', text: 'дубль', agentId: 'u1' }), 'duplicate');
  assert.notEqual(store.createCanned({ scope: 'private', shortcut: 'hi', text: 'другого агента', agentId: 'u2' })?.id, undefined, 'тот же шорткат у другого агента — можно');
  const shared = store.createCanned({ scope: 'shared', shortcut: 'docs', text: 'Пришлите документы' });
  assert.equal(store.createCanned({ scope: 'shared', shortcut: 'docs', text: 'дубль' }), 'duplicate');
  const seen1 = store.listCanned('u1');
  assert.equal(seen1.length, 2, 'u1 видит только свой приватный и общий');
  assert.ok(seen1.some((c) => c.scope === 'shared' && c.shortcut === 'docs'));
  assert.ok(!seen1.some((c) => c.agentId === 'u2'), 'чужой приватный не виден');
  const seen2 = store.listCanned('u3');
  assert.equal(seen2.length, 1, 'u3 видит только общий');
  assert.equal(store.deleteCanned(mine.id, 'u3'), false, 'чужой приватный удалить нельзя');
  assert.equal(store.deleteCanned(mine.id, 'u1'), true);
  assert.equal(store.deleteCanned(shared.id, 'u3'), true, 'общий может удалить любой агент консоли');
  assert.equal(store.createCanned({ scope: 'private', shortcut: '!', text: 'x', agentId: 'u1' }), 'invalid');
});

test('store: presence — set/get/list, чужой статус — false', () => {
  const { store } = freshStore();
  assert.equal(store.setPresence('u1', 'online'), true);
  assert.equal(store.getPresence('u1').status, 'online');
  store.setPresence('u1', 'away');
  assert.equal(store.getPresence('u1').status, 'away');
  assert.equal(store.setPresence('u1', 'busy'), false);
  assert.equal(store.getPresence('u1').status, 'away', 'невалидный статус не перезаписал');
  store.setPresence('u2', 'offline');
  assert.deepEqual(store.listPresence().map((p) => p.agentId).sort(), ['u1', 'u2']);
});

// ---- REST: RBAC и маршруты /api/hub/* ----

test('REST: инбокс без сессии — 401, auditor — 403, operator/admin — 200', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    assert.equal((await api(h.base, 'GET', '/api/hub/threads')).status, 401);
    f.state.role = 'auditor';
    const aud = await loginCookie(h.base);
    const res = await api(h.base, 'GET', '/api/hub/threads', { cookie: aud });
    assert.equal(res.status, 403);
    f.state.role = 'operator';
    const op = await loginCookie(h.base);
    const ok1 = await api(h.base, 'GET', '/api/hub/threads', { cookie: op });
    assert.equal(ok1.status, 200);
    f.state.role = 'admin';
    const adm = await loginCookie(h.base);
    const ok2 = await api(h.base, 'GET', '/api/hub/threads', { cookie: adm });
    assert.equal(ok2.status, 200);
    assert.deepEqual((await ok2.json()).total, 0);
  } finally { h.close(); }
});

test('REST: ручной тикет — оператор И админ создают; мусор — 400', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const op = await loginCookie(h.base);
    const r1 = await api(h.base, 'POST', '/api/hub/threads', {
      cookie: op,
      body: { subject: 'Звонок из офиса', text: 'Просили перезвонить', contact: { email: 'client@example.com', name: 'Клиент' } },
    });
    assert.equal(r1.status, 201);
    const t1 = (await r1.json()).thread;
    assert.equal(t1.channel, 'manual');
    assert.equal(t1.status, 'open');
    assert.equal(t1.contact.email, 'client@example.com');
    f.state.role = 'admin';
    const adm = await loginCookie(h.base);
    const r2 = await api(h.base, 'POST', '/api/hub/threads', {
      cookie: adm,
      body: { subject: 'Тикет от админа', text: 'текст' },
    });
    assert.equal(r2.status, 201);
    const bad = await api(h.base, 'POST', '/api/hub/threads', { cookie: op, body: { text: 'без темы' } });
    assert.equal(bad.status, 400);
    const bad2 = await api(h.base, 'POST', '/api/hub/threads', { cookie: op, body: { subject: 'x', text: 'y', contact: { email: 'мусор' } } });
    assert.equal(bad2.status, 400);
  } finally { h.close(); }
});

test('REST: список с фильтрами и пагинацией — query-параметры доходят до store', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const op = await loginCookie(h.base);
    for (let i = 0; i < 5; i += 1) {
      await api(h.base, 'POST', '/api/hub/threads', { cookie: op, body: { subject: `Тикет ${i}`, text: `текст ${i}` } });
    }
    const page = await api(h.base, 'GET', '/api/hub/threads?limit=2&offset=1', { cookie: op });
    assert.equal(page.status, 200);
    const body1 = await page.json();
    assert.equal(body1.items.length, 2);
    assert.equal(body1.total, 5);
    const filtered = await api(h.base, 'GET', '/api/hub/threads?q=Тикет%201', { cookie: op });
    const body2 = await filtered.json();
    assert.equal(body2.total, 1);
    assert.equal(body2.items[0].subject, 'Тикет 1');
  } finally { h.close(); }
});

test('REST: детали треда — сообщения в порядке; чужой id — 404', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const op = await loginCookie(h.base);
    const created = await api(h.base, 'POST', '/api/hub/threads', {
      cookie: op, body: { subject: 'Тема', text: 'первое сообщение' },
    });
    const { thread } = await created.json();
    const detail = await api(h.base, 'GET', `/api/hub/threads/${thread.id}`, { cookie: op });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.equal(body.thread.id, thread.id);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].author, 'contact');
    assert.equal((await api(h.base, 'GET', '/api/hub/threads/no-such-id', { cookie: op })).status, 404);
  } finally { h.close(); }
});

test('REST: PATCH треда — статус/assignee(взять себе/снять)/теги; мусор — 400', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const op = await loginCookie(h.base);
    const { thread } = await (await api(h.base, 'POST', '/api/hub/threads', { cookie: op, body: { subject: 'S', text: 'T' } })).json();
    const me = await (await api(h.base, 'GET', '/api/hub/auth/me', { cookie: op })).json();
    const take = await api(h.base, 'PATCH', `/api/hub/threads/${thread.id}`, { cookie: op, body: { assigneeId: me.user.id, status: 'pending' } });
    assert.equal(take.status, 200);
    const after = (await take.json()).thread;
    assert.equal(after.assigneeId, 'u1');
    assert.equal(after.status, 'pending');
    const tags = await api(h.base, 'PATCH', `/api/hub/threads/${thread.id}`, { cookie: op, body: { tags: ['сеть', 'vpn'] } });
    assert.deepEqual((await tags.json()).thread.tags, ['сеть', 'vpn']);
    const bad = await api(h.base, 'PATCH', `/api/hub/threads/${thread.id}`, { cookie: op, body: { status: 'closed' } });
    assert.equal(bad.status, 400);
    const badTags = await api(h.base, 'PATCH', `/api/hub/threads/${thread.id}`, { cookie: op, body: { tags: [123] } });
    assert.equal(badTags.status, 400);
    assert.equal((await api(h.base, 'PATCH', '/api/hub/threads/nope', { cookie: op, body: { status: 'open' } })).status, 404);
  } finally { h.close(); }
});

test('REST: сообщение агента — text и note (type note), тело ≤8000, пустое — 400', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const op = await loginCookie(h.base);
    const { thread } = await (await api(h.base, 'POST', '/api/hub/threads', { cookie: op, body: { subject: 'S', text: 'T' } })).json();
    const r1 = await api(h.base, 'POST', `/api/hub/threads/${thread.id}/messages`, { cookie: op, body: { text: 'Ответ клиенту' } });
    assert.equal(r1.status, 201);
    assert.equal((await r1.json()).message.type, 'text');
    const r2 = await api(h.base, 'POST', `/api/hub/threads/${thread.id}/messages`, { cookie: op, body: { text: 'Внутренняя заметка', note: true } });
    assert.equal(r2.status, 201);
    assert.equal((await r2.json()).message.type, 'note');
    const detail = await (await api(h.base, 'GET', `/api/hub/threads/${thread.id}`, { cookie: op })).json();
    // первое сообщение тикета (contact) + ответ агента + заметка
    assert.deepEqual(detail.messages.map((m) => `${m.author}:${m.type}`), ['contact:text', 'agent:text', 'agent:note']);
    const empty = await api(h.base, 'POST', `/api/hub/threads/${thread.id}/messages`, { cookie: op, body: { text: '   ' } });
    assert.equal(empty.status, 400);
    assert.equal((await api(h.base, 'POST', '/api/hub/threads/nope/messages', { cookie: op, body: { text: 'x' } })).status, 404);
  } finally { h.close(); }
});

test('REST: rating треда — 1..5, мусор — 400, снятие null', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const op = await loginCookie(h.base);
    const { thread } = await (await api(h.base, 'POST', '/api/hub/threads', { cookie: op, body: { subject: 'S', text: 'T' } })).json();
    const rated = await api(h.base, 'POST', `/api/hub/threads/${thread.id}/rating`, { cookie: op, body: { rating: 5 } });
    assert.equal(rated.status, 200);
    const det = await (await api(h.base, 'GET', `/api/hub/threads/${thread.id}`, { cookie: op })).json();
    assert.equal(det.thread.rating, 5);
    const bad = await api(h.base, 'POST', `/api/hub/threads/${thread.id}/rating`, { cookie: op, body: { rating: 9 } });
    assert.equal(bad.status, 400);
    const cleared = await api(h.base, 'POST', `/api/hub/threads/${thread.id}/rating`, { cookie: op, body: { rating: null } });
    assert.equal(cleared.status, 200);
    const det2 = await (await api(h.base, 'GET', `/api/hub/threads/${thread.id}`, { cookie: op })).json();
    assert.equal(det2.thread.rating, null);
  } finally { h.close(); }
});

test('REST: canned — создание/список/удаление; дубликат — 409', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const op = await loginCookie(h.base);
    const me = await (await api(h.base, 'GET', '/api/hub/auth/me', { cookie: op })).json();
    const c1 = await api(h.base, 'POST', '/api/hub/canned', { cookie: op, body: { shortcut: '#hi', text: 'Здравствуйте!', shared: false } });
    assert.equal(c1.status, 201);
    const item1 = (await c1.json()).item;
    assert.equal(item1.shortcut, 'hi');
    assert.equal(item1.agentId, me.user.id);
    const c2 = await api(h.base, 'POST', '/api/hub/canned', { cookie: op, body: { shortcut: 'docs', text: 'Docs', shared: true } });
    assert.equal(c2.status, 201);
    const dup = await api(h.base, 'POST', '/api/hub/canned', { cookie: op, body: { shortcut: 'docs', text: 'дубль', shared: true } });
    assert.equal(dup.status, 409);
    const list = await (await api(h.base, 'GET', '/api/hub/canned', { cookie: op })).json();
    assert.equal(list.items.length, 2);
    const bad = await api(h.base, 'POST', '/api/hub/canned', { cookie: op, body: { shortcut: 'bad shortcut!', text: 'x' } });
    assert.equal(bad.status, 400);
    assert.equal((await api(h.base, 'DELETE', `/api/hub/canned/${item1.id}`, { cookie: op })).status, 200);
    assert.equal((await api(h.base, 'DELETE', `/api/hub/canned/${item1.id}`, { cookie: op })).status, 404);
  } finally { h.close(); }
});

test('REST: presence — PUT своего статуса, GET список, мусор — 400', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const op = await loginCookie(h.base);
    const put = await api(h.base, 'PUT', '/api/hub/presence', { cookie: op, body: { status: 'away' } });
    assert.equal(put.status, 200);
    const list = await (await api(h.base, 'GET', '/api/hub/presence', { cookie: op })).json();
    assert.deepEqual(list.items, [{ agentId: 'u1', status: 'away', updatedAt: list.items[0].updatedAt }]);
    const bad = await api(h.base, 'PUT', '/api/hub/presence', { cookie: op, body: { status: 'invisible' } });
    assert.equal(bad.status, 400);
  } finally { h.close(); }
});

test('REST: раздутый body — 413 (потолок честный и на тикетах)', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const op = await loginCookie(h.base);
    const big = 'x'.repeat(30000);
    const res = await api(h.base, 'POST', '/api/hub/threads', { cookie: op, body: { subject: 'S', text: big } });
    assert.ok([400, 413].includes(res.status), `раздутый текст должен упереться в лимит (получено ${res.status})`);
  } finally { h.close(); }
});

test('REST: мусорный под-путь под /api/hub/* отвечает 404, а не висит', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    for (const p of ['/api/hub/threadsX', '/api/hub/presenceY', '/api/hub/cannedZ', '/api/hub/threads/xx/yy/zz']) {
      const res = await api(h.base, 'GET', p);
      assert.equal(res.status, 404, `${p} должен ответить 404`);
      assert.equal((await res.json()).error.code, 'not_found', `${p}: честная JSON-ошибка`);
    }
  } finally { h.close(); }
});

test('store: type card — тело обязано быть валидным JSON', () => {
  const { store } = freshStore();
  const t = store.createThread({ channel: 'chat', subject: 'x' });
  assert.equal(store.appendMessage(t.id, { author: 'system', type: 'card', body: '{битый json' }), null);
  const card = store.appendMessage(t.id, { author: 'system', type: 'card', body: JSON.stringify({ kind: 'join', token: 't' }) });
  assert.equal(card.type, 'card');
});

test('REST: сообщение type=card — невалидный JSON 400, валидный 201', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const op = await loginCookie(h.base);
    const { thread } = await (await api(h.base, 'POST', '/api/hub/threads', { cookie: op, body: { subject: 'S', text: 'T' } })).json();
    const bad = await api(h.base, 'POST', `/api/hub/threads/${thread.id}/messages`, { cookie: op, body: { text: '{не json', type: 'card' } });
    assert.equal(bad.status, 400);
    const good = await api(h.base, 'POST', `/api/hub/threads/${thread.id}/messages`, { cookie: op, body: { text: '{"kind":"join"}', type: 'card' } });
    assert.equal(good.status, 201);
    assert.equal((await good.json()).message.type, 'card');
  } finally { h.close(); }
});

test('REST: мусорные limit/offset не роняют список — кламп живёт в store', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const op = await loginCookie(h.base);
    for (let i = 0; i < 5; i += 1) {
      await api(h.base, 'POST', '/api/hub/threads', { cookie: op, body: { subject: `Тикет ${i}`, text: `текст ${i}` } });
    }
    const junk = await api(h.base, 'GET', '/api/hub/threads?limit=abc&offset=-5', { cookie: op });
    assert.equal(junk.status, 200);
    assert.equal((await junk.json()).items.length, 5, 'мусорная пагинация — дефолты store (50/0)');
    const clamped = await api(h.base, 'GET', '/api/hub/threads?limit=1000&offset=0', { cookie: op });
    assert.equal((await clamped.json()).items.length, 5, 'limit зажимается до 100 в store');
  } finally { h.close(); }
});

// ---- UI-контракты консоли (по образцу client/test/web-operator.test.mjs) ----

import { readFileSync } from 'node:fs';
import path from 'node:path';
import ruDict from '../../client/locales/ru.mjs';
import enDict from '../../client/locales/en.mjs';

const webDir = path.join(import.meta.dirname, '..', 'web');
const consoleHtmlText = readFileSync(path.join(webDir, 'index.html'), 'utf8');
const consoleJs = readFileSync(path.join(webDir, 'app.mjs'), 'utf8');

test('UI: каждый data-i18n*/data-i18n-placeholder ключ есть в словарях ru и en', () => {
  const keys = [
    ...consoleHtmlText.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g),
  ].map((m) => m[1]);
  assert.ok(keys.length > 30, `статические тексты консоли помечены data-i18n (найдено ${keys.length})`);
  for (const key of new Set(keys)) {
    assert.ok(key in ruDict, `ключ «${key}» отсутствует в ru`);
    assert.ok(key in enDict, `ключ «${key}» отсутствует в en`);
  }
});

test('UI: ключи t() в app.mjs существуют в обоих словарях', () => {
  for (const m of consoleJs.matchAll(/\bt\('([^']+)'/g)) {
    assert.ok(m[1] in ruDict, `t('${m[1]}') — нет в ru`);
    assert.ok(m[1] in enDict, `t('${m[1]}') — нет в en`);
  }
});

test('UI: все id из app.mjs есть в разметке', () => {
  const htmlIds = new Set([...consoleHtmlText.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = [...consoleJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(referenced.length > 30, `консоль работает через $(id) (найдено ${referenced.length})`);
  for (const id of new Set(referenced)) {
    assert.ok(htmlIds.has(id), `id «${id}» отсутствует в hub/web/index.html`);
  }
});

test('UI: анти-мёртвые-кнопки — каждая кнопка разметки подключена в app.mjs', () => {
  const buttons = [...consoleHtmlText.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(buttons.length >= 10, `живая панель кнопок (найдено ${buttons.length})`);
  for (const id of buttons) {
    const wired = new RegExp(`\\$\\('${id}'\\)`).test(consoleJs);
    assert.ok(wired, `кнопка «${id}» есть в HTML, но не подключена в app.mjs`);
  }
});

test('UI: кириллических литералов в app.mjs нет — только словарь', () => {
  const cyr = /[\u0400-\u04FF]/;
  for (const lit of consoleJs.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []) {
    assert.ok(!cyr.test(lit), `кириллический литерал в app.mjs: ${lit.slice(0, 60)}`);
  }
});

test('UI: без inline-стилей, ровно один модульный скрипт /hub/app.mjs', () => {
  assert.ok(!/\sstyle="/.test(consoleHtmlText), 'найден inline style');
  const scripts = [...consoleHtmlText.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'подключается один модуль страницы');
  assert.match(scripts[0], /type="module" src="\/hub\/app\.mjs"/);
});

test('UI: каркас честный — консоль/ presence/новый тикет скрыты до авторизации, логин показывается сервером', () => {
  for (const id of ['hub-console', 'hub-presence-box', 'hub-new-ticket-btn', 'hub-login', 'hub-forbidden', 'hub-logout', 'hub-user']) {
    const tag = new RegExp(`id="${id}"[^>]*`).exec(consoleHtmlText)?.[0] ?? '';
    assert.match(tag, /class="[^"]*\bhidden\b/, `«${id}» должен быть скрыт в разметке — вид выбирают сервер и JS`);
  }
});

test('UI: инбокс держит фильтры, пагинацию и пустые состояния; детали — canned-попап и заметки', () => {
  for (const id of [
    'hub-f-status', 'hub-f-channel', 'hub-f-tag', 'hub-f-search', 'hub-f-reset',
    'hub-list', 'hub-list-empty', 'hub-list-error', 'hub-page-prev', 'hub-page-next', 'hub-page-info',
    'hub-thread-subject', 'hub-st-open', 'hub-st-pending', 'hub-st-resolved', 'hub-thread-take',
    'hub-thread-taglist', 'hub-tag-input', 'hub-msgs', 'hub-thread-error',
    'hub-canned-pop', 'hub-reply', 'hub-reply-send', 'hub-reply-note', 'hub-canned-save',
    'hub-new-subject', 'hub-new-text', 'hub-new-name', 'hub-new-email', 'hub-new-error', 'hub-new-submit', 'hub-new-cancel',
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(consoleHtmlText), `нет id «${id}»`);
  }
  // canned-автодополнение реально слушает ввод ответа
  assert.match(consoleJs, /cannedToken\(/, 'в app.mjs есть разбор #шортката');
  assert.match(consoleJs, /\$\('hub-reply'\)\.addEventListener\('input'/, 'попап обновляется по вводу');
  assert.match(consoleJs, /hub\.msg\.noteBadge/, 'заметки помечаются бейджем');
  // пустые состояния честные и различаются: пусто vs ничего по фильтрам
  assert.match(consoleJs, /hub\.inbox\.empty'/);
  assert.match(consoleJs, /hub\.inbox\.emptyFiltered'/);
});

test('UI: словари — новые ключи консоли паритетны (hub.*)', () => {
  const hubKeys = (dict) => Object.keys(dict).filter((k) => k.startsWith('hub.'));
  assert.deepEqual(hubKeys(ruDict).sort(), hubKeys(enDict).sort());
  assert.ok(hubKeys(ruDict).length > 60, `ключей hub.* достаточно (${hubKeys(ruDict).length})`);
});
