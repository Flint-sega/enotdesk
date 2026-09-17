import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createAgent, createAgentApi, createIceServersFetcher } from '../lib/agent.mjs';
import { createNativeInput, inertAdapter } from '../lib/native-input.mjs';

// Шов §2 (interfaces.md): agent-цикл над фейк-api, фейк-сигналингом и инертным
// адаптером ввода. Никакого Electron и реальной сети: время — маленькие реальные
// интервалы, ожидания backoff — миллисекунды.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function memoryStore() {
  let t = null;
  return {
    load: () => t,
    save: (v) => { t = v; },
    clear: () => { t = null; },
  };
}

function fakeApi(script = {}) {
  const calls = { register: [], session: [], heartbeat: [], heartbeatBodies: [], decision: [] };
  return {
    calls,
    api: {
      async register(p) { calls.register.push(p); return script.register
        ? script.register(p)
        : { status: 201, body: { machineId: 'm-1', name: p.name, token: 'tok-123' } }; },
      async session(token) { calls.session.push(token); return script.session
        ? script.session(token)
        : { status: 404, body: { error: 'no_session', message: 'Активного сеанса у машины нет' } }; },
      async heartbeat(token, inventory) {
        calls.heartbeat.push(token);
        calls.heartbeatBodies.push(inventory);
        return script.heartbeat
          ? script.heartbeat(token)
          : { status: 200, body: { ok: true } };
      },
      async decision(p) { calls.decision.push(p); return script.decision
        ? script.decision(p)
        : { status: 200, body: { ok: true } }; },
    },
  };
}

// Фабрика фейк-сигнальных клиентов: open() резолвится 'ready' (или отвергается
// по сценарию), emit() толкает сообщения слушателям, close() рвёт соединение.
function fakeSignalFactory(script = {}) {
  const clients = [];
  const openAuths = [];
  const factory = () => {
    const c = {
      listeners: new Set(),
      heartbeats: 0,
      closed: false,
      onMessage(cb) { c.listeners.add(cb); return () => c.listeners.delete(cb); },
      heartbeat() { c.heartbeats += 1; },
      close() { c.closed = true; },
      emit(msg) { for (const cb of [...c.listeners]) cb(msg); },
      open(auth) {
        clients.push(c);
        openAuths.push(auth);
        if (script.open) return script.open(c, auth);
        const ready = { type: 'ready', role: 'host', sessionId: auth.sessionId, state: 'pending-consent' };
        c.emit(ready); // реальный клиент эмитит ready и резолвит им open()
        return Promise.resolve(ready);
      },
    };
    return c;
  };
  return { clients, openAuths, factory };
}

test('регистрация по коду: токен оседает в store, машина в waiting, heartbeat идёт', async () => {
  const { calls, api } = fakeApi();
  const store = memoryStore();
  const sig = fakeSignalFactory();
  const agent = createAgent({
    api,
    signal: sig.factory,
    native: createNativeInput({ adapter: inertAdapter() }),
    policy: { name: 'mk-1', os: 'test', version: '9.9', tokenStore: store, heartbeatMs: 5, backoffBaseMs: 10, backoffMaxMs: 40 },
  });
  try {
    const started = agent.start({ code: 'CODE-1' });
    assert.equal(started.ok, true);
    await sleep(40);
    assert.deepEqual(calls.register, [{ code: 'CODE-1', name: 'mk-1', os: 'test', version: '9.9' }]);
    assert.equal(store.load(), 'tok-123', 'токен машины сохранён (в main — userData)');
    const st = agent.status();
    assert.equal(st.state, 'waiting');
    assert.equal(st.machineId, 'm-1');
    assert.equal(st.hasToken, true);
    assert.ok(calls.heartbeat.length >= 1, 'машинный heartbeat отправляется');
    assert.ok(calls.heartbeat.every((t) => t === 'tok-123'));
    assert.ok(calls.session.length >= 1, 'опрос /agent/session идёт');
    assert.equal(sig.clients.length, 0, 'без сеанса сигналинг не открывается');
  } finally {
    agent.stop(); // даже при упавшем assert цикл с реальными интервалами обязан остановиться
    await sleep(10);
  }
});

