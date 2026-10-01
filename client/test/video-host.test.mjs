// video-host (ADR 0027 v0.6): протокол pipe, жизненный цикл хелпера, деградации.
// Фейковые spawner/net/killer — без Electron и без сети.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVideoHost, createFrameReader, encodeMessage,
  FRAME_MAGIC, MSG, PIPE_NAME,
} from '../lib/video-host.mjs';

test('encodeMessage/FrameReader: фрейм проходит круг, мусор — честная EPROTO', () => {
  const payload = Buffer.from('jpeg-bytes');
  const wire = encodeMessage(MSG.FRAME, payload);
  assert.equal(wire.readUInt32LE(0), FRAME_MAGIC);
  const r = createFrameReader();
  // частичная доставка: заголовок без тела ничего не выдаёт
  assert.deepEqual(r.feed(wire.subarray(0, 4)), []);
  const msgs = r.feed(wire.subarray(4));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, MSG.FRAME);
  assert.deepEqual([...msgs[0].payload], [...payload]);
  // два сообщения в одном чанке
  const two = r.feed(Buffer.concat([encodeMessage(MSG.COMMAND, '{}'), encodeMessage(MSG.HELLO, 'tok')]));
  assert.deepEqual(two.map((m) => m.type), [MSG.COMMAND, MSG.HELLO]);
  // мусорный magic
  const garbage = Buffer.from('not-a-frame-not-at-all-long-enough');
  assert.throws(() => r.feed(garbage), (e) => e.code === 'EPROTO');
});

test('сцена спавн-отказа: честный статус, pipe не открывается', async () => {
  const frames = [];
  const statuses = [];
  const host = createVideoHost({
    spawner: { spawnInConsoleSession: async () => ({ ok: false, reason: 'no-active-session' }) },
    netFactory: () => { throw new Error('не должен вызываться'); },
    exePath: 'helper.exe', commandLine: 'helper.exe', token: 't',
    onFrame: (f) => frames.push(f), onStatus: (s) => statuses.push(s),
  });
  await host.start();
  assert.equal(host.state, 'error');
  assert.deepEqual(statuses, [{ state: 'spawning' }, { state: 'error', reason: 'spawn-no-active-session' }]);
  assert.equal(host.sendCommand({ cmd: 'wake' }), false, 'команда в неработающий хост — false, не фейк');
});

function fakeServer({ onSocket = null, delayMs = 0 } = {}) {
  const sockets = [];
  return {
    sockets,
    netFactory: () => {
      const s = {
        destroyed: false,
        written: [],
        handlers: {},
        write(b) { this.written.push(b); },
        destroy() { this.destroyed = true; this.handlers.close?.(); },
        on(ev, fn) { this.handlers[ev] = fn; },
        emit(ev, ...a) { this.handlers[ev]?.(...a); },
      };
      sockets.push(s);
      if (onSocket) onSocket(s);
      else setTimeout(() => s.emit('connect'), delayMs);
      return s;
    },
  };
}

test('happy path: hello с токеном, фреймы и статусы доходят, команды уходят', async () => {
  const frames = [];
  const statuses = [];
  const server = fakeServer();
  const host = createVideoHost({
    spawner: { spawnInConsoleSession: async () => ({ ok: true, pid: 777 }) },
    netFactory: server.netFactory,
    exePath: 'helper.exe', commandLine: 'helper.exe', token: 'tok123',
    onFrame: (f) => frames.push(f), onStatus: (s) => statuses.push(s),
  });
  await host.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(server.sockets.length, 1);
  const s = server.sockets[0];
  // hello ушёл первым байтом с токеном
  const hello = s.written[0];
  assert.equal(hello.readUInt8(4), MSG.HELLO);
  assert.equal(hello.subarray(9).toString('utf8'), 'tok123');
  assert.equal(host.state, 'running');

  // хелпер шлёт кадр + статус одним чанком
  const frame = encodeMessage(MSG.FRAME, Buffer.from([1, 2, 3]));
  const status = encodeMessage(MSG.STATUS, JSON.stringify({ fps: 24 }));
  s.emit('data', Buffer.concat([frame, status]));
  assert.deepEqual([...frames[0]], [1, 2, 3]);
  assert.deepEqual(statuses.at(-1), { state: 'running', helper: { fps: 24 } });

  // команда уходит в pipe
  assert.equal(host.sendCommand({ cmd: 'mouse', x: 0.5, y: 0.5 }), true);
  const cmd = s.written.at(-1);
  assert.equal(cmd.readUInt8(4), MSG.COMMAND);
  assert.deepEqual(JSON.parse(cmd.subarray(9).toString('utf8')), { cmd: 'mouse', x: 0.5, y: 0.5 });
  assert.equal(host.pid, 777);
});

