import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createWebhooks, WEBHOOK_EVENTS } from '../webhooks.mjs';
import { openDb } from '../db.mjs';
import { startServer, api, adminLogin, tmpDb } from './util.mjs';

// ---- createWebhooks: подпись, ретраи, фильтр, шифрование секрета ----
// Фейк-fetch, без сети. Эталон подписи посчитан вручную (node:crypto по спеке),
// не кодом модуля: body = {"event":"session.started","payload":{"sessionId":"42"},
// "ts":"2026-01-02T03:04:05.678Z"}, secret = "секрет-webhook-123".
const FIXED_MS = 1767323045678; // 2026-01-02T03:04:05.678Z
const EXPECTED_BODY = '{"event":"session.started","payload":{"sessionId":"42"},"ts":"2026-01-02T03:04:05.678Z"}';
const EXPECTED_SIG = 'e125da223feae3950b41be3aaf61ced1db50fb4358927a6760d8b5916ec5aa91';
const SECRET = 'секрет-webhook-123';
const TEST_KEY = 'ключ-webhooks-тестов-0123456789abcdef';
const OTHER_KEY = 'чужой-ключ-ротации-9876543210fedcba';

test('подпись: известное тело подписывается точной hex-подписью X-Enot-Signature', async () => {
  const db = openDb(':memory:');
  const calls = [];
  const wh = createWebhooks(db, {
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true }; },
    nowMs: () => FIXED_MS,
    secretKey: TEST_KEY,
  });
  assert.deepEqual(WEBHOOK_EVENTS, ['session.started', 'session.ended', 'machine.claim.denied']);

  assert.equal(wh.configure('http://127.0.0.1:9/hook', SECRET).ok, true);
  await wh.emit('session.started', { sessionId: '42' });

  assert.equal(calls.length, 1, 'доставка — один POST без ретраев при успехе');
  assert.equal(calls[0].url, 'http://127.0.0.1:9/hook');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.body, EXPECTED_BODY, 'тело — {event, payload, ts} с фиксированным ts');
  assert.equal(calls[0].opts.headers['X-Enot-Signature'], EXPECTED_SIG, 'подпись совпала с эталоном');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  db.close();
});

test('ретраи: постоянный сбой — 3 ретрая, потом drop (итого 4 попытки)', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const wh = createWebhooks(db, {
    fetchImpl: async () => { calls += 1; return { ok: false }; },
    retryDelays: [1, 1, 1],
    secretKey: TEST_KEY,
  });
  wh.configure('http://127.0.0.1:9/hook', SECRET);
  const delivered = await wh.emit('session.ended', { sessionId: 's1' });
  assert.equal(calls, 4, 'первая попытка + 3 ретрая');
  assert.equal(delivered, false, 'после всех ретраев событие брошено');
  db.close();
});

test('ретраи: разовый сбой сети (throw) — вторая попытка доставляет', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const wh = createWebhooks(db, {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return { ok: true };
    },
    retryDelays: [1, 1, 1],
    secretKey: TEST_KEY,
  });
  wh.configure('http://127.0.0.1:9/hook', SECRET);
  assert.equal(await wh.emit('session.started', {}), true);
  assert.equal(calls, 2);
  db.close();
});

test('фильтр: событие вне списка не доставляется, пустой список — все события', async () => {
  const db = openDb(':memory:');
  const calls = [];
  const wh = createWebhooks(db, { fetchImpl: async () => { calls.push(1); return { ok: true }; }, secretKey: TEST_KEY });
  wh.configure('http://127.0.0.1:9/hook', SECRET, ['session.started']);

  await wh.emit('session.ended', {});
  await wh.emit('machine.claim.denied', {});
  assert.equal(calls.length, 0, 'отфильтрованные события не уходят');
  await wh.emit('session.started', {});
  assert.equal(calls.length, 1, 'разрешённое событие доставлено');

  wh.configure('http://127.0.0.1:9/hook', SECRET); // без списка — все события
  await wh.emit('machine.claim.denied', {});
  assert.equal(calls.length, 2);
  db.close();
});

