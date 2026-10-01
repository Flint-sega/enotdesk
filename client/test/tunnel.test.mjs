// Туннель (ADR 0028, v0.6 каркас): parseTunnelTarget/targetAllowed — allowlist,
// createTunnelHost — DC-протокол (control JSON / binary data), насос binary ↔
// сокет, лимиты (1 туннель на канал, maxTunnels на host) и честные отказы.
// Реальные TCP-соединения не тестируются автоматически (MANUAL-QA) — в тестах
// netFactory инъекцией и фейковые сокеты.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTunnelHost, parseTunnelTarget, targetAllowed,
  DEFAULT_TUNNEL_TARGETS, TUNNEL_MAX_CHUNK,
} from '../lib/tunnel.mjs';

// ---- фейки: DC-канал (control-строки + бинарные чанки) и net-сокет ----

function fakeChannel() {
  const ch = {
    readyState: 'open',
    sent: [],
    closed: 0,
    onopen: null, onmessage: null, onclose: null,
    send(m) { ch.sent.push(m); },
    close() { ch.closed += 1; ch.readyState = 'closed'; if (ch.onclose) ch.onclose(); },
    // control-кадр (строка JSON)
    recvCtl(obj) { if (ch.onmessage) ch.onmessage({ data: JSON.stringify(obj) }); },
    // сырой чанк: строка — как есть, бинарный — как есть
    recvRaw(data) { if (ch.onmessage) ch.onmessage({ data }); },
    open() { if (ch.onopen) ch.onopen(); },
  };
  return ch;
}

function controlFrames(ch) {
  return ch.sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m));
}

function binaryChunks(ch) {
  return ch.sent.filter((m) => typeof m !== 'string');
}

function fakeSock() {
  const sock = {
    written: [],
    destroyed: false,
    cbs: { data: [], error: [], close: [] },
    on(ev, cb) { sock.cbs[ev]?.push(cb); return sock; },
    write(d) { sock.written.push(Buffer.from(d instanceof ArrayBuffer ? new Uint8Array(d) : d)); return true; },
    destroy() {
      if (sock.destroyed) return;
      sock.destroyed = true;
      for (const cb of sock.cbs.close) cb();
    },
    emitData(buf) { for (const cb of sock.cbs.data) cb(buf); },
    emitError(err) { for (const cb of sock.cbs.error) cb(err); },
  };
  return sock;
}

// host c одним фейковым сокетом на все вызовы netFactory
function hostWithSock(sock, over = {}) {
  const calls = [];
  const host = createTunnelHost({
    netFactory: (h, p) => { calls.push([h, p]); return sock; },
    ...over,
  });
  return { host, calls };
}

// ---- allowlist: парс цели и строгая проверка ----

test('DEFAULT_TUNNEL_TARGETS — только loopback RDP/SSH', () => {
  assert.deepEqual(DEFAULT_TUNNEL_TARGETS, ['127.0.0.1:3389', '127.0.0.1:22']);
});

test('parseTunnelTarget: валидные цели и честные отказы на мусор', () => {
  assert.deepEqual(parseTunnelTarget('127.0.0.1:3389'), { host: '127.0.0.1', port: 3389 });
  assert.deepEqual(parseTunnelTarget('localhost:22'), { host: 'localhost', port: 22 });
  // мусор → null (не угадывание)
  assert.equal(parseTunnelTarget('127.0.0.1'), null); // нет порта
  assert.equal(parseTunnelTarget('127.0.0.1:'), null);
  assert.equal(parseTunnelTarget('127.0.0.1:0'), null);
  assert.equal(parseTunnelTarget('127.0.0.1:70000'), null);
  assert.equal(parseTunnelTarget('127.0.0.1:abc'), null);
  assert.equal(parseTunnelTarget('127.0.0.1:-5'), null);
  assert.equal(parseTunnelTarget('::1'), null); // IPv6-вид не поддержан в v0.6
  assert.equal(parseTunnelTarget('127.0.0.1/http'), null);
  assert.equal(parseTunnelTarget(''), null);
  assert.equal(parseTunnelTarget(null), null);
});

test('targetAllowed: элементы с портом фиксируют порт, host без порта — любой', () => {
  assert.equal(targetAllowed('127.0.0.1:3389', DEFAULT_TUNNEL_TARGETS), true);
  assert.equal(targetAllowed('127.0.0.1:22', DEFAULT_TUNNEL_TARGETS), true);
  assert.equal(targetAllowed('127.0.0.1:445', DEFAULT_TUNNEL_TARGETS), false); // порт не из списка
  assert.equal(targetAllowed('10.0.0.5:3389', DEFAULT_TUNNEL_TARGETS), false); // чужой хост
  assert.equal(targetAllowed('LOCALHOST:22', ['localhost:22']), true); // регистр hostname не важен
  assert.equal(targetAllowed('192.168.1.10:9999', ['192.168.1.10']), true); // host без порта
  assert.equal(targetAllowed('192.168.1.10:0', ['192.168.1.10']), false); // порт всё равно валиден
  // мусорная цель не проходит ни при каком списке
  assert.equal(targetAllowed('::1', ['192.168.1.10']), false);
  assert.equal(targetAllowed(undefined, DEFAULT_TUNNEL_TARGETS), false);
});

