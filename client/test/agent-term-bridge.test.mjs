// Репро живой приёмки C+D (Соня, 16.10): терминал machine-сеанса не открывается
// на win10/linux агентах 0.6.20-pre.1 — DC term открывается, {opened} не приходит.
// Здесь собрана ЦЕЛАЯ цепочка волны C без Electron: настоящий createAgent
// (slots/wireBridgeChannel) + настоящий createBridgeRelay (op-адресация
// BRIDGE_IPC) + настоящий createTermHost (фейковая оболочка) и ФЕЙК-МОСТ,
// повторяющий контракт страницы client/agent-bridge/bridge.mjs: OFFER(op) →
// ANSWER(op) → DC_OPEN(op,'term') → данные канала; ждём {opened} оператору
// (исходящий DC_TO(op,'term')). Никаких подмен звеньев релея — регрессия
// любого из них обязана падать здесь (relay-тесты гоняют их изолированно и
// гонку agent↔relay не видели).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgent } from '../lib/agent.mjs';
import { createBridgeRelay, BRIDGE_IPC } from '../agent-bridge/relay.mjs';
import { createTermHost } from '../lib/term.mjs';
import { validateOutgoingSignal } from '../lib/protocol.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function memoryStore() {
  let t = null;
  return { load: () => t, save: (v) => { t = v; }, clear: () => { t = null; } };
}

// Фейк api-цикла агента: сеанс всегда жив (pending-consent), остальное — ок.
function fakeApi() {
  return {
    async register() { return { status: 201, body: { machineId: 'm-1', token: 'tok-123' } }; },
    async session() { return { status: 200, body: { sessionId: 55, state: 'pending-consent', claimId: 'cl-1' } }; },
    async heartbeat() { return { status: 200, body: { ok: true } }; },
    async decision() { return { status: 200, body: { ok: true } }; },
  };
}

// Фейк сигнального клиента (шаблон agent.test.mjs): emit() толкает сообщения,
// исходящие сигналы — через настоящий валидатор.
function fakeSignalClient() {
  const c = {
    listeners: new Set(),
    sentSignals: [],
    closed: false,
    onMessage(cb) { c.listeners.add(cb); return () => c.listeners.delete(cb); },
    heartbeat() {},
    close() { c.closed = true; },
    emit(msg) { for (const cb of [...c.listeners]) cb(msg); },
    sendSignal(msg) {
      const v = validateOutgoingSignal(msg);
      if (!v.ok) throw new Error(`invalid outgoing signal (${v.reason})`);
      c.sentSignals.push(msg);
    },
    open() {
      const ready = { type: 'ready', role: 'host', sessionId: 55, state: 'pending-consent' };
      c.emit(ready);
      return Promise.resolve(ready);
    },
  };
  return c;
}

// Фейк-мост: повторяет поведение страницы bridge.mjs по контракту BRIDGE_IPC.
// toMain — «ipc-посылка из окна» (идёт в relay.handleMessage), fromMain — всё,
// что main отправил мосту (записывается для ассертов).
function fakeBridge(relay) {
  const fromMain = [];
  const b = {
    fromMain,
    toMain: (channel, payload) => relay.handleMessage(channel, payload),
    // оператор открыл канал: DC_OPEN(op,label) — как ch.onopen страницы моста
    openChannel: (op, label) => b.toMain(BRIDGE_IPC.DC_OPEN, { op, label }),
    // оператор послал данные: DC_FROM(op,label,data)
    sendFrom: (op, label, data) => b.toMain(BRIDGE_IPC.DC_FROM, { op, label, data }),
    closeChannel: (op, label) => b.toMain(BRIDGE_IPC.DC_CLOSED, { op, label }),
    // то, что мост получил для оператора (DC_TO без close)
    received: (label) => fromMain
      .filter(([ch, p]) => ch === BRIDGE_IPC.DC_TO && p && !p.close && p.label === label)
      .map(([, p]) => p),
  };
  return b;
}

// Фейковая оболочка терминала (spawn инъекцией createTermHost): пишем/читаем
// без процессов, контекст — честная пометка.
function fakeTermHost() {
  const written = [];
  const outputs = [];
  let exitCb = null;
  const term = {
    write(data) { written.push(data); return true; },
    onData(cb) { outputs.push(cb); },
    onExit(cb) { exitCb = cb; },
    resize() { return true; },
    kill() { return true; },
    buffer() { return ''; },
    size: () => ({ cols: 80, rows: 24 }),
    isAlive: () => true,
  };
  const host = createTermHost({
    platform: 'test',
    spawnShellFor: () => ({ file: 'fakesh', args: [], context: 'FAKE-CTX' }),
    createTerm: () => term,
  });
  return { host, written, emitOutput: (data) => { for (const cb of outputs) cb(data); }, emitExit: (info) => exitCb?.(info) };
}