test('claim: коннект host-ролью с машинным токеном, авто-allow по политике сервера, WS-heartbeat', async () => {
  // 200 → sessionId: оператор уже сделал claim, причину/PIN сервер проверил сам
  const { calls, api } = fakeApi({
    session: () => ({ status: 200, body: { sessionId: 77, state: 'pending-consent', claimId: 'cl-1', operator: { id: 'u1', name: 'Оператор' } } }),
  });
  const sig = fakeSignalFactory();
  const agent = createAgent({
    api,
    signal: sig.factory,
    native: createNativeInput({ adapter: inertAdapter() }),
    policy: { name: 'mk', os: 'test', version: '1', tokenStore: memoryStore(), heartbeatMs: 10, backoffBaseMs: 10, backoffMaxMs: 40 },
  });
  try {
    agent.start({ code: 'C1' });
    await sleep(30);
    const st = agent.status();
    assert.equal(st.state, 'online');
    assert.equal(st.session?.sessionId, 77);
    assert.deepEqual(sig.openAuths, [{ role: 'host', sessionId: 77, token: 'tok-123' }], 'host-роль аутентифицируется машинным токеном');
    assert.equal(sig.clients[0].heartbeats >= 1, true, 'WS-heartbeat продлевает lease');
    sig.clients[0].emit({ type: 'claim', claimId: 'cl-1', operator: { id: 'u1', name: 'Оператор' } });
    await sleep(20);
    assert.deepEqual(calls.decision, [{ sessionId: 77, token: 'tok-123', claimId: 'cl-1', allow: true }], 'агент подтверждает claim — политика уже проверена сервером');
    // replay approved при переподключении приходит с сервера: ворота — внутренние,
    // а честность ввода проверяет шов input-pipeline; здесь — only cycle.
  } finally {
    agent.stop();
    await sleep(10);
    assert.equal(sig.clients[0]?.closed, true, 'stop() закрывает сигнальный сокет');
  }
});

test('обрыв: зажатый ввод отпускается (end), backoff и переподключение тем же токеном', async () => {
  const nativeCalls = [];
  const nativeSpy = {
    load() { nativeCalls.push('load'); },
    end() { nativeCalls.push('end'); },
    status: () => ({ available: false, platform: 'spy', reason: 'spy', checked: true }),
  };
  const backoffs = [];
  const { api } = fakeApi({
    session: () => ({ status: 200, body: { sessionId: 77, state: 'approved', claimId: 'cl-1' } }),
  });
  const sig = fakeSignalFactory();
  const agent = createAgent({
    api,
    signal: sig.factory,
    native: nativeSpy,
    policy: { tokenStore: memoryStore(), heartbeatMs: 10, backoffBaseMs: 10, backoffMaxMs: 40, onBackoff: (ms) => backoffs.push(ms) },
  });
  try {
    agent.start({ code: 'C1' });
    await sleep(30);
    assert.equal(agent.status().state, 'online');
    sig.clients[0].emit({ type: 'approved', claimId: 'cl-1' }); // ворота ввода открыты
    await sleep(10);
    sig.clients[0].emit({ type: 'socket-closed', code: 1006, reason: 'net-drop' }); // обрыв в грейс
    await sleep(80); // backoff 10 мс + переподключение
    const st = agent.status();
    assert.equal(st.state, 'online', 'переподключились после обрыва');
    assert.deepEqual(backoffs, [10], 'одна экспоненциальная задержка 10 мс (10*2^0)');
    assert.equal(sig.openAuths.length, 2, 'повторная аутентификация');
    assert.deepEqual(sig.openAuths[1], { role: 'host', sessionId: 77, token: 'tok-123' }, 'тем же токеном машины (грейс ADR 0013)');
    assert.ok(nativeCalls.includes('end'), 'разрыв отпускает зажатый ввод');
    assert.equal(st.attempt, 0, 'успешный ready сбрасывает счётчик попыток');
  } finally {
    agent.stop();
    await sleep(10);
  }
});