// ---- насос binary DC ↔ socket ----

test('open по allowlist → netFactory(host, port), кадр opened, насос в обе стороны', () => {
  const sock = fakeSock();
  const { host, calls } = hostWithSock(sock);
  const ch = fakeChannel();
  assert.equal(host.handleChannel(ch), true);
  assert.equal(host.activeCount, 0);
  ch.open();
  ch.recvCtl({ type: 'open', target: '127.0.0.1:3389' });
  assert.deepEqual(calls, [['127.0.0.1', 3389]]);
  assert.deepEqual(controlFrames(ch), [{ type: 'opened', target: '127.0.0.1:3389' }]);
  assert.equal(host.activeCount, 1);
  // DC → socket: бинарный чанк уходит в сокет как байты
  ch.recvRaw(new Uint8Array([1, 2, 3]));
  assert.deepEqual(sock.written.map((b) => [...b]), [[1, 2, 3]]);
  // socket → DC: бинарный чанк уходит без JSON-обёртки (тот же сплит, что в file-transfer)
  sock.emitData(Buffer.from([9, 8, 7]));
  assert.deepEqual(binaryChunks(ch).map((b) => [...b]), [[9, 8, 7]]);
});

test('target_not_allowed: отказ честный, канал жив — повторный валидный open работает', () => {
  const sock = fakeSock();
  const { host, calls } = hostWithSock(sock);
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvCtl({ type: 'open', target: '10.0.0.5:3389' }); // мимо allowlist
  assert.deepEqual(controlFrames(ch), [{ type: 'error', code: 'target_not_allowed' }]);
  assert.deepEqual(calls, []); // сокет не открывался
  assert.equal(ch.closed, 0); // канал жив — оператор исправляет target
  ch.recvCtl({ type: 'open', target: '127.0.0.1:22' });
  assert.deepEqual(calls, [['127.0.0.1', 22]]);
  assert.deepEqual(controlFrames(ch), [
    { type: 'error', code: 'target_not_allowed' },
    { type: 'opened', target: '127.0.0.1:22' },
  ]);
});

test('мусор канала игнорируется: не-JSON, неизвестный тип, binary до open', () => {
  const sock = fakeSock();
  const { host } = hostWithSock(sock);
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvRaw('not-json');
  ch.recvCtl({ type: 'zap' });
  ch.recvRaw(new Uint8Array([1])); // binary до open — тишина
  assert.deepEqual(controlFrames(ch), []);
  assert.deepEqual(sock.written, []);
  assert.equal(host.activeCount, 0);
});

// ---- лимиты ----

test('tunnel_busy: второй open в тот же канал — отказ, живой туннель не тронут', () => {
  const sock = fakeSock();
  const { host } = hostWithSock(sock);
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvCtl({ type: 'open', target: '127.0.0.1:3389' });
  assert.equal(host.activeCount, 1);
  ch.recvCtl({ type: 'open', target: '127.0.0.1:22' }); // второй в тот же канал
  assert.deepEqual(controlFrames(ch), [
    { type: 'opened', target: '127.0.0.1:3389' },
    { type: 'error', code: 'tunnel_busy' },
  ]);
  assert.equal(host.activeCount, 1); // первый туннель жив
  sock.emitData(Buffer.from([5])); // насос первого туннеля работает
  assert.equal(binaryChunks(ch).length, 1);
});

test('maxTunnels: параллельному каналу при полном наборе — busy; после сноса — слот свободен', () => {
  const sock = fakeSock();
  const { host } = hostWithSock(sock);
  const ch1 = fakeChannel();
  const ch2 = fakeChannel();
  assert.equal(host.handleChannel(ch1), true);
  assert.equal(host.handleChannel(ch2), true); // каналы приняты — туннелей ещё нет
  ch1.open();
  ch1.recvCtl({ type: 'open', target: '127.0.0.1:3389' });
  assert.equal(host.activeCount, 1);
  // ch2 опоздал: слот занят параллельным каналом между handleChannel и open
  ch2.open();
  ch2.recvCtl({ type: 'open', target: '127.0.0.1:22' });
  assert.deepEqual(controlFrames(ch2), [{ type: 'error', code: 'tunnel_busy' }]);
  // новый DC-канал при полном наборе отклоняется целиком (по образцу term)
  const ch3 = fakeChannel();
  assert.equal(host.handleChannel(ch3), false);
  assert.deepEqual(controlFrames(ch3), [{ type: 'error', code: 'tunnel_busy' }]);
  assert.ok(ch3.closed >= 1);
  // снос первого туннеля освобождает слот — ch2 открывает свой
  sock.destroy();
  assert.equal(host.activeCount, 0);
  ch2.recvCtl({ type: 'open', target: '127.0.0.1:22' });
  assert.deepEqual(controlFrames(ch2), [
    { type: 'error', code: 'tunnel_busy' },
    { type: 'opened', target: '127.0.0.1:22' },
  ]);
  assert.equal(host.activeCount, 1);
});

