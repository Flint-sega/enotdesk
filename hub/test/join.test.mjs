import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import crypto from 'node:crypto';
import { createHub } from '../app.mjs';
import { openHubDb } from '../db.mjs';
import { createJoinStore, JOIN_TTL_MS } from '../join.mjs';
import { createSettingsStore } from '../settings.mjs';
import { safeCardHref } from '../web/card-url.mjs';
import ruDict from '../../client/locales/ru.mjs';
import enDict from '../../client/locales/en.mjs';

// T05: join-токены one-click. Швы — store (одноразовость/TTL/связь sessionId)
// и createHub HTTP (фейк-EnotDesk через enotFetch): карточка, репорт, авто-claim,
// webhooks → system-сообщения, /join-страница, контракты UI.

function freshStore(tickStart = Date.parse('2026-01-01T00:00:00Z')) {
  const db = openHubDb(':memory:');
  let tick = tickStart;
  const store = createJoinStore(db, { nowMs: () => (tick += 1000) });
  db.prepare(`INSERT INTO threads (id, channel, status, subject, tags, last_activity_at, created_at, updated_at)
              VALUES ('th1','chat','open','Тема','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  return { db, store, threadId: 'th1' };
}

test('store: create — токен в диапазоне парсера клиента, TTL по умолчанию 10 минут', () => {
  const db = openHubDb(':memory:');
  const at = Date.parse('2026-01-01T00:00:00Z');
  db.prepare(`INSERT INTO threads (id, channel, status, subject, tags, last_activity_at, created_at, updated_at)
              VALUES ('th1','chat','open','Тема','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  const store = createJoinStore(db, { nowMs: () => at }); // замороженные часы
  const t = store.create({ threadId: 'th1', agentId: 'u1' });
  assert.match(t.token, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(new Date(t.expiresAt).getTime() - at, JOIN_TTL_MS);
});

test('store: consume одноразовый — второй раз gone, неизвестный — null', () => {
  const { store, threadId } = freshStore();
  const { token } = store.create({ threadId, agentId: 'u1' });
  const used = store.consume(token);
  assert.equal(used.threadId, threadId);
  assert.equal(used.agentId, 'u1');
  assert.match(used.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(store.consume(token), 'gone');
  assert.equal(store.consume('A'.repeat(32)), null);
});

test('store: истёкший токен — consume gone (не success), peek не показывает', () => {
  const { store, threadId } = freshStore();
  const { token } = store.create({ threadId, agentId: 'u1', ttlMs: 500 });
  assert.equal(store.consume(token), 'gone');
  assert.equal(store.peek(token), null);
});

test('store: create в несуществующий тред — null', () => {
  const { store } = freshStore();
  assert.equal(store.create({ threadId: 'nope', agentId: 'u1' }), null);
});

test('store: linkSession + threadIdForSession — связь тред↔сеанс для webhooks', () => {
  const { store, threadId } = freshStore();
  const { tokenHash } = store.consume(store.create({ threadId, agentId: 'u1' }).token);
  assert.equal(store.threadIdForSession('123456789'), null);
  store.linkSession(tokenHash, '123456789');
  assert.equal(store.threadIdForSession('123456789'), threadId);
  assert.equal(store.threadIdForSession('000000001'), null);
});

test('store: ленивая чистка — истёкшие старше суток удаляются при create', () => {
  const { db, store, threadId } = freshStore();
  const first = store.create({ threadId, agentId: 'u1', ttlMs: 5000 });
  const tokenHash = store.consume(first.token).tokenHash;
  // уехали на 25 часов вперёд
  const late = createJoinStore(db, { nowMs: () => Date.parse('2026-01-02T01:00:00Z') });
  late.create({ threadId, agentId: 'u1' });
  assert.equal(db.prepare('SELECT count(*) c FROM hub_join_tokens WHERE token_hash = ?').get(tokenHash).c, 0);
});

// ---- HTTP: createHub + фейк-EnotDesk ----

function fakeEnotDesk(overrides = {}) {
  const state = { role: 'operator', claimStatus: 201, claimThrow: false, ...overrides };
  const calls = [];
  const user = () => ({ id: 'u1', login: 'op', name: 'Оператор', role: state.role, active: true });
  const enotFetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, opts, body: opts.body ? JSON.parse(opts.body) : null });
    if (path === '/api/v1/auth/login') {
      return Response.json({ token: `upstream-token-${calls.length}`, user: user(), expiresAt: '2030-01-01T00:00:00.000Z' });
    }
    if (path === '/api/v1/auth/me') return Response.json({ user: user() });
    if (path === '/api/v1/auth/logout') return Response.json({ ok: true });
    if (path === '/api/v1/health') return Response.json({ ok: true });
    if (/^\/api\/v1\/sessions\/\d{9}\/claim$/.test(path)) {
      if (state.claimThrow) throw new Error('connection refused');
      if (state.claimStatus !== 201) return Response.json({ error: { code: state.claimCode ?? 'bad_request', message: 'upstream' } }, { status: state.claimStatus });
      return Response.json({ sessionId: path.split('/')[4], claimId: 'c1', state: 'pending-consent' }, { status: 201 });
    }
    return new Response(null, { status: 404 });
  };
  return { enotFetch, calls, state };
}