test('выключение: пустой url гасит доставку; не настроенные webhooks молчат', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const wh = createWebhooks(db, { fetchImpl: async () => { calls += 1; return { ok: true }; }, secretKey: TEST_KEY });
  await wh.emit('session.started', {});
  assert.equal(calls, 0, 'без настроек доставки нет');

  wh.configure('http://127.0.0.1:9/hook', SECRET);
  await wh.emit('session.started', {});
  assert.equal(calls, 1);

  const off = wh.configure('', '');
  assert.equal(off.ok, true);
  assert.equal(off.configured, false);
  await wh.emit('session.started', {});
  assert.equal(calls, 1, 'после выключения доставки нет');
  assert.equal(wh.get().configured, false);
  db.close();
});

test('настройка: не-http URL и пустой секрет отклоняются; events чистятся по allowlist', () => {
  const db = openDb(':memory:');
  const wh = createWebhooks(db, { secretKey: TEST_KEY });
  assert.equal(wh.configure('ftp://example.com/hook', SECRET).ok, false);
  assert.equal(wh.configure('не-адрес', SECRET).ok, false);
  assert.equal(wh.configure('http://example.com/hook', '').ok, false, 'без секрета подписывать нечем');
  const ok = wh.configure('http://example.com/hook', SECRET, ['session.started', 'чужое.событие', 'session.started']);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.events, ['session.started'], 'неизвестные события отброшены, дубликаты сняты');
  db.close();
});

test('шифрование: в БД v1-шифтекст, а подпись после расшифровки сходится с секретом', async () => {
  const db = openDb(':memory:');
  const calls = [];
  const wh = createWebhooks(db, {
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true }; },
    nowMs: () => FIXED_MS,
    secretKey: TEST_KEY,
  });
  assert.equal(wh.configure('http://127.0.0.1:9/hook', SECRET).ok, true);

  // в БД лежит шифротекст, открытого секрета там нет
  const stored = db.prepare('SELECT secret FROM webhook_settings WHERE id = 1').get();
  assert.ok(stored.secret.startsWith('v1:'), 'секрет хранится шифрованным (формат v1:)');
  assert.ok(!stored.secret.includes(SECRET), 'открытого секрета в БД нет');

  // round-trip: расшифрованный секрет подписывает так же, как исходный
  await wh.emit('session.started', { sessionId: '42' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.body, EXPECTED_BODY);
  const expected = crypto.createHmac('sha256', SECRET).update(calls[0].opts.body, 'utf8').digest('hex');
  assert.equal(calls[0].opts.headers['X-Enot-Signature'], expected, 'round-trip шифрования прозрачен для подписи');
  db.close();
});

test('шифрование: старая строка с plaintext-секретом читается, подпись корректна', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO webhook_settings (id, url, secret, events) VALUES (1, 'http://127.0.0.1:9/hook', ?, '[]')")
    .run(SECRET); // значение, записанное до введения шифрования
  const calls = [];
  // ключ даже не задан: legacy-plaintext читается как есть (decryptSecret)
  const wh = createWebhooks(db, {
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true }; },
    nowMs: () => FIXED_MS,
    secretKey: '',
  });
  await wh.emit('session.started', { sessionId: '42' });
  assert.equal(calls.length, 1, 'легаси-строка не падает и доставляется');
  assert.equal(calls[0].opts.body, EXPECTED_BODY);
  const expected = crypto.createHmac('sha256', SECRET).update(calls[0].opts.body, 'utf8').digest('hex');
  assert.equal(calls[0].opts.headers['X-Enot-Signature'], expected);
  db.close();
});