const inertNative = {
  load() {},
  end() {},
  status: () => ({ available: false, platform: 'test', reason: 'inert', checked: true }),
};

// Полный сценарий: offer(op) → answer → DC_OPEN term → {opened} оператору.
// Возвращает окружение для доп-проверок (term-busy, ввод, выход).
async function makeMachineSession() {
  const store = memoryStore();
  store.save('tok-term');
  const sig = fakeSignalClient();
  const { host: termHost, written, emitOutput } = fakeTermHost();

  let relay = null;
  const bridgeOf = () => fakeBridge(relay);
  let bridge = null;
  const rtcFactory = () => {
    relay = createBridgeRelay({
      send: (channel, payload) => bridge?.fromMainPush(channel, payload),
      log: { warn() {} },
    });
    relay.markReady(); // страница «загрузилась» сразу
    bridge = bridgeOf();
    bridge.fromMainPush = (channel, payload) => {
      bridge.fromMain.push([channel, payload]);
      // фейк-мост отвечает на offer моста — как answerChain страницы
      if (channel === BRIDGE_IPC.OFFER) {
        const op = typeof payload === 'string' ? 'primary' : payload?.op;
        queueMicrotask(() => bridge.toMain(BRIDGE_IPC.ANSWER, { op, sdp: `v=0-answer-${op}` }));
      }
    };
    return relay; // main.mjs волны C отдаёт агенту сам relay (getPcLike/closeOp)
  };

  const agent = createAgent({
    api: fakeApi(),
    signal: () => sig,
    native: inertNative,
    policy: { name: 'mk-term', os: 'test', version: '9.9', tokenStore: store, heartbeatMs: 5, backoffBaseMs: 10, backoffMaxMs: 40 },
    termHost,
    rtc: rtcFactory,
  });
  await agent.start({});
  await sleep(30); // опрос сеанса → сигналинг открыт
  assert.equal(sig.closed, false, 'сигналинг жив');
  sig.emit({ type: 'approved' }); // агент поднимает rtcObj (мост волны C)
  await sleep(5);
  return {
    agent, sig, bridge,
    openOperator: async (op) => {
      sig.emit({ type: 'signal', from: op, data: { description: { type: 'offer', sdp: `v=0-offer-${op}` } } });
      await sleep(15); // offer → relay → фейк-мост → answer → сигнал оператору
    },
    teardown: async () => { agent.stop(); await sleep(10); },
    written, emitOutput,
  };
}

test('РЕПРО C+D: machine-сеанс — OFFER(op) → DC_OPEN(op,term) → оператор получает {opened}', async () => {
  const env = await makeMachineSession();
  try {
    await env.openOperator('cl-op1');
    // answer адресован оператору (to=op) и ушёл в конверте
    const answer = env.sig.sentSignals.find((m) => m.type === 'signal' && m.data?.description?.type === 'answer');
    assert.ok(answer, 'answer ушёл оператору');
    assert.equal(answer.to, 'cl-op1', 'answer адресован to=claimId (W-C1)');

    // операторский канал term открыт (страница моста шлёт DC_OPEN в onopen)
    env.bridge.openChannel('cl-op1', 'term');
    await sleep(10);

    const toTerm = env.bridge.received('term');
    const opened = toTerm.find((p) => { try { return JSON.parse(p.data).type === 'opened'; } catch { return false; } });
    assert.ok(opened, `{opened} дошёл до оператора: ${JSON.stringify(toTerm)}`);
    assert.equal(JSON.parse(opened.data).context, 'FAKE-CTX', 'контекст оболочки честный');
    assert.equal(opened.op, 'cl-op1', 'DC_TO адресован op оператора');
  } finally {
    await env.teardown();
  }
});

test('РЕПРО C+D: ввод оператора по каналу term доходит до оболочки, вывод — оператору', async () => {
  const env = await makeMachineSession();
  try {
    await env.openOperator('cl-op1');
    env.bridge.openChannel('cl-op1', 'term');
    await sleep(10);
    env.bridge.sendFrom('cl-op1', 'term', JSON.stringify({ type: 'in', data: 'echo hi\n' }));
    await sleep(10);
    assert.deepEqual(env.written, ['echo hi\n'], 'ввод оператора дошел до оболочки');
    env.emitOutput('hi\r\n');
    await sleep(10);
    const outs = env.bridge.received('term').filter((p) => { try { return JSON.parse(p.data).type === 'out'; } catch { return false; } });
    assert.deepEqual(outs.map((p) => JSON.parse(p.data).data), ['hi\r\n'], 'вывод оболочки релеится оператору');
  } finally {
    await env.teardown();
  }
});