test('не подключаемся вовсе: экспоненциальный backoff растёт и упирается в потолок, повторы бесконечны', async () => {
  const backoffs = [];
  const { calls, api } = fakeApi({
    session: () => ({ status: 200, body: { sessionId: 77, state: 'pending-consent', claimId: 'cl-1' } }),
  });
  const sig = fakeSignalFactory({ open: () => Promise.reject(new Error('closed 4003 invalid-session')) });
  const agent = createAgent({
    api,
    signal: sig.factory,
    native: createNativeInput({ adapter: inertAdapter() }),
    policy: { tokenStore: memoryStore(), heartbeatMs: 10, backoffBaseMs: 10, backoffMaxMs: 40, onBackoff: (ms) => backoffs.push(ms) },
  });
  try {
    agent.start({ code: 'C1' });
    await sleep(150);
    const st = agent.status();
    assert.equal(st.state, 'backoff');
    assert.deepEqual(backoffs.slice(0, 3), [10, 20, 40], '10 → 20 → 40 мс');
    assert.ok(backoffs.every((v) => v <= 40), 'потолок 40 мс не превышен');
    assert.ok(sig.openAuths.length >= 3, 'попытки не прекращаются');
    assert.ok(calls.session.length >= 4, 'poll сеанса продолжается');
  } finally {
    agent.stop();
    await sleep(10);
  }
});

test('отзыв токена: честный статус revoked, токен стёрт, повторы прекращены', async () => {
  const store = memoryStore();
  const { calls, api } = fakeApi({
    session: () => ({ status: 401, body: { error: 'unauthorized', message: 'Требуется токен машины' } }),
  });
  const agent = createAgent({
    api,
    signal: fakeSignalFactory().factory,
    native: createNativeInput({ adapter: inertAdapter() }),
    policy: { tokenStore: store, heartbeatMs: 10, backoffBaseMs: 10, backoffMaxMs: 40 },
  });
  try {
    agent.start({ code: 'C1' });
    await sleep(40);
    const st = agent.status();
    assert.equal(st.state, 'revoked');
    assert.equal(st.running, false);
    assert.equal(st.hasToken, false, 'токен не хранится после отзыва');
    assert.equal(store.load(), null, 'store очищен');
    assert.ok(typeof st.error === 'string' && st.error.includes('401'), 'в статусе честная причина');
    const seen = calls.session.length;
    await sleep(60);
    assert.equal(calls.session.length, seen, 'после отзыва сервер не долбится');
  } finally {
    agent.stop();
  }
});

test('одноразовый код отклонён: честная ошибка без долбёжки регистрации', async () => {
  const { calls, api } = fakeApi({
    register: () => ({ status: 400, body: { error: 'bad_code', message: 'Код недействителен или уже использован' } }),
  });
  const store = memoryStore();
  const agent = createAgent({
    api,
    signal: fakeSignalFactory().factory,
    native: createNativeInput({ adapter: inertAdapter() }),
    policy: { tokenStore: store, heartbeatMs: 10, backoffBaseMs: 10, backoffMaxMs: 40 },
  });
  try {
    agent.start({ code: 'USED' });
    await sleep(40);
    const st = agent.status();
    assert.equal(st.state, 'error');
    assert.equal(store.load(), null);
    assert.equal(st.hasToken, false);
    assert.equal(calls.register.length, 1, 'одноразовый код не ретраится — только честная ошибка');
  } finally {
    agent.stop();
  }
});

test('старт без кода и без сохранённого токена: честная ошибка, цикл не крутится', async () => {
  const { calls, api } = fakeApi();
  const agent = createAgent({
    api,
    signal: fakeSignalFactory().factory,
    native: createNativeInput({ adapter: inertAdapter() }),
    policy: { tokenStore: memoryStore(), heartbeatMs: 10 },
  });
  const started = agent.start({});
  assert.equal(started.ok, true);
  await sleep(30);
  const st = agent.status();
  assert.equal(st.state, 'error');
  assert.equal(st.running, false);
  assert.equal(calls.register.length, 0);
  assert.equal(calls.session.length, 0);
});

test('stop(): останавливает цикл, повторный stop честно отказывает, рестарт возможен', async () => {
  const { calls, api } = fakeApi();
  const store = memoryStore();
  const agent = createAgent({
    api,
    signal: fakeSignalFactory().factory,
    native: createNativeInput({ adapter: inertAdapter() }),
    policy: { tokenStore: store, heartbeatMs: 10, backoffBaseMs: 10, backoffMaxMs: 40 },
  });
  agent.start({ code: 'C1' });
  await sleep(25);
  assert.equal(agent.stop().ok, true);
  assert.equal(agent.status().state, 'stopped');
  assert.equal(agent.stop().ok, false, 'повторный stop — честный отказ');
  const seen = calls.session.length;
  await sleep(30);
  assert.ok(calls.session.length <= seen + 1, 'после stop опрос не продолжается');
  // рестарт: токен уже в store, код не нужен
  assert.equal(agent.start({}).ok, true);
  await sleep(25);
  assert.equal(agent.status().state, 'waiting');
  agent.stop();
  await sleep(10);
});