test('шифрование: чужой ключ — доставка честно отказывает; переконфигурация новым ключом чинит', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const fetchOk = async () => { calls += 1; return { ok: true }; };
  createWebhooks(db, { fetchImpl: fetchOk, secretKey: TEST_KEY })
    .configure('http://127.0.0.1:9/hook', SECRET);

  const logLines = [];
  const whOther = createWebhooks(db, {
    fetchImpl: fetchOk, secretKey: OTHER_KEY, log: (m) => logLines.push(String(m)),
  });
  const delivered = await whOther.emit('session.started', {});
  assert.equal(delivered, false, 'чужим ключом шифротекст не расшифровывается');
  assert.equal(calls, 0, 'POST с невозможной подписью не отправляется');
  assert.ok(logLines.some((m) => m.includes('ENOT_SECRET_KEY')), 'в журнале подсказка про ключ');
  assert.ok(!logLines.join('\n').includes(SECRET), 'секрета в журнале нет');

  // ротация ключа: владелец переконфигурирует — доставка восстанавливается
  assert.equal(whOther.configure('http://127.0.0.1:9/hook', SECRET).ok, true);
  assert.equal(await whOther.emit('session.started', {}), true);
  assert.equal(calls, 1);
  db.close();
});

test('настройка без ENOT_SECRET_KEY: configure отказывает (bad_key) с подсказкой про .env', () => {
  const db = openDb(':memory:');
  const logLines = [];
  const wh = createWebhooks(db, { secretKey: '', log: (m) => logLines.push(String(m)) });

  const refused = wh.configure('http://example.com/hook', SECRET);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'bad_key');
  assert.ok(refused.hint.includes('ENOT_SECRET_KEY'), 'подсказка называет переменную');
  assert.ok(refused.hint.includes('.env'), 'подсказка говорит, где её задать');
  assert.ok(logLines.some((m) => m.includes('ENOT_SECRET_KEY')), 'отказ журналируется с подсказкой');
  assert.equal(db.prepare('SELECT count(*) c FROM webhook_settings').get().c, 0, 'ничего не сохранено');

  // выключение не требует ключа и всегда работает
  assert.equal(wh.configure('', '').ok, true);
  db.close();
});

test('секрет не попадает в журнал доставки и в наружное состояние', async () => {
  const db = openDb(':memory:');
  const captured = [];
  const orig = console.error;
  console.error = (...a) => captured.push(a.map(String).join(' '));
  try {
    const wh = createWebhooks(db, { fetchImpl: async () => ({ ok: false }), retryDelays: [1, 1, 1], secretKey: TEST_KEY });
    wh.configure('http://127.0.0.1:9/hook', SECRET);
    await wh.emit('session.started', {});
  } finally {
    console.error = orig;
  }
  const logText = captured.join('\n');
  assert.ok(logText.length > 0, 'неудачная доставка журналируется');
  assert.ok(!logText.includes(SECRET), 'секрета нет в журнале');
  assert.ok(!logText.includes('127.0.0.1:9'), 'URL доставки тоже не журналируется');

  const wh2 = createWebhooks(db, { secretKey: TEST_KEY });
  wh2.configure('http://127.0.0.1:9/hook', SECRET);
  const state = wh2.get();
  assert.equal(state.configured, true);
  assert.equal(state.url, 'http://127.0.0.1:9/hook');
  assert.equal(state.secret, '********', 'секрет маскирован');
  assert.ok(!JSON.stringify(state).includes(SECRET));
  db.close();
});

// ---- маршруты /settings/webhooks и emit-точки app.mjs (шов createServer) ----

async function setup(t, extra = {}) {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath, secretKey: TEST_KEY, ...extra });
  const admin = await adminLogin(dbPath, base);
  return { base, port, admin };
}

async function makeUser(base, admin, role, login) {
  const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role } });
  const password = `Пароль-${role}-123`;
  await api(base, 'POST', '/invites/accept', { body: { token: inv.json.token, login, name: `Тест ${role}`, password } });
  const res = await api(base, 'POST', '/auth/login', { body: { login, password } });
  return res.json;
}