async function startHub({ enotFetch, ...extra } = {}) {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'enotdesk-hub-join-'));
  const inst = createHub({
    dbPath: pathJoin(dir, 'hub.db'),
    port: 0,
    enotdeskUrl: 'http://enot.test',
    publicUrl: 'http://hub.example',
    enotFetch,
    ...extra,
  });
  const port = await inst.start();
  return { inst, base: `http://127.0.0.1:${port}`, db: inst.db, close: () => inst.close() };
}

async function loginCookie(base, role = 'operator') {
  const res = await fetch(`${base}/api/hub/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'op', password: 'pw' }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  void role;
  return res.headers.getSetCookie().find((c) => c.startsWith('enot_hub_sid=')).split(';')[0];
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
  return { status: res.status, body: json };
}

async function makeThread(base, cookie, subject = 'Не запускается программа') {
  const r = await api(base, 'POST', '/api/hub/threads', { cookie, body: { subject, text: 'Помогите' } });
  assert.equal(r.status, 201);
  return r.body.thread.id;
}

const expected = (key, vars = {}) => Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), ruDict[key]);

test('сквозной цикл (история 10): оператор жмёт → токен → карточка → репорт клиента → авто-claim → system-сообщение', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const cookie = await loginCookie(h.base);
    const threadId = await makeThread(h.base, cookie);
    const created = await api(h.base, 'POST', `/api/hub/threads/${threadId}/join`, { cookie });
    assert.equal(created.status, 201);
    assert.match(created.body.token, /^[A-Za-z0-9_-]{16,128}$/);
    assert.equal(created.body.url, `enotdesk://join?server=${encodeURIComponent('http://hub.example')}&t=${created.body.token}`);
    assert.equal(created.body.joinPage, `http://hub.example/join?t=${encodeURIComponent(created.body.token)}`);
    // карточка в треде: валидный JSON, kind/state честные
    const card = created.body.message;
    assert.equal(card.type, 'card');
    const parsed = JSON.parse(card.body);
    assert.equal(parsed.kind, 'remote-offer');
    assert.equal(parsed.state, 'pending');
    assert.equal(parsed.url, created.body.url);
    assert.equal(parsed.joinPage, created.body.joinPage);
    // репорт клиента — БЕЗ cookie: одноразовый токен сам credential
    const report = await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, {
      body: { sessionId: '123456789', password: 'ses-pw' },
    });
    assert.equal(report.status, 200);
    assert.deepEqual(report.body, { ok: true, claimed: true, sessionId: '123456789' });
    // авто-claim ушёл в EnotDesk с bearer'ом агента, создавшего токен
    const claim = f.calls.find((c) => c.path === '/api/v1/sessions/123456789/claim');
    assert.ok(claim, 'claim не отправлен в EnotDesk');
    assert.equal(claim.body.password, 'ses-pw'); // только password, hostToken не участвует
    assert.match(claim.opts.headers.authorization, /^Bearer upstream-token-\d+$/);
    assert.notEqual(claim.opts.headers.authorization, `Bearer ${created.body.token}`);
    // system-сообщение в треде с точным текстом
    const detail = await api(h.base, 'GET', `/api/hub/threads/${threadId}`, { cookie });
    const system = detail.body.messages.filter((m) => m.author === 'system');
    assert.deepEqual(system.map((m) => m.body), [expected('hub.join.systemClaimed', { id: '123456789' })]);
    // повторный репорт по consumed-токену — честный 410
    const again = await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, {
      body: { sessionId: '123456789', password: 'ses-pw' },
    });
    assert.equal(again.status, 410);
    assert.equal(again.body.error.code, 'gone');
  } finally {
    await h.close();
  }
});