test('createAgentApi: пути, bearer-токен и тела запросов /agent/* и decision', async () => {
  const reqs = [];
  const fetchImpl = async (url, init) => {
    reqs.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const api = createAgentApi({ baseUrl: 'http://srv:8080/', fetchImpl });
  await api.register({ code: 'K', name: 'mk', os: 'win', version: '1.2' });
  await api.session('tok-9');
  await api.heartbeat('tok-9');
  await api.rtcConfig('tok-9');
  await api.decision({ sessionId: 77, token: 'tok-9', claimId: 'cl', allow: true });
  assert.deepEqual(reqs.map((r) => [r.method, r.url.replace('http://srv:8080', '')]), [
    ['POST', '/api/v1/agent/register'],
    ['GET', '/api/v1/agent/session'],
    ['POST', '/api/v1/agent/heartbeat'],
    ['GET', '/api/v1/rtc-config'],
    ['POST', '/api/v1/sessions/77/decision'],
  ]);
  assert.deepEqual(reqs[0].body, { code: 'K', name: 'mk', os: 'win', version: '1.2' });
  assert.equal(reqs[0].headers.Authorization, undefined, 'регистрация анонимна по коду');
  assert.equal(reqs[1].headers.Authorization, 'Bearer tok-9');
  assert.equal(reqs[3].headers.Authorization, 'Bearer tok-9', 'rtc-config — с машинным (host-)токеном');
  assert.equal(reqs[3].body, undefined, 'rtc-config — GET без тела');
  assert.deepEqual(reqs[4].body, { claimId: 'cl', allow: true });
});

test('TURN для терминала (R09): createIceServersFetcher — токен из store → iceServers; сбой — честный throw', async () => {
  const servers = [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'p' }];
  const okApi = { rtcConfig: async () => ({ status: 200, body: { iceServers: servers } }) };

  // happy path: iceServers уходят в хук релея как есть
  assert.deepEqual(await createIceServersFetcher({ api: okApi, tokenLoad: () => 'tok-1' })(), { iceServers: servers });

  // нет токена (не зарегистрирован/отозван) — честный отказ, релей деградирует в []
  await assert.rejects(
    createIceServersFetcher({ api: okApi, tokenLoad: () => null })(),
    /токена машины ещё нет/,
  );
  // не-200 (например, сеанса нет / токен чужой) — честный отказ с кодом
  await assert.rejects(
    createIceServersFetcher({ api: { rtcConfig: async () => ({ status: 401, body: null }) }, tokenLoad: () => 't' })(),
    /HTTP 401/,
  );
  // пустой список — не ошибка: нет TURN на сервере, мост честно [] с причиной
  assert.deepEqual(
    await createIceServersFetcher({ api: { rtcConfig: async () => ({ status: 200, body: { iceServers: [] } }) }, tokenLoad: () => 't' })(),
    { iceServers: [] },
  );
  // неверное тело — честный отказ, а не тихий []
  await assert.rejects(
    createIceServersFetcher({ api: { rtcConfig: async () => ({ status: 200, body: null }) }, tokenLoad: () => 't' })(),
    /неверный ответ/,
  );
  // фабрика проверяет зависимости при сборке
  assert.throws(() => createIceServersFetcher({ api: {}, tokenLoad: () => 't' }), /rtcConfig/);
  assert.throws(() => createIceServersFetcher({ api: okApi }), /tokenLoad/);
});

test('TURN для терминала (R09): зависший rtc-config не держит открытие — дедлайн даёт честный пустой список', async () => {
  // fetch навсегда завис: без дедлайна setRemoteDescription моста не отвисает —
  // offer не уходит и FAIL не приходит
  const hung = { rtcConfig: () => new Promise(() => {}) };
  const started = Date.now();
  assert.deepEqual(
    await createIceServersFetcher({ api: hung, tokenLoad: () => 'tok-1', timeoutMs: 20 })(),
    { iceServers: [], reason: 'ice-config-timeout' },
  );
  assert.ok(Date.now() - started < 5000, 'дедлайн сработал, а не ждал вечно');

  // быстрый ответ успевает раньше дедлайна — дедлайн не перебивает успех
  const fast = { rtcConfig: async () => ({ status: 200, body: { iceServers: [{ urls: ['stun:x'] }] } }) };
  assert.deepEqual(
    await createIceServersFetcher({ api: fast, tokenLoad: () => 'tok-1', timeoutMs: 5000 })(),
    { iceServers: [{ urls: ['stun:x'] }] },
  );
});