// локальный приёмник webhooks: наружу не ходим, только 127.0.0.1
async function startReceiver(t) {
  const received = [];
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ raw: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => receiver.close());
  return { received, url: `http://127.0.0.1:${receiver.address().port}/hook` };
}

async function waitFor(received, n, ms = 3000) {
  const start = Date.now();
  while (received.length < n && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(received.length >= n, `дождались ${received.length} из ${n} webhook-ов`);
}

function verifySignature(secret, item) {
  const expected = crypto.createHmac('sha256', secret).update(item.raw, 'utf8').digest('hex');
  assert.equal(item.headers['x-enot-signature'], expected, 'подпись тела сходится на приёмнике');
  return JSON.parse(item.raw);
}

test('RBAC: /settings/webhooks — чтение и запись только админ', async (t) => {
  const { base, admin } = await setup(t);
  const operator = await makeUser(base, admin, 'operator', 'op-wh');
  const auditor = await makeUser(base, admin, 'auditor', 'aud-wh');
  const hook = await startReceiver(t);

  assert.equal((await api(base, 'GET', '/settings/webhooks')).status, 401, 'анониму нельзя');
  assert.equal((await api(base, 'POST', '/settings/webhooks', { body: { url: hook.url, secret: 'x'.repeat(20) } })).status, 401);
  assert.equal((await api(base, 'GET', '/settings/webhooks', { token: operator.token })).status, 403);
  assert.equal((await api(base, 'POST', '/settings/webhooks', { token: operator.token, body: { url: hook.url, secret: 'x'.repeat(20) } })).status, 403);
  assert.equal((await api(base, 'GET', '/settings/webhooks', { token: auditor.token })).status, 403, 'аудитор — только чтение своих зон');

  const set = await api(base, 'POST', '/settings/webhooks', {
    token: admin.token, body: { url: hook.url, secret: SECRET },
  });
  assert.equal(set.status, 200);
  assert.equal(set.json.configured, true);
  assert.equal(set.json.secret, '********', 'секрет в ответе маскирован');
  assert.ok(!JSON.stringify(set.json).includes(SECRET), 'настоящего секрета в ответе нет');

  const got = await api(base, 'GET', '/settings/webhooks', { token: admin.token });
  assert.equal(got.status, 200);
  assert.equal(got.json.url, hook.url);
  assert.deepEqual(got.json.events, [], 'пустой список — все события');
  assert.ok(!JSON.stringify(got.json).includes(SECRET));

  // валидация: не-http URL и пустой секрет — 400
  assert.equal((await api(base, 'POST', '/settings/webhooks', { token: admin.token, body: { url: 'ftp://x', secret: 's' } })).status, 400);
  assert.equal((await api(base, 'POST', '/settings/webhooks', { token: admin.token, body: { url: hook.url, secret: '' } })).status, 400);

  // выключение пустым url
  const off = await api(base, 'POST', '/settings/webhooks', { token: admin.token, body: { url: '' } });
  assert.equal(off.status, 200);
  assert.equal(off.json.configured, false);
});

test('события: session.started, session.ended и machine.claim.denied приходят с подписью', async (t) => {
  const { base, admin } = await setup(t);
  const operator = await makeUser(base, admin, 'operator', 'op-events');
  const hook = await startReceiver(t);

  const set = await api(base, 'POST', '/settings/webhooks', {
    token: admin.token, body: { url: hook.url, secret: SECRET },
  });
  assert.equal(set.status, 200);

  // attended: регистрация сеанса → claim оператором → согласие клиента (host)
  const created = await api(base, 'POST', '/sessions', { body: {} });
  assert.equal(created.status, 201);
  const { sessionId, password, hostToken } = created.json;
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, {
    token: operator.token, body: { password },
  });
  assert.equal(claim.status, 201);
  const decision = await api(base, 'POST', `/sessions/${sessionId}/decision`, {
    token: hostToken, body: { claimId: claim.json.claimId, allow: true },
  });
  assert.equal(decision.status, 200);

  await waitFor(hook.received, 1);
  const started = verifySignature(SECRET, hook.received[0]);
  assert.equal(started.event, 'session.started');
  assert.equal(started.payload.sessionId, sessionId);
  assert.ok(started.ts, 'в теле есть метка времени');

  // завершение сеанса хостом
  const end = await api(base, 'POST', `/sessions/${sessionId}/end`, { token: hostToken });
  assert.equal(end.status, 200);
  await waitFor(hook.received, 2);
  const ended = verifySignature(SECRET, hook.received[1]);
  assert.equal(ended.event, 'session.ended');
  assert.equal(ended.payload.sessionId, sessionId);
  assert.equal(ended.payload.reason, 'ended');

  // unattended: машина без причины — отказ политики → machine.claim.denied
  const machineCreated = await api(base, 'POST', '/machines', { token: admin.token, body: { name: 'Касса-1' } });
  assert.equal(machineCreated.status, 201);
  const reg = await api(base, 'POST', '/agent/register', {
    body: { code: machineCreated.json.code, name: 'kassa-1.local', os: 'linux', version: '0.9.0' },
  });
  assert.equal(reg.status, 201);
  const denied = await api(base, 'POST', `/machines/${machineCreated.json.machine.id}/claim`, {
    token: operator.token, body: {},
  });
  assert.equal(denied.status, 400);
  assert.equal(denied.json.error.code, 'reason_required');

  await waitFor(hook.received, 3);
  const claimDenied = verifySignature(SECRET, hook.received[2]);
  assert.equal(claimDenied.event, 'machine.claim.denied');
  assert.equal(claimDenied.payload.machineId, machineCreated.json.machine.id);
  assert.equal(claimDenied.payload.operatorId, operator.user.id);
});