test('авто-claim отклонён — в тред уходит честная причина, ответ claimed:false', async () => {
  const f = fakeEnotDesk({ claimStatus: 400, claimCode: 'bad_request' });
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const cookie = await loginCookie(h.base);
    const threadId = await makeThread(h.base, cookie);
    const created = await api(h.base, 'POST', `/api/hub/threads/${threadId}/join`, { cookie });
    const report = await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, {
      body: { sessionId: '999999999', password: 'wrong' },
    });
    assert.equal(report.status, 200);
    assert.equal(report.body.claimed, false);
    assert.equal(report.body.reason, 'bad_request'); // в ответе машинный код
    const detail = await api(h.base, 'GET', `/api/hub/threads/${threadId}`, { cookie });
    assert.deepEqual(
      detail.body.messages.filter((m) => m.author === 'system').map((m) => m.body),
      [expected('hub.join.systemFailed', { id: '999999999', reason: ruDict['hub.join.reason.bad_request'] })],
    );
  } finally {
    await h.close();
  }
});

test('EnotDesk мёртв — таймаут/сеть дают honest enotdesk_unavailable в треде', async () => {
  const f = fakeEnotDesk({ claimThrow: true });
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const cookie = await loginCookie(h.base);
    const threadId = await makeThread(h.base, cookie);
    const created = await api(h.base, 'POST', `/api/hub/threads/${threadId}/join`, { cookie });
    const report = await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, {
      body: { sessionId: '888888888', password: 'pw' },
    });
    assert.equal(report.status, 200);
    assert.equal(report.body.claimed, false);
    assert.equal(report.body.reason, 'enotdesk_unavailable');
    const detail = await api(h.base, 'GET', `/api/hub/threads/${threadId}`, { cookie });
    assert.ok(detail.body.messages.some((m) => m.body.includes(ruDict['hub.join.reason.enotdesk_unavailable'])));
  } finally {
    await h.close();
  }
});

test('репорт: некорректное тело — 400 и токен не сгорает; неизвестный токен — 404', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const cookie = await loginCookie(h.base);
    const threadId = await makeThread(h.base, cookie);
    const created = await api(h.base, 'POST', `/api/hub/threads/${threadId}/join`, { cookie });
    const bad1 = await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, { body: { sessionId: '12345', password: 'pw' } });
    const bad2 = await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, { body: { sessionId: '123456789', password: 'x'.repeat(65) } });
    const bad3 = await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, { body: { sessionId: '123456789' } });
    for (const bad of [bad1, bad2, bad3]) {
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, 'bad_request');
    }
    const good = await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, { body: { sessionId: '123456789', password: 'pw' } });
    assert.equal(good.status, 200);
    const missing = await api(h.base, 'POST', `/api/hub/join/${'Z'.repeat(32)}/report`, { body: { sessionId: '123456789', password: 'pw' } });
    assert.equal(missing.status, 404);
  } finally {
    await h.close();
  }
});

test('RBAC: создание токена — только operator/admin (аноним 401, auditor 403)', async () => {
  const h = await startHub({ enotFetch: fakeEnotDesk({ role: 'auditor' }).enotFetch });
  try {
    const anon = await api(h.base, 'POST', '/api/hub/threads/nope/join', { body: {} });
    assert.equal(anon.status, 401);
    const cookie = await loginCookie(h.base);
    const denied = await api(h.base, 'POST', '/api/hub/threads/nope/join', { cookie });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'forbidden');
  } finally {
    await h.close();
  }
});

