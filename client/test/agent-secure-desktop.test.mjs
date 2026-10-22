// P2-8 (ревью 22.10): хост машины считает ввод оператора на защищённый
// рабочий стол (экран входа и блокировки, UAC — по статусу хелпера) и
// отдаёт счётчик серверу heartbeat'ом; signal пропускает только allowlist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../lib/agent.mjs';
import { createSignalClient } from '../lib/signal.mjs';

function fakePc() {
  const pc = {
    ondatachannel: null, onicecandidate: null,
    async setRemoteDescription() {}, async createAnswer() { return { type: 'answer', sdp: 'v=0' }; },
    async setLocalDescription() {}, async addIceCandidate() {}, close() {},
  };
  return pc;
}

function fakeChannel(label) {
  const ch = {
    label, readyState: 'open', sent: [], onmessage: null, onopen: null, onclose: null,
    send(m) { ch.sent.push(m); }, close() {},
    recv(obj) { ch.onmessage?.({ data: JSON.stringify(obj) }); },
  };
  return ch;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('агент: ввод на экран входа/UAC считается и уходит в heartbeat; на обычном столе — нет', async () => {
  const heartbeats = [];
  let handler = null;
  const signalClient = {
    onMessage(cb) { handler = cb; return () => { handler = null; }; },
    async open() { return { type: 'ready', role: 'host', sessionId: 779, state: 'waiting' }; },
    heartbeat(extra) { heartbeats.push(extra); },
    sendSignal() {}, sendMachineVideo() {}, close() {},
  };
  const api = {
    register: async () => ({ status: 201, body: { token: 't', machineId: 'm' } }),
    session: async () => ({ status: 200, body: { sessionId: 779, state: 'pending-consent' } }),
    heartbeat: async () => ({ status: 200, body: {} }),
    decision: async () => ({ status: 200, body: {} }),
  };
  let statusCb = null;
  const delivered = [];
  const video = {
    bind() {}, start() {}, stop() {},
    onStatus(cb) { statusCb = cb; },
    handleInputChannel(ch) { ch.onmessage = (m) => delivered.push(JSON.parse(m.data)); },
  };
  const pcs = [];
  const agent = createAgent({
    api,
    signal: () => signalClient,
    native: { load() {}, end() {}, status: () => ({}) },
    policy: { name: 'm', os: 'win32', version: '1', heartbeatMs: 10 },
    video,
    termHost: { isActive: () => false, handleChannel() {}, close() {} }, // мост поднимается только с терминалом
    rtc: () => { const pc = fakePc(); pcs.push(pc); return pc; },
  });
  agent.start({ code: 'ONBOARD' });
  try {
    await tick(30);
    handler({ type: 'claim', claimId: 'c1' });
    handler({ type: 'approved' });
    handler({ type: 'signal', data: { description: { type: 'offer', sdp: 'v=0' } } });
    await tick(5);
    const input = fakeChannel('input');
    pcs[0].ondatachannel({ channel: input });
    // обычный стол: ввод идёт хелперу, но не считается
    input.recv({ type: 'key', key: 'a', down: true });
    statusCb({ state: 'running', helper: { state: 'running', locked: true, uac: false } });
    await tick(25); // хотя бы один heartbeat на экране входа
    input.recv({ type: 'move', x: 0.5, y: 0.5 }); // движение мыши — не жест
    input.recv({ type: 'button', button: 'left', down: true });
    input.recv({ type: 'key', key: 'Enter', down: true });
    statusCb({ state: 'running', helper: { state: 'running', locked: false, uac: true } }); // UAC
    input.recv({ type: 'scroll', dy: 1 });
    statusCb({ state: 'running', helper: { state: 'running', locked: false, uac: false } });
    input.recv({ type: 'key', key: 'b', down: true });
    statusCb({ state: 'running', helper: { state: 'running' } }); // без полей — состояние не меняется
    await tick(25);
    assert.ok(delivered.length >= 6, 'ввод доходит хелперу как раньше');
    const last = heartbeats.at(-1);
    assert.equal(last.secureDesktop, false);
    assert.equal(last.secureInputs, 3);
    assert.ok(heartbeats.some((h) => h.secureDesktop === true), 'экран входа виден в heartbeat');
  } finally {
    agent.stop();
    await tick(5);
  }
});

test('signal.heartbeat: secureDesktop/secureInputs — только правильных типов', async () => {
  const sent = [];
  const handlers = {};
  const fakeWs = {
    readyState: 1,
    on(ev, cb) { handlers[ev] = cb; if (ev === 'open') queueMicrotask(cb); },
    send(m) {
      const msg = JSON.parse(m);
      sent.push(msg);
      if (msg.type === 'auth') queueMicrotask(() => handlers.message(Buffer.from(JSON.stringify({ type: 'ready' }))));
    },
    close() {},
  };
  const client = createSignalClient({ url: 'ws://x', wsFactory: () => fakeWs });
  await client.open({ role: 'host', sessionId: 1, token: 't' });
  client.heartbeat({ termActive: false, secureDesktop: true, secureInputs: 4, extra: 'нет' });
  client.heartbeat({ secureDesktop: 'да', secureInputs: -1 });
  client.heartbeat({ secureInputs: 1.5 });
  const beats = sent.filter((m) => m.type === 'heartbeat');
  assert.deepEqual(beats, [
    { type: 'heartbeat', termActive: false, secureDesktop: true, secureInputs: 4 },
    { type: 'heartbeat' },
    { type: 'heartbeat' },
  ]);
});