test('фильтр на живом сервере: разрешено только session.started — ended не приходит', async (t) => {
  const { base, admin } = await setup(t);
  const operator = await makeUser(base, admin, 'operator', 'op-filter');
  const hook = await startReceiver(t);

  await api(base, 'POST', '/settings/webhooks', {
    token: admin.token, body: { url: hook.url, secret: SECRET, events: ['session.started'] },
  });

  const created = await api(base, 'POST', '/sessions', { body: {} });
  const { sessionId, password, hostToken } = created.json;
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: operator.token, body: { password } });
  assert.equal(claim.status, 201);
  const decision = await api(base, 'POST', `/sessions/${sessionId}/decision`, {
    token: hostToken, body: { claimId: claim.json.claimId, allow: true },
  });
  assert.equal(decision.status, 200);
  await waitFor(hook.received, 1);
  const started = verifySignature(SECRET, hook.received[0]);
  assert.equal(started.event, 'session.started');

  await api(base, 'POST', `/sessions/${sessionId}/end`, { token: hostToken });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hook.received.length, 1, 'session.ended отфильтрован и не доставлен');
});

test('на живом сервере без ENOT_SECRET_KEY: настройка webhooks отказывает с bad_key', async (t) => {
  const dbPath = tmpDb(t);
  const { base, admin } = await startServer(t, { dbPath, secretKey: '' }).then(async (s) => ({ ...s, admin: await adminLogin(dbPath, s.base) }));

  const refused = await api(base, 'POST', '/settings/webhooks', {
    token: admin.token, body: { url: 'http://127.0.0.1:9/hook', secret: 'x'.repeat(20) },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, 'bad_key');
  assert.ok(refused.json.error.message.includes('ENOT_SECRET_KEY'), 'подсказка доезжает до HTTP-ответа');
  assert.ok(refused.json.error.message.includes('.env'));
});