test('РЕПРО C+D: второй term-канал (другой оператор) получает честный term-busy', async () => {
  const env = await makeMachineSession();
  try {
    await env.openOperator('cl-op1');
    await env.openOperator('cl-op2');
    env.bridge.openChannel('cl-op1', 'term');
    await sleep(10);
    assert.ok(env.bridge.received('term').some((p) => { try { return JSON.parse(p.data).type === 'opened'; } catch { return false; } }),
      'первый терминал открылся');
    // второй оператор (или повторное открытие) — лимит 1 терминал на машину
    env.bridge.openChannel('cl-op2', 'term');
    await sleep(10);
    const busy = env.bridge.received('term').find((p) => { try { return JSON.parse(p.data).code === 'term-busy'; } catch { return false; } });
    assert.ok(busy, 'второй канал получил {error,term-busy}');
    assert.equal(busy.op, 'cl-op2', 'отказ адресован второму оператору');
  } finally {
    await env.teardown();
  }
});

test('РЕПРО C+D (P3-1): оператору при открытии input-канала сливается начальный грант', async () => {
  const env = await makeMachineSession();
  try {
    await env.openOperator('cl-op1');
    // честная гонка live-сеанса: operator-joined приходит по WS раньше, чем
    // ICE откроет каналы — arbiter.attach уже учёл оператора и молчит при
    // проводке канала; без явного слива гранта оператор не знал бы статус
    env.sig.emit({ type: 'operator-joined', claimId: 'cl-op1', operator: { id: 'u1', name: 'Оператор 1' } });
    env.bridge.openChannel('cl-op1', 'input');
    await sleep(10);
    const grants1 = env.bridge.received('input').map((p) => JSON.parse(p.data)).filter((m) => m.type === 'input-grant');
    assert.ok(grants1.length >= 1, 'начальный input-grant ушёл при открытии канала');
    assert.equal(grants1.at(-1).granted, true, 'одинокий оператор — ввод его');

    await env.openOperator('cl-op2');
    env.sig.emit({ type: 'operator-joined', claimId: 'cl-op2', operator: { id: 'u2', name: 'Оператор 2' } });
    env.bridge.openChannel('cl-op2', 'input');
    await sleep(10);
    const grants2 = env.bridge.received('input')
      .filter((p) => p.op === 'cl-op2')
      .map((p) => JSON.parse(p.data))
      .filter((m) => m.type === 'input-grant');
    assert.ok(grants2.length >= 1, 'второму оператору тоже сливается состояние');
    assert.equal(grants2.at(-1).granted, false, 'второй оператор честно видит «только просмотр»');
  } finally {
    await env.teardown();
  }
});

// ---- РЕАЛЬНАЯ страница моста: bridge.mjs с фейковыми window/RTCPeerConnection ----
// Фейк-мост выше повторял контракт страницы руками; здесь исполняется НАСТОЯЩИЙ
// bridge.mjs (единственное звено цепочки, которое юнитами не покрывалось).
// Фейковый RTCPeerConnection объявляет каналы из «sdp» оффера (метки в строке),
// открывает их после setLocalDescription(answer) — порядок событий живого
// WebRTC: ondatachannel при применении оффера, onopen после соединения.

function makeFakeDc(sentLog) {
  const ch = {
    label: '',
    binaryType: 'blob',
    readyState: 'connecting',
    onopen: null,
    onmessage: null,
    onclose: null,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onbufferedamountlow: null,
    send(data) { sentLog.push({ label: ch.label, data }); ch.bufferedAmount += data.length ?? 0; },
    close() {
      if (ch.readyState === 'closed') return;
      ch.readyState = 'closed';
      ch.onclose?.();
    },
  };
  return ch;
}