test('инвентарь (R06): getInventory уходит с машинным heartbeat; упавший сборщик цикл не рвёт', async () => {
  const { calls, api } = fakeApi();
  const store = memoryStore();
  store.save('tok-inv');
  const sig = fakeSignalFactory();
  const inventory = { os: 'linux', appVersion: '1.0', uptimeSec: 5 };
  let fail = false;
  const agent = createAgent({
    api,
    signal: sig.factory,
    native: createNativeInput({ adapter: inertAdapter() }),
    policy: {
      tokenStore: store, heartbeatMs: 5, backoffBaseMs: 10, backoffMaxMs: 40,
      getInventory: () => { if (fail) throw new Error('statfs умер'); return inventory; },
    },
  });
  try {
    assert.equal(agent.start({}).ok, true);
    await sleep(40);
    assert.ok(calls.heartbeat.length >= 1, 'машинный heartbeat отправляется');
    assert.ok(calls.heartbeatBodies.every((b) => b === inventory), 'инвентарь уходит в каждом heartbeat');

    // сборщик упал — heartbeat продолжается, но без инвентаря (честное отсутствие)
    fail = true;
    const before = calls.heartbeat.length;
    await sleep(40);
    assert.ok(calls.heartbeat.length > before, 'цикл жив после сбоя сборщика');
    assert.equal(agent.status().state, 'waiting', 'состояние не испорчено сбоем сборщика');
    assert.ok(calls.heartbeatBodies.slice(before).every((b) => b === undefined), 'упавший сборщик не подменяет инвентарь');
  } finally {
    agent.stop();
    await sleep(10);
  }
});

test('проводка TURN (R09): вся цепь — createAgentApi → createIceServersFetcher → хук релея', async () => {
  const reqs = [];
  const servers = [{ urls: ['turn:t:3478'], username: 'u', credential: 'p' }];
  const fetchImpl = async (url, init) => {
    reqs.push({ url: String(url), auth: init.headers.Authorization });
    return { status: 200, json: async () => ({ iceServers: servers }) };
  };
  const api = createAgentApi({ baseUrl: 'http://srv:8080', fetchImpl });
  const tokenStore = memoryStore();
  tokenStore.save('tok-machine');
  // токен берётся из store на момент открытия терминала, не при старте агента
  const fetchIceServers = createIceServersFetcher({ api, tokenLoad: () => tokenStore.load() });
  assert.deepEqual(await fetchIceServers(), { iceServers: servers }, 'iceServers дошли до хука createBridgeRelay');
  assert.deepEqual(reqs, [{ url: 'http://srv:8080/api/v1/rtc-config', auth: 'Bearer tok-machine' }],
    'rtc-config запрошен с машинным (host-)токеном');
  // токен отозван из store — хук честно падает, релей деградирует в []
  tokenStore.clear();
  await assert.rejects(fetchIceServers(), /токена машины ещё нет/);
});

test('проводка TURN (R09): main подключает fetchIceServers к createBridgeRelay и собирает его из tokenStore', () => {
  // createAgentRtc живёт в Electron-main (импорт невозможен) — контракт проводки
  // проверяем по тексту, как контракт-тесты рендерера и web-оператора.
  const main = readFileSync(path.join(import.meta.dirname, '..', 'main.mjs'), 'utf8');
  assert.match(main, /createBridgeRelay\(\{[\s\S]{0,400}?\bfetchIceServers\b,/,
    'createBridgeRelay вызывается с fetchIceServers — иначе ICE_CONFIG не уходит мосту');
  assert.match(main, /createAgentRtc\(\{[\s\S]{0,400}?fetchIceServers\b/);
  assert.match(main, /createIceServersFetcher\(\{[\s\S]{0,200}?tokenStore\.load\(\)/,
    'fetcher собирается с машинным токеном из tokenStore');
});