test('/join-страница: с живым токеном — кнопки протокола и скачивания; без/после consume — 404', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const cookie = await loginCookie(h.base);
    const threadId = await makeThread(h.base, cookie);
    const created = await api(h.base, 'POST', `/api/hub/threads/${threadId}/join`, { cookie });
    const page = await fetch(`${h.base}/join?t=${encodeURIComponent(created.body.token)}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="join-start"/);
    // esc() кодирует & в атрибуте href — сравниваем с экранированной формой
    assert.ok(html.includes(`href="${created.body.url.replace('&t=', '&amp;t=')}"`), 'кнопка протокола ведёт на enotdesk://join');
    assert.ok(html.includes('href="http://hub.example/downloads"'), 'кнопка скачивания ведёт на /downloads сервера');
    const noToken = await fetch(`${h.base}/join`);
    assert.equal(noToken.status, 404);
    await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, { body: { sessionId: '123456789', password: 'pw' } });
    const used = await fetch(`${h.base}/join?t=${encodeURIComponent(created.body.token)}`);
    assert.equal(used.status, 404);
  } finally {
    await h.close();
  }
});

test('webhook-секрет: operator — 403, admin — стабильный секрет из настроек', async () => {
  const f = fakeEnotDesk();
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const cookie = await loginCookie(h.base); // operator
    const denied = await api(h.base, 'GET', '/api/hub/settings/webhook', { cookie });
    assert.equal(denied.status, 403);
  } finally {
    await h.close();
  }
  const h2 = await startHub({ enotFetch: fakeEnotDesk({ role: 'admin' }).enotFetch });
  try {
    const adminCookie = await loginCookie(h2.base);
    const got = await api(h2.base, 'GET', '/api/hub/settings/webhook', { cookie: adminCookie });
    assert.equal(got.status, 200);
    assert.match(got.body.secret, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(got.body.rotated, false, 'обычный GET — без ротации');
    const again = await api(h2.base, 'GET', '/api/hub/settings/webhook', { cookie: adminCookie });
    assert.equal(again.body.secret, got.body.secret); // стабилен между запросами
    assert.equal(again.body.rotated, false);
  } finally {
    await h2.close();
  }
});

function hookSign(secret, raw) {
  return crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
}

test('settings: ротация ENOT_SECRET_KEY — ensureWebhookSecret честно репортит rotated', () => {
  const db = openHubDb(':memory:');
  const first = createSettingsStore(db, { secretKey: 'key-a' }).ensureWebhookSecret();
  assert.equal(first.rotated, false, 'первое создание — не ротация');
  const same = createSettingsStore(db, { secretKey: 'key-a' }).ensureWebhookSecret();
  assert.equal(same.rotated, false);
  assert.equal(same.secret, first.secret);
  const afterKeyChange = createSettingsStore(db, { secretKey: 'key-b' }).ensureWebhookSecret();
  assert.equal(afterKeyChange.rotated, true, 'сменён ключ — админ должен увидеть ротацию');
  assert.notEqual(afterKeyChange.secret, first.secret);
  assert.match(afterKeyChange.secret, /^[A-Za-z0-9_-]{20,}$/);
});

test('safeCardHref: только enotdesk:/https: — javascript:/data:/http: и мусор отброшены', () => {
  const okProtocol = 'enotdesk://join?server=https%3A%2F%2Fhub.example&t=AbC-_123';
  assert.equal(safeCardHref(okProtocol, 'enotdesk:'), okProtocol);
  assert.equal(safeCardHref('javascript:alert(1)', 'enotdesk:'), null);
  assert.equal(safeCardHref('data:text/html,<b>x</b>', 'enotdesk:'), null);
  assert.equal(safeCardHref('http://hub.example/join', 'enotdesk:'), null);
  assert.equal(safeCardHref('https://hub.example/join', 'https:'), 'https://hub.example/join');
  assert.equal(safeCardHref('http://hub.example/join', 'https:'), null);
  assert.equal(safeCardHref('javascript:alert(1)', 'https:'), null);
  assert.equal(safeCardHref('', 'https:'), null);
  assert.equal(safeCardHref(undefined, 'https:'), null);
  assert.equal(safeCardHref('x'.repeat(2049), 'enotdesk:'), null);
});

test('system-сообщения треда — всегда на языке продукта (ru), независимо от Accept-Language', async () => {
  const f = fakeEnotDesk({ role: 'admin' });
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const cookie = await loginCookie(h.base);
    const threadId = await makeThread(h.base, cookie);
    const created = await api(h.base, 'POST', `/api/hub/threads/${threadId}/join`, { cookie });
    // репорт клиента с en-локалью — сообщение в треде всё равно ru
    await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, {
      body: { sessionId: '444444444', password: 'pw' },
      headers: { 'accept-language': 'en' },
    });
    const secret = (await api(h.base, 'GET', '/api/hub/settings/webhook', { cookie })).body.secret;
    const raw = JSON.stringify({ event: 'session.ended', payload: { sessionId: '444444444', reason: 'client' } });
    // webhook (сервер EnotDesk) тоже с en-заголовком — строка остаётся ru
    await api(h.base, 'POST', '/hooks/enotdesk', {
      body: JSON.parse(raw),
      headers: { 'accept-language': 'en', 'x-enot-signature': hookSign(secret, raw) },
    });
    const detail = await api(h.base, 'GET', `/api/hub/threads/${threadId}`, { cookie });
    assert.deepEqual(
      detail.body.messages.filter((m) => m.author === 'system').map((m) => m.body),
      [
        expected('hub.join.systemClaimed', { id: '444444444' }),
        expected('hub.join.systemEndedReason', { id: '444444444', reason: 'client' }),
      ],
    );
  } finally {
    await h.close();
  }
});

test('webhooks: session.started/ended с верной подписью падают system-строками в связанный тред', async () => {
  const f = fakeEnotDesk({ role: 'admin' });
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const cookie = await loginCookie(h.base);
    const threadId = await makeThread(h.base, cookie);
    const created = await api(h.base, 'POST', `/api/hub/threads/${threadId}/join`, { cookie });
    await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, { body: { sessionId: '777777777', password: 'pw' } });
    const secret = (await api(h.base, 'GET', '/api/hub/settings/webhook', { cookie })).body.secret;
    assert.ok(secret, 'секрет не получен');
    const post = async (payload) => {
      const raw = JSON.stringify(payload);
      return api(h.base, 'POST', '/hooks/enotdesk', {
        body: payload,
        headers: { 'x-enot-signature': hookSign(secret, raw) },
      });
    };
    const started = await post({ event: 'session.started', payload: { sessionId: '777777777' }, ts: '2026-01-01T00:00:00.000Z' });
    assert.equal(started.status, 200);
    const ended = await post({ event: 'session.ended', payload: { sessionId: '777777777', reason: 'operator' }, ts: '2026-01-01T00:01:00.000Z' });
    assert.equal(ended.status, 200);
    const detail = await api(h.base, 'GET', `/api/hub/threads/${threadId}`, { cookie });
    const system = detail.body.messages.filter((m) => m.author === 'system').map((m) => m.body);
    assert.deepEqual(system, [
      expected('hub.join.systemClaimed', { id: '777777777' }),
      expected('hub.join.systemStarted', { id: '777777777' }),
      expected('hub.join.systemEndedReason', { id: '777777777', reason: 'operator' }),
    ]);
  } finally {
    await h.close();
  }
});

test('webhooks: неверная подпись — 401 без записи; неизвестный sessionId/событие — тихий игнор', async () => {
  const f = fakeEnotDesk({ role: 'admin' });
  const h = await startHub({ enotFetch: f.enotFetch });
  try {
    const cookie = await loginCookie(h.base);
    const threadId = await makeThread(h.base, cookie);
    const created = await api(h.base, 'POST', `/api/hub/threads/${threadId}/join`, { cookie });
    await api(h.base, 'POST', `/api/hub/join/${created.body.token}/report`, { body: { sessionId: '666666666', password: 'pw' } });
    const secret = (await api(h.base, 'GET', '/api/hub/settings/webhook', { cookie })).body.secret;
    const rawBad = JSON.stringify({ event: 'session.started', payload: { sessionId: '666666666' } });
    const bad = await api(h.base, 'POST', '/hooks/enotdesk', {
      body: JSON.parse(rawBad),
      headers: { 'x-enot-signature': '0'.repeat(64) },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'bad_signature');
    const rawUnknown = JSON.stringify({ event: 'session.started', payload: { sessionId: '555555555' } });
    const unknown = await api(h.base, 'POST', '/hooks/enotdesk', {
      body: JSON.parse(rawUnknown),
      headers: { 'x-enot-signature': hookSign(secret, rawUnknown) },
    });
    assert.equal(unknown.status, 200);
    const rawOther = JSON.stringify({ event: 'machine.claim.denied', payload: { machineId: 'm1' } });
    const other = await api(h.base, 'POST', '/hooks/enotdesk', {
      body: JSON.parse(rawOther),
      headers: { 'x-enot-signature': hookSign(secret, rawOther) },
    });
    assert.equal(other.status, 200);
    const detail = await api(h.base, 'GET', `/api/hub/threads/${threadId}`, { cookie });
    assert.deepEqual(
      detail.body.messages.filter((m) => m.author === 'system').map((m) => m.body),
      [expected('hub.join.systemClaimed', { id: '666666666' })],
    );
  } finally {
    await h.close();
  }
});

// ---- контракты UI и словарей ----

test('UI-контракты: кнопка в консоли, card-рендер виджета, секрет в настройках, паритет словарей', () => {
  const root = pathJoin(import.meta.dirname, '..');
  const indexHtml = readFileSync(pathJoin(root, 'web', 'index.html'), 'utf8');
  assert.match(indexHtml, /id="hub-join-btn"[^>]*data-i18n="hub\.join\.btn"/);
  assert.match(indexHtml, /id="hub-webhook-secret"/);
  assert.match(indexHtml, /id="hub-webhook-copy"/);
  const webApp = readFileSync(pathJoin(root, 'web', 'app.mjs'), 'utf8');
  assert.ok(webApp.includes("'hub-join-btn'"), 'кнопка подключена статически (анти-мёртвая)');
  assert.ok(webApp.includes('/join`'), 'кнопка зовёт POST /threads/:id/join');
  assert.ok(webApp.includes("'remote-offer'"), 'консоль рендерит карточку remote-offer');
  assert.ok(webApp.includes('safeCardHref'), 'консоль валидирует href карточки');
  assert.ok(webApp.includes("'hub-webhook-copy'"), 'копирование секрета подключено');
  const widget = readFileSync(pathJoin(root, 'widget', 'w.mjs'), 'utf8');
  assert.ok(widget.includes("'remote-offer'"), 'виджет распознаёт карточку remote-offer');
  assert.ok(widget.includes('safeCardHref'), 'виджет валидирует href карточки');
  for (const id of ['w-card-start', 'w-card-download', 'w-card-hint']) {
    assert.ok(widget.includes(`'${id}'`) || widget.includes(`"${id}"`), `нет id ${id}`);
  }
  for (const key of ['widget.join.start', 'widget.join.download', 'widget.join.hint']) {
    assert.ok(widget.includes(`'${key}'`), `виджет не использует ${key}`);
  }
  const joinHtml = readFileSync(pathJoin(root, 'pages.mjs'), 'utf8');
  assert.match(joinHtml, /id="join-start"/);
  assert.match(joinHtml, /id="join-download"/);
  // паритет новых ключей в словарях (общий паритет проверяет контракт-тест клиента)
  const newKeys = Object.keys(ruDict).filter((k) => k.startsWith('hub.join.') || k.startsWith('hub.webhook.') || k.startsWith('widget.join.'));
  assert.ok(newKeys.length >= 26, `новых ключей меньше ожидаемого: ${newKeys.length}`);
  for (const key of newKeys) {
    assert.ok(key in enDict, `нет ключа ${key} в en`);
    assert.ok(typeof enDict[key] === 'string' && enDict[key], `пустое значение ${key} в en`);
  }
});