// ---- close-сценарии ----

test('socket close → кадр close, канал закрыт, слот свободен', () => {
  const sock = fakeSock();
  const { host } = hostWithSock(sock);
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvCtl({ type: 'open', target: '127.0.0.1:3389' });
  sock.destroy(); // RDP-сервер закрыл соединение
  assert.deepEqual(controlFrames(ch), [
    { type: 'opened', target: '127.0.0.1:3389' },
    { type: 'close' },
  ]);
  assert.ok(ch.closed >= 1);
  assert.equal(host.activeCount, 0);
});

test('socket error → честный err.code, канал закрыт, дубля close нет', () => {
  const sock = fakeSock();
  const { host } = hostWithSock(sock);
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvCtl({ type: 'open', target: '127.0.0.1:22' });
  sock.emitError({ code: 'ECONNREFUSED' }); // SSH не слушает
  assert.deepEqual(controlFrames(ch), [
    { type: 'opened', target: '127.0.0.1:22' },
    { type: 'error', code: 'ECONNREFUSED' },
  ]);
  assert.ok(ch.closed >= 1);
  assert.equal(host.activeCount, 0);
  // close-событие сокета после error не шлёт второй кадр (tunnel уже null)
  sock.destroy();
  assert.equal(controlFrames(ch).length, 2);
});

test('socket error без кода → socket_error', () => {
  const sock = fakeSock();
  const { host } = hostWithSock(sock);
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvCtl({ type: 'open', target: '127.0.0.1:3389' });
  sock.emitError(new Error('boom'));
  assert.deepEqual(controlFrames(ch), [
    { type: 'opened', target: '127.0.0.1:3389' },
    { type: 'error', code: 'socket_error' },
  ]);
  assert.equal(host.activeCount, 0);
});

test('DC close → socket.destroy, слот свободен, кадров не надо (получатель мёртв)', () => {
  const sock = fakeSock();
  const { host } = hostWithSock(sock);
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvCtl({ type: 'open', target: '127.0.0.1:3389' });
  ch.close(); // сеанс/канал умер на стороне оператора
  assert.equal(sock.destroyed, true);
  assert.equal(host.activeCount, 0);
  assert.deepEqual(controlFrames(ch), [{ type: 'opened', target: '127.0.0.1:3389' }]);
});

test('control close от оператора → socket.destroy, кадр close, канал закрыт', () => {
  const sock = fakeSock();
  const { host } = hostWithSock(sock);
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvCtl({ type: 'open', target: '127.0.0.1:3389' });
  ch.recvCtl({ type: 'close' });
  assert.equal(sock.destroyed, true);
  assert.deepEqual(controlFrames(ch), [
    { type: 'opened', target: '127.0.0.1:3389' },
    { type: 'close' },
  ]);
  assert.ok(ch.closed >= 1);
  assert.equal(host.activeCount, 0);
});

test('host.close() — завершение сеанса рвёт живой туннель', () => {
  const sock = fakeSock();
  const { host } = hostWithSock(sock);
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvCtl({ type: 'open', target: '127.0.0.1:3389' });
  host.close();
  assert.equal(sock.destroyed, true);
  assert.equal(host.activeCount, 0);
});

// ---- connect и порча протокола ----

test('connect_failed: netFactory бросил или вернул не сокет — отказ, канал жив', () => {
  const host = createTunnelHost({ netFactory: () => { throw new Error('no net'); } });
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvCtl({ type: 'open', target: '127.0.0.1:3389' });
  assert.deepEqual(controlFrames(ch), [{ type: 'error', code: 'connect_failed' }]);
  assert.equal(ch.closed, 0);

  const host2 = createTunnelHost({ netFactory: () => ({ write: 'не функция' }) });
  const ch2 = fakeChannel();
  host2.handleChannel(ch2);
  ch2.open();
  ch2.recvCtl({ type: 'open', target: '127.0.0.1:3389' });
  assert.deepEqual(controlFrames(ch2), [{ type: 'error', code: 'connect_failed' }]);
  assert.equal(host2.activeCount, 0);
});

test('чанк сокета крупнее TUNNEL_MAX_CHUNK — туннель честно рвётся, не теряет байты молча', () => {
  const sock = fakeSock();
  const { host } = hostWithSock(sock);
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvCtl({ type: 'open', target: '127.0.0.1:3389' });
  sock.emitData(Buffer.alloc(TUNNEL_MAX_CHUNK + 1));
  assert.deepEqual(controlFrames(ch), [
    { type: 'opened', target: '127.0.0.1:3389' },
    { type: 'error', code: 'chunk_too_large' },
  ]);
  assert.ok(ch.closed >= 1);
  assert.equal(host.activeCount, 0);
});

test('ArrayBuffer от DC пишется в сокет как байты (не строка-JSON)', () => {
  const sock = fakeSock();
  const { host } = hostWithSock(sock);
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.recvCtl({ type: 'open', target: '127.0.0.1:22' });
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);
  ch.recvRaw(ab);
  assert.deepEqual(sock.written.map((b) => [...b]), [[1, 2, 3, 4]]);
});