async function loadRealBridgePage(relay) {
  // операторская сторона: каналы, «пришедшие» из оффера, и всё, что мост в них отправил
  const operatorChannels = [];
  const sentToOperator = [];
  class FakePc {
    constructor() {
      this.onicecandidate = null;
      this.ondatachannel = null;
      this.onconnectionstatechange = null;
      this.connectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this._pending = [];
    }
    async setRemoteDescription(d) {
      this.remoteDescription = d;
      if (d.type === 'offer') {
        // «sdp» фейка несёт метки каналов оператора: v=0 labels=term,chat,file,input
        const labels = (d.sdp.match(/labels=([a-z,]+)/)?.[1] ?? '').split(',').filter(Boolean);
        for (const label of labels) {
          const ch = makeFakeDc(sentToOperator);
          ch.label = label;
          operatorChannels.push(ch);
          this._pending.push({ ch });
          queueMicrotask(() => this.ondatachannel?.({ channel: ch }));
        }
      }
    }
    async createAnswer() { return { type: 'answer', sdp: 'v=0-fake-answer' }; }
    async setLocalDescription(a) {
      this.localDescription = a;
      // ICE «соединился»: каналы открываются (обе стороны получают onopen)
      queueMicrotask(() => {
        this.connectionState = 'connected';
        for (const { ch } of this._pending) {
          ch.readyState = 'open';
          ch.onopen?.();
        }
      });
    }
    getTransceivers() { return []; } // term-only сценарий: видеотрансивера нет
    async addIceCandidate() {}
    close() {
      this.connectionState = 'closed';
      for (const { ch } of this._pending) ch.close();
    }
  }
  globalThis.RTCPeerConnection = FakePc;

  // preload-контракт: подписки main→мост и посылки мост→main (литералы preload.cjs)
  const subs = {};
  const api = {
    onOffer: (cb) => { subs[BRIDGE_IPC.OFFER] = cb; },
    onIce: (cb) => { subs[BRIDGE_IPC.ICE] = cb; },
    onIceConfig: (cb) => { subs[BRIDGE_IPC.ICE_CONFIG] = cb; },
    onToDc: (cb) => { subs[BRIDGE_IPC.DC_TO] = cb; },
    onVideoFrame: () => {},
    onVideoMode: () => {},
    sendAnswer: (sdp, op) => relay.handleMessage(BRIDGE_IPC.ANSWER, op ? { op, sdp } : sdp),
    gdmStatus: () => {},
    sendIce: (candidate, op) => relay.handleMessage(BRIDGE_IPC.ICE, op ? { op, candidate } : candidate),
    dcOpened: (label, op) => relay.handleMessage(BRIDGE_IPC.DC_OPEN, op ? { op, label } : label),
    dcFrom: (label, data, op) => relay.handleMessage(BRIDGE_IPC.DC_FROM, { op: op || 'primary', label, data }),
    dcClosed: (label, op) => relay.handleMessage(BRIDGE_IPC.DC_CLOSED, op ? { op, label } : label),
    pause: (op) => relay.handleMessage(BRIDGE_IPC.PAUSE, op || 'primary'),
    resume: (op) => relay.handleMessage(BRIDGE_IPC.RESUME, op || 'primary'),
    fail: (message) => relay.handleMessage(BRIDGE_IPC.FAIL, message),
  };
  globalThis.window = { agentRtc: api };

  const bridgeUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-bridge', 'bridge.mjs'));
  bridgeUrl.search = `?repro=${Date.now()}-${Math.random().toString(36).slice(2)}`; // свежий экземпляр на тест
  await import(bridgeUrl.href);

  return {
    operatorChannels,
    sentToOperator,
    // main → мост (webContents.send): раздаём подписчикам preload
    deliver: (channel, payload) => {
      const cb = subs[channel];
      if (cb) cb(payload);
    },
  };
}

test('РЕПРО C+D: НАСТОЯЩИЙ bridge.mjs — offer(op) → каналы оператора → {opened} доезжает оператору', async () => {
  const store = memoryStore();
  store.save('tok-real-bridge');
  const sig = fakeSignalClient();
  const { host: termHost } = fakeTermHost();
  let page = null;
  const relay = createBridgeRelay({
    send: (channel, payload) => page?.deliver(channel, payload),
    log: { warn() {} },
  });
  relay.markReady();
  page = await loadRealBridgePage(relay);
  const agent = createAgent({
    api: fakeApi(),
    signal: () => sig,
    native: inertNative,
    policy: { name: 'mk-rb', os: 'test', version: '9.9', tokenStore: store, heartbeatMs: 5, backoffBaseMs: 10, backoffMaxMs: 40 },
    termHost,
    rtc: () => relay,
  });
  try {
    await agent.start({});
    await sleep(30);
    sig.emit({ type: 'approved' });
    // оффер оператора с каналом term (метки зашиты в фейковый sdp)
    sig.emit({ type: 'signal', from: 'cl-op9', data: { description: { type: 'offer', sdp: 'v=0 labels=term' } } });
    await sleep(40);

    const answer = sig.sentSignals.find((m) => m.type === 'signal' && m.data?.description?.type === 'answer');
    assert.ok(answer, 'агент ответил на offer (через настоящий bridge.mjs)');

    const termSent = page.sentToOperator.filter((s) => s.label === 'term');
    const opened = termSent.find((s) => { try { return JSON.parse(s.data).type === 'opened'; } catch { return false; } });
    assert.ok(opened, `{opened} дошёл до оператора через настоящий bridge.mjs: ${JSON.stringify(termSent)}`);
    assert.equal(JSON.parse(opened.data).context, 'FAKE-CTX');
  } finally {
    agent.stop();
    await sleep(10);
    delete globalThis.window;
    delete globalThis.RTCPeerConnection;
  }
});