test('пайп не поднялся за ретраи — честный error pipe-error; stop() убивает хелпера', async () => {
  const kills = [];
  const statuses = [];
  const sockets = [];
  const host = createVideoHost({
    spawner: { spawnInConsoleSession: async () => ({ ok: true, pid: 55 }) },
    netFactory: () => {
      const s = { destroyed: false, written: [], handlers: {}, write(b) { this.written.push(b); }, destroy() { this.destroyed = true; this.handlers.close?.(); }, on(ev, fn) { this.handlers[ev] = fn; }, emit(ev, ...a) { this.handlers[ev]?.(...a); } };
      sockets.push(s);
      return s;
    },
    killer: (pid) => kills.push(pid),
    exePath: 'helper.exe', commandLine: 'helper.exe', token: 't',
    onStatus: (st) => statuses.push(st),
    connectRetries: 2, connectTimeoutMs: 200,
  });
  await host.start();
  assert.equal(sockets.length, 1, 'первая попытка сразу');
  sockets[0].emit('error', new Error('refused')); // → ретрай через 400 мс
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(sockets.length, 2, 'вторая попытка после ретрая');
  sockets[1].emit('error', new Error('refused')); // ретраи исчерпаны
  await new Promise((r) => setImmediate(r));
  assert.equal(host.state, 'error');
  assert.equal(statuses.at(-1).reason, 'pipe-error');

  await host.start(); // повторный start на ошибочном хосте — no-op (не второй спавн)
  assert.equal(sockets.length, 2, 'новых попыток нет');
  host.stop();
  assert.deepEqual(kills, [55], 'хелпер убит по pid');
  assert.equal(host.state, 'off');
});

test('stop на живом хелпере сначала шлёт wake (privacy: вернуть дисплей)', async () => {
  const kills = [];
  const server = fakeServer();
  const host = createVideoHost({
    spawner: { spawnInConsoleSession: async () => ({ ok: true, pid: 9 }) },
    netFactory: server.netFactory,
    killer: (pid) => kills.push(pid),
    exePath: 'helper.exe', commandLine: 'helper.exe', token: 't',
  });
  await host.start();
  // ждём коннекта: wake уходит только через живой pipe (fakeServer коннектит
  // через setTimeout 0 — под полной сьютой он приходит позже setImmediate)
  for (let i = 0; i < 50 && host.state !== 'running'; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  host.stop();
  const last = server.sockets[0].written.at(-1);
  assert.equal(last.readUInt8(4), MSG.COMMAND, 'wake ушёл до закрытия');
  assert.deepEqual(JSON.parse(last.subarray(9).toString('utf8')), { cmd: 'wake' });
  assert.deepEqual(kills, [9]);
});

test('обрыв pipe посреди работы — статус error pipe-closed (оператору честно)', async () => {
  const statuses = [];
  const server = fakeServer();
  const host = createVideoHost({
    spawner: { spawnInConsoleSession: async () => ({ ok: true, pid: 4 }) },
    netFactory: server.netFactory,
    exePath: 'helper.exe', commandLine: 'helper.exe', token: 't',
    onStatus: (s) => statuses.push(s),
  });
  await host.start();
  // ждём фактического коннекта (fakeServer коннектит через setTimeout 0)
  for (let i = 0; i < 50 && host.state !== 'running'; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(host.state, 'running');
  server.sockets[0].emit('close');
  assert.equal(host.state, 'error');
  assert.equal(statuses.at(-1).reason, 'pipe-closed');
});

test('PIPE_NAME — формат Windows named pipe', () => {
  assert.ok(PIPE_NAME.startsWith('\\\\.\\pipe\\'));
});
